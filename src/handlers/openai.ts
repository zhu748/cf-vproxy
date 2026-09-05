// OpenAI 协议处理器：POST /v1/chat/completions + GET /v1/models
// v1.3.0：思考强度归一化、预填充适配 + 回声剥离、假流式（fake-/假流式- 前缀 / aggregate_stream）、
//         SSE ping 保活、图像模型输出 markdown 化。
import { errOpenAI, json, randomId, partInlineData, partFunctionCall, partText, resolveN } from "../convert/common.ts";
import {
  geminiSseToOpenaiChunks,
  geminiToOpenAI,
  openaiToGemini,
  type OpenAIUsage,
} from "../convert/openai.ts";
import type { GResponse, GRequest, ORequest } from "../types.ts";
import { callGemini, finalizeGenerationConfig, mapUpstreamError, resolveModel, type HandlerCtx } from "../upstream.ts";
import { recordUsage, scheduleFlush } from "../usage.ts";
import { geminiJsonChunks, sseResponseFromGenerator, SSE_HEADERS } from "./sse.ts";
import { listChatModels } from "../modellist.ts";
import { adaptPrefill, PrefillEchoFilter } from "../prefill.ts";
import { splitFakeChunks, withFakeVariants } from "../fakestream.ts";
import type { OFunctionDef } from "../types.ts";

/** geminiToOpenAI 输出的窄类型（其返回值为 Record<string, unknown>，这里仅做结构断言） */
interface OAIChoiceOut {
  index: number;
  message: { role?: string; content?: string | Array<Record<string, unknown>> | null; tool_calls?: unknown };
  finish_reason?: string;
  [k: string]: unknown;
}
interface OAICompletionOut {
  choices?: OAIChoiceOut[];
  usage?: unknown;
  [k: string]: unknown;
}

/**
 * 解析 OpenAI n 参数 —— 实现在 src/convert/common.ts（纯逻辑层，便于单测）；此处 re-export 保持兼容。
 */
export { resolveN } from "../convert/common.ts";

export async function handleChatCompletions(req: Request, ctx: HandlerCtx): Promise<Response> {
  let oreq: ORequest;
  try {
    oreq = (await req.json()) as ORequest;
  } catch {
    return errOpenAI(400, "Invalid JSON body");
  }
  if (!oreq || !Array.isArray(oreq.messages)) return errOpenAI(400, "messages is required");
  if (!oreq.model) return errOpenAI(400, "model is required");

  const resolved = resolveModel(ctx.cfg, oreq.model, true);
  if (!resolved.ok) return errOpenAI(resolved.status ?? 400, resolved.message ?? "model error");

  const id = randomId("chatcmpl-");
  const created = Math.floor(Date.now() / 1000);

  let greq;
  try {
    greq = await openaiToGemini(oreq);
  } catch (e) {
    return errOpenAI(400, "convert request failed: " + (e instanceof Error ? e.message : String(e)));
  }
  greq.generationConfig = finalizeGenerationConfig(ctx.cfg, resolved.model, greq.generationConfig);
  const adapted = adaptPrefill(resolved.model, greq.contents);
  greq.contents = adapted.payload.contents;

  // 假流式：请求带 fake 前缀 / aggregate_stream 开启 → 上游非流式 + 合成流式输出
  const fake = resolved.fake || ctx.cfg.aggregate_stream;
  const action = oreq.stream && !fake ? "streamGenerateContent" : "generateContent";

  // ---- n 多候选（原项目 max_n + CompleteChatN/AggregateN：仅非流式，并发 n 次上游请求合并 choices） ----
  const nRes = resolveN(oreq.n, ctx.cfg.max_n);
  if (nRes.error) return errOpenAI(400, nRes.error);
  if (nRes.n > 1) {
    if (oreq.stream || fake) {
      return errOpenAI(400, "流式不支持 n>1，请设 stream=false 或 n=1 (streaming supports only n=1; set stream=false or n=1 for multiple choices)");
    }
    return await handleMultiCandidate(ctx, resolved.model, resolved.display ?? oreq.model, greq, nRes.n, id, created, adapted.prefill);
  }

  let upstream: Response;
  try {
    upstream = await callGemini(ctx, resolved.model, action, JSON.stringify(greq));
  } catch (e) {
    return errOpenAI(502, "upstream request failed: " + (e instanceof Error ? e.message : String(e)));
  }
  if (!upstream.ok) return await mapUpstreamError(upstream, "openai");

  // ---- 非流式 ----
  if (!oreq.stream && !fake) {
    let g;
    try {
      g = (await upstream.json()) as Parameters<typeof geminiToOpenAI>[0];
    } catch (e) {
      return errOpenAI(502, "invalid upstream response: " + (e instanceof Error ? e.message : String(e)));
    }
    const out = geminiToOpenAI(g, resolved.display ?? oreq.model, id, created) as OAICompletionOut;
    if (adapted.prefill && typeof out.choices?.[0]?.message?.content === "string") {
      out.choices[0].message.content = out.choices[0].message.content.slice(
        out.choices[0].message.content.startsWith(adapted.prefill) ? adapted.prefill.length : 0,
      );
    }
    const usage = out.usage as OpenAIUsage;
    recordUsage(ctx.clientKey, resolved.model, usage.prompt_tokens, usage.completion_tokens);
    ctx.waitUntil(scheduleFlush(ctx.env));
    return json(out);
  }

  // ---- 流式 / 假流式 ----
  const includeUsage = oreq.stream_options?.include_usage === true;
  const displayModel = resolved.display ?? oreq.model;

  let gen: AsyncGenerator<string>;
  if (fake) {
    // 假流式：完整响应 → 按 rune 边界 ≤8 块连续吐出（无人为间隔）
    let g: GResponse;
    try {
      g = (await upstream.json()) as GResponse;
    } catch (e) {
      return errOpenAI(502, "invalid upstream response: " + (e instanceof Error ? e.message : String(e)));
    }
    gen = fakeStreamFromGeminiResponse(g, displayModel, id, created, includeUsage, adapted.prefill);
    if (!oreq.stream) {
      // 客户端根本没要流式（仅 aggregate_stream 开启）：直接走非流式信封
      const single: string[] = [];
      for await (const frame of gen) single.push(frame);
      const collected = single.join("");
      void collected;
      const out = geminiToOpenAI(g, displayModel, id, created);
      const usage = out.usage as OpenAIUsage;
      recordUsage(ctx.clientKey, resolved.model, usage.prompt_tokens, usage.completion_tokens);
      ctx.waitUntil(scheduleFlush(ctx.env));
      return json(out);
    }
  } else {
    if (!upstream.body) return errOpenAI(502, "empty upstream stream");
    gen = geminiSseToOpenaiChunks(
      geminiJsonChunks(upstream.body),
      displayModel,
      id,
      created,
      includeUsage,
      () => {},
    );
  }

  return sseResponseFromGenerator(gen, upstream);
}

/**
 * n>1 非流式多候选（移植原项目 CompleteChatN + AggregateN）：
 *   并发发起 n 次上游请求 → 每个响应转为一个 choice（index 重编号）→ usage 逐项累加。
 *   宽松策略：部分失败不影响成功候选；全部失败才报错（优先透传第一个上游错误）。
 */
async function handleMultiCandidate(
  ctx: HandlerCtx,
  model: string,
  displayModel: string,
  greq: GRequest,
  n: number,
  id: string,
  created: number,
  prefill: string,
): Promise<Response> {
  const settled = await Promise.allSettled(
    Array.from({ length: n }, () => callGemini(ctx, model, "generateContent", JSON.stringify(greq))),
  );
  const gResponses: GResponse[] = [];
  let firstErrorResp: Response | null = null;
  let firstErrorText = "";
  for (const s of settled) {
    if (s.status === "rejected") {
      if (!firstErrorText) firstErrorText = s.reason instanceof Error ? s.reason.message : String(s.reason);
      continue;
    }
    const resp = s.value;
    if (!resp.ok) {
      if (!firstErrorResp) firstErrorResp = resp;
      continue;
    }
    try {
      gResponses.push((await resp.json()) as GResponse);
    } catch {
      // 单个坏响应不影响其余候选
    }
  }
  if (gResponses.length === 0) {
    if (firstErrorResp) return await mapUpstreamError(firstErrorResp, "openai");
    return errOpenAI(502, "all " + n + " upstream requests failed" + (firstErrorText ? ": " + firstErrorText : ""));
  }

  const choices: Array<Record<string, unknown>> = [];
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalTokens = 0;
  let anyUsage = false;
  for (const g of gResponses) {
    const out = geminiToOpenAI(g, displayModel, id, created) as OAICompletionOut;
    for (const ch of out.choices ?? []) {
      if (prefill && ch.message && typeof ch.message.content === "string") {
        ch.message.content = ch.message.content.startsWith(prefill)
          ? ch.message.content.slice(prefill.length)
          : ch.message.content;
      }
      ch.index = choices.length;
      choices.push(ch as unknown as Record<string, unknown>);
    }
    const u = out.usage as OpenAIUsage | undefined;
    if (u) {
      anyUsage = true;
      totalPrompt += u.prompt_tokens ?? 0;
      totalCompletion += u.completion_tokens ?? 0;
      totalTokens += u.total_tokens ?? 0;
    }
  }
  if (anyUsage && totalTokens === 0) totalTokens = totalPrompt + totalCompletion;
  const body: Record<string, unknown> = { id, object: "chat.completion", created, model: displayModel, choices };
  if (anyUsage) body.usage = { prompt_tokens: totalPrompt, completion_tokens: totalCompletion, total_tokens: totalTokens };
  recordUsage(ctx.clientKey, model, totalPrompt, totalCompletion);
  ctx.waitUntil(scheduleFlush(ctx.env));
  return json(body);
}

/**
 * 假流式（OAI 形态，移植 syntheticOAIStreamDeltas）：
 *   首块 role → content ≤8 块 → tool_calls 增量数组 → finish_reason → usage → [DONE]
 */
export async function* fakeStreamFromGeminiResponse(
  g: GResponse,
  model: string,
  id: string,
  created: number,
  includeUsage: boolean,
  prefill: string,
): AsyncGenerator<string> {
  const header = () => ({ id, object: "chat.completion.chunk", created, model });
  const emit = (chunk: Record<string, unknown>) => "data: " + JSON.stringify(chunk) + "\n\n";

  const cand = g.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  let text = "";
  const toolCalls: Array<{ index: number; id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  let toolIndex = 0;
  for (const p of parts) {
    const t = partText(p);
    if (t !== undefined) {
      text += t;
      continue;
    }
    const fc = partFunctionCall(p);
    if (fc) {
      toolCalls.push({
        index: toolIndex++,
        id: randomId("call_"),
        type: "function",
        function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
      });
      continue;
    }
    const inline = partInlineData(p);
    if (inline) text += "![image](data:" + (inline.mime_type || "image/png") + ";base64," + inline.data + ")\n";
  }
  if (prefill && text.startsWith(prefill)) text = text.slice(prefill.length);

  // 首块：role
  yield emit({ ...header(), choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  // content 块
  for (const chunk of splitFakeChunks(text)) {
    yield emit({ ...header(), choices: [{ index: 0, delta: { content: chunk }, finish_reason: null, logprobs: null }] });
  }
  // tool_calls 增量数组（一次给全）
  if (toolCalls.length > 0) {
    yield emit({ ...header(), choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }] });
  }
  // finish_reason
  const hasTools = toolCalls.length > 0;
  const fr = cand?.finishReason;
  let finish = hasTools ? "tool_calls" : "stop";
  if (!hasTools) {
    if (fr === "MAX_TOKENS") finish = "length";
    else if (fr === "SAFETY" || fr === "PROHIBITED_CONTENT" || fr === "BLOCKLIST" || fr === "SPII" || fr === "RECITATION") finish = "content_filter";
  }
  yield emit({ ...header(), choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  // usage
  const usage = geminiUsageOf(g);
  if (includeUsage && usage) {
    yield emit({ ...header(), choices: [], usage });
  }
  yield "data: [DONE]\n\n";
}

function geminiUsageOf(g: GResponse): OpenAIUsage | null {
  const u = g.usageMetadata;
  if (!u) return null;
  const completion = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  return {
    prompt_tokens: u.promptTokenCount ?? 0,
    completion_tokens: completion,
    total_tokens: u.totalTokenCount ?? (u.promptTokenCount ?? 0) + completion,
  };
}

export function handleOpenAIModels(): Response {
  const now = Math.floor(Date.now() / 1000);
  // 与原项目 ModelsWithFakeVariants 一致：每个 chat 模型暴露 m / 假流式-m / fake-m 三个条目
  return json({
    object: "list",
    data: withFakeVariants(listChatModels()).map((m) => ({ id: m, object: "model", created: now, owned_by: "google" })),
  });
}

// 类型占位：避免 tree-shake 误删（OFunctionDef 由 openaiToGemini 间接使用）
export type { OFunctionDef };
export { SSE_HEADERS };
