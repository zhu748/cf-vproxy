// Anthropic 协议处理器：POST /v1/messages + POST /v1/messages/count_tokens
// v1.7.0：流式路径改用 sseResponseFromGenerator —— 补齐 10s ping 保活（长思考请求不再被
//         空闲超时掐断）、客户端断开时取消上游（不再继续烧 token）、断开/异常时也记录 usage。
import { errAnthropic, json, randomId } from "../convert/common.ts";
import {
  anthropicToGemini,
  fakeStreamAnthropicEvents,
  geminiSseToAnthropicEvents,
  geminiToAnthropic,
} from "../convert/anthropic.ts";
import type { ARequest } from "../types.ts";
import { callGemini, mapUpstreamError, resolveModel, type HandlerCtx } from "../upstream.ts";
import { recordUsage, scheduleFlush } from "../usage.ts";
import { geminiJsonChunks, sseResponseFromGenerator } from "./sse.ts";
import { countTokensCacheKey, countTokensWithCache } from "../counttokens.ts";

export async function handleAnthropicMessages(req: Request, ctx: HandlerCtx): Promise<Response> {
  let areq: ARequest;
  try {
    areq = (await req.json()) as ARequest;
  } catch {
    return errAnthropic(400, "invalid_request_error", "Invalid JSON body");
  }
  if (!areq || !Array.isArray(areq.messages)) {
    return errAnthropic(400, "invalid_request_error", "messages is required");
  }
  if (!areq.model) return errAnthropic(400, "invalid_request_error", "model is required");
  if (!areq.max_tokens) return errAnthropic(400, "invalid_request_error", "max_tokens is required");

  const resolved = resolveModel(ctx.cfg, areq.model, true);
  if (!resolved.ok) {
    return errAnthropic(resolved.status === 404 ? 404 : 400, "invalid_request_error", resolved.message ?? "model error");
  }

  const id = randomId("msg_");

  let greq;
  try {
    greq = await anthropicToGemini(areq, {
      policy: ctx.cfg.claude_prompt,
      endpoint: "generate",
      clientModel: areq.model,
      resolvedModel: resolved.model,
    });
  } catch (e) {
    return errAnthropic(400, "invalid_request_error", "convert request failed: " + (e instanceof Error ? e.message : String(e)));
  }

  // 假流式：请求带 fake- 前缀 / aggregate_stream 开启 → 上游非流式 + 合成流式事件序列
  // （仅影响流式请求；与原项目 streamMessages 的 aggregate 参数语义一致）
  const fake = resolved.fake || ctx.cfg.aggregate_stream;
  const action = areq.stream && !fake ? "streamGenerateContent" : "generateContent";
  let upstream: Response;
  try {
    upstream = await callGemini(ctx, resolved.model, action, JSON.stringify(greq));
  } catch (e) {
    return errAnthropic(503, "api_error", "upstream request failed: " + (e instanceof Error ? e.message : String(e)));
  }
  if (!upstream.ok) return await mapUpstreamError(upstream, "anthropic");

  // ---- 非流式 ----
  if (!areq.stream) {
    let g;
    try {
      g = (await upstream.json()) as Parameters<typeof geminiToAnthropic>[0];
    } catch (e) {
      return errAnthropic(503, "api_error", "invalid upstream response: " + (e instanceof Error ? e.message : String(e)));
    }
    const out = geminiToAnthropic(g, areq.model, id);
    const usage = out.usage as { input_tokens: number; output_tokens: number };
    recordUsage(ctx.clientKey, resolved.model, usage.input_tokens, usage.output_tokens);
    ctx.waitUntil(scheduleFlush(ctx.env));
    return json(out);
  }

  // ---- 流式 / 假流式（能走到这里必然 areq.stream=true，非流式已在上方分支返回）----
  let usage: { input: number; output: number } | null = null;
  let gen: AsyncGenerator<string>;
  if (fake) {
    // 假流式：完整响应 → 单帧合成 Anthropic 事件序列（整段文本单 delta，对齐原项目）
    let g;
    try {
      g = (await upstream.json()) as Parameters<typeof geminiToAnthropic>[0];
    } catch (e) {
      return errAnthropic(503, "api_error", "invalid upstream response: " + (e instanceof Error ? e.message : String(e)));
    }
    gen = fakeStreamAnthropicEvents(g, areq.model, id, (input, output) => {
      usage = { input, output };
    });
  } else {
    if (!upstream.body) return errAnthropic(503, "api_error", "empty upstream stream");
    gen = geminiSseToAnthropicEvents(
      geminiJsonChunks(upstream.body),
      areq.model,
      id,
      (input, output) => {
        usage = { input, output };
      },
    );
  }

  // v1.7.0：统一走 sseResponseFromGenerator（ping 保活 + 断开取消上游）
  let usageRecorded = false;
  const recordStreamUsage = () => {
    if (usageRecorded) return;
    usageRecorded = true;
    recordUsage(ctx.clientKey, resolved.model, usage?.input ?? 0, usage?.output ?? 0);
    ctx.waitUntil(scheduleFlush(ctx.env));
  };
  return sseResponseFromGenerator(gen, upstream, recordStreamUsage);
}

/** POST /v1/messages/count_tokens → Gemini :countTokens（v1.6.0：接入 single-flight + LRU + TTL 缓存） */
export async function handleAnthropicCountTokens(req: Request, ctx: HandlerCtx): Promise<Response> {
  let areq: ARequest;
  try {
    areq = (await req.json()) as ARequest;
  } catch {
    return errAnthropic(400, "invalid_request_error", "Invalid JSON body");
  }
  if (!areq || !Array.isArray(areq.messages) || !areq.model) {
    return errAnthropic(400, "invalid_request_error", "model and messages are required");
  }
  const resolved = resolveModel(ctx.cfg, areq.model, true);
  if (!resolved.ok) {
    return errAnthropic(resolved.status === 404 ? 404 : 400, "invalid_request_error", resolved.message ?? "model error");
  }
  const greq = await anthropicToGemini(areq, {
    policy: ctx.cfg.claude_prompt,
    endpoint: "count_tokens",
    clientModel: areq.model,
    resolvedModel: resolved.model,
  });
  // 上游错误响应需原样透传给 mapUpstreamError：用带 Response 载体的异常从 loader 中抛出（不会被缓存）
  try {
    const cacheKey = countTokensCacheKey(resolved.model, greq.contents);
    const total = await countTokensWithCache(cacheKey, async () => {
      let upstream: Response;
      try {
        upstream = await callGemini(ctx, resolved.model, "countTokens", JSON.stringify(greq));
      } catch (e) {
        throw new Error("upstream request failed: " + (e instanceof Error ? e.message : String(e)));
      }
      if (!upstream.ok) {
        throw new UpstreamErrorCarrier(upstream);
      }
      try {
        const g = (await upstream.json()) as { totalTokens?: number };
        return g.totalTokens ?? 0;
      } catch {
        throw new Error("invalid upstream response");
      }
    });
    recordUsage(ctx.clientKey, resolved.model, total, 0);
    ctx.waitUntil(scheduleFlush(ctx.env));
    return json({ input_tokens: total });
  } catch (e) {
    if (e instanceof UpstreamErrorCarrier) {
      return await mapUpstreamError(e.resp, "anthropic");
    }
    return errAnthropic(503, "api_error", e instanceof Error ? e.message : String(e));
  }
}

/** 从 countTokens loader 内部携带上游错误响应的异常（避免错误响应被缓存层吞掉） */
class UpstreamErrorCarrier extends Error {
  resp: Response;
  constructor(resp: Response) {
    super("upstream error HTTP " + resp.status);
    this.resp = resp;
  }
}
