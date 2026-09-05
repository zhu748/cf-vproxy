// Anthropic 协议处理器：POST /v1/messages + POST /v1/messages/count_tokens
import { errAnthropic, json, randomId } from "../convert/common.ts";
import {
  anthropicToGemini,
  geminiSseToAnthropicEvents,
  geminiToAnthropic,
} from "../convert/anthropic.ts";
import type { ARequest } from "../types.ts";
import { callGemini, mapUpstreamError, resolveModel, type HandlerCtx } from "../upstream.ts";
import { recordUsage, scheduleFlush } from "../usage.ts";
import { geminiJsonChunks } from "./sse.ts";

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

  const action = areq.stream ? "streamGenerateContent" : "generateContent";
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

  // ---- 流式 ----
  if (!upstream.body) return errAnthropic(503, "api_error", "empty upstream stream");
  let usage: { input: number; output: number } | null = null;
  const gen = geminiSseToAnthropicEvents(
    geminiJsonChunks(upstream.body),
    areq.model,
    id,
    (input, output) => {
      usage = { input, output };
    },
  );

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) {
          controller.close();
          recordUsage(ctx.clientKey, resolved.model, usage?.input ?? 0, usage?.output ?? 0);
          ctx.waitUntil(scheduleFlush(ctx.env));
        } else {
          controller.enqueue(encoder.encode(value));
        }
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/** POST /v1/messages/count_tokens → Gemini :countTokens */
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
  let upstream: Response;
  try {
    upstream = await callGemini(ctx, resolved.model, "countTokens", JSON.stringify(greq));
  } catch (e) {
    return errAnthropic(503, "api_error", "upstream request failed: " + (e instanceof Error ? e.message : String(e)));
  }
  if (!upstream.ok) return await mapUpstreamError(upstream, "anthropic");
  try {
    const g = (await upstream.json()) as { totalTokens?: number };
    recordUsage(ctx.clientKey, resolved.model, g.totalTokens ?? 0, 0);
    ctx.waitUntil(scheduleFlush(ctx.env));
    return json({ input_tokens: g.totalTokens ?? 0 });
  } catch {
    return errAnthropic(503, "api_error", "invalid upstream response");
  }
}
