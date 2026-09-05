// OpenAI 协议处理器：POST /v1/chat/completions + GET /v1/models
import { errOpenAI, json, randomId } from "../convert/common.ts";
import { geminiSseToOpenaiChunks, geminiToOpenAI, openaiToGemini, type OpenAIUsage } from "../convert/openai.ts";
import type { ORequest } from "../types.ts";
import { callGemini, mapUpstreamError, resolveModel, type HandlerCtx } from "../upstream.ts";
import { recordUsage, scheduleFlush } from "../usage.ts";
import { geminiJsonChunks, sseResponseFromGenerator } from "./sse.ts";
import { GEMINI_CHAT_MODELS } from "../models.ts";

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

  const action = oreq.stream ? "streamGenerateContent" : "generateContent";
  let upstream: Response;
  try {
    upstream = await callGemini(ctx, resolved.model, action, JSON.stringify(greq));
  } catch (e) {
    return errOpenAI(502, "upstream request failed: " + (e instanceof Error ? e.message : String(e)));
  }
  if (!upstream.ok) return await mapUpstreamError(upstream, "openai");

  // ---- 非流式 ----
  if (!oreq.stream) {
    let g;
    try {
      g = (await upstream.json()) as Parameters<typeof geminiToOpenAI>[0];
    } catch (e) {
      return errOpenAI(502, "invalid upstream response: " + (e instanceof Error ? e.message : String(e)));
    }
    const out = geminiToOpenAI(g, oreq.model, id, created);
    const usage = out.usage as OpenAIUsage;
    recordUsage(ctx.clientKey, resolved.model, usage.prompt_tokens, usage.completion_tokens);
    ctx.waitUntil(scheduleFlush(ctx.env));
    return json(out);
  }

  // ---- 流式 ----
  if (!upstream.body) return errOpenAI(502, "empty upstream stream");
  const includeUsage = oreq.stream_options?.include_usage === true;
  let usage: OpenAIUsage | null = null;
  const gen = geminiSseToOpenaiChunks(
    geminiJsonChunks(upstream.body),
    oreq.model,
    id,
    created,
    includeUsage,
    (u) => {
      usage = u;
    },
  );

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) {
          controller.close();
          recordUsage(ctx.clientKey, resolved.model, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0);
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

export function handleOpenAIModels(): Response {
  const now = Math.floor(Date.now() / 1000);
  return json({
    object: "list",
    data: GEMINI_CHAT_MODELS.map((m) => ({ id: m, object: "model", created: now, owned_by: "google" })),
  });
}

export { sseResponseFromGenerator };
