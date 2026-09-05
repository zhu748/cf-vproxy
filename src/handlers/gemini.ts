// Gemini 原生协议处理器：
//   GET  /v1beta/models                        → 当前生效模型表（内置或官方动态拉取，带官方元数据，含假流式变体）
//   POST /v1beta/models/{model}:generateContent|streamGenerateContent|countTokens|predict|predictLongRunning
// 请求体原样透传（不解析、不改写），仅注入 x-goog-api-key 并经代理池出站。
import { errGemini, json } from "../convert/common.ts";
import { activeTable, isKnownModelActive } from "../modellist.ts";
import { callGemini, resolveModel, type HandlerCtx } from "../upstream.ts";
import { recordUsage, scheduleFlush } from "../usage.ts";
import { passthroughResponse } from "./sse.ts";
import { geminiFakeStreamSseBody, stripOneFakePrefix, withFakeVariants } from "../fakestream.ts";
import type { GResponse } from "../types.ts";

const ALLOWED_ACTIONS = new Set(["generateContent", "streamGenerateContent", "countTokens", "predict", "predictLongRunning"]);

export async function handleGeminiNative(
  model: string,
  action: string,
  req: Request,
  ctx: HandlerCtx,
): Promise<Response> {
  if (!ALLOWED_ACTIONS.has(action)) {
    return errGemini(
      404,
      "unsupported action :" + action + "（仅支持 generateContent / streamGenerateContent / countTokens / predict / predictLongRunning）",
      "NOT_FOUND",
    );
  }
  // 非文本模型（veo/imagen 等）只配 predict(LongRunning)；chat 动作走 chat 表校验
  const isPredict = action === "predict" || action === "predictLongRunning";
  const resolved = resolveModel(ctx.cfg, model, !isPredict);
  if (!resolved.ok) return errGemini(resolved.status ?? 400, resolved.message ?? "model error", resolved.status === 404 ? "NOT_FOUND" : "INVALID_ARGUMENT");
  if (isPredict && !isKnownModelActive(resolved.model)) {
    return errGemini(404, "未知模型 " + resolved.model, "NOT_FOUND");
  }

  const bodyText = await req.text();
  // 假流式：与原项目一致，Gemini 原生端点仅认 fake-/假流式- 前缀（不认 aggregate_stream），
  // 且仅作用于 :streamGenerateContent —— 上游改走非流式 generateContent，完整拿到响应后合成 SSE 帧
  const fake = resolved.fake && action === "streamGenerateContent";
  let upstream: Response;
  try {
    upstream = await callGemini(ctx, resolved.model, fake ? "generateContent" : action, bodyText);
  } catch (e) {
    return errGemini(503, "upstream request failed: " + (e instanceof Error ? e.message : String(e)), "UNAVAILABLE");
  }

  if (fake) {
    if (!upstream.ok) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    }
    let g: GResponse;
    try {
      g = (await upstream.json()) as GResponse;
    } catch (e) {
      return errGemini(503, "invalid upstream response: " + (e instanceof Error ? e.message : String(e)), "UNAVAILABLE");
    }
    const u = g.usageMetadata;
    recordUsage(
      ctx.clientKey,
      resolved.model,
      u?.promptTokenCount ?? 0,
      (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    );
    ctx.waitUntil(scheduleFlush(ctx.env));
    return new Response(geminiFakeStreamSseBody(g), {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  recordUsage(ctx.clientKey, resolved.model, 0, 0);
  ctx.waitUntil(scheduleFlush(ctx.env));

  if (upstream.ok) {
    // 非流式响应顺手记录 token 用量
    if (action !== "streamGenerateContent" && (action === "generateContent" || action === "countTokens")) {
      try {
        const cloned = upstream.clone();
        const data = (await cloned.json()) as {
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
        };
        if (action === "countTokens") recordUsage(ctx.clientKey, resolved.model, data.usageMetadata?.totalTokenCount ?? 0, 0);
        else
          recordUsage(
            ctx.clientKey,
            resolved.model,
            data.usageMetadata?.promptTokenCount ?? 0,
            (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0),
          );
      } catch {
        // 用量解析失败不影响透传
      }
    }
    return passthroughResponse(upstream);
  }
  // 错误原样透传（保持 Gemini 错误结构）
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

/** Gemini 模型列表：当前生效表（内置或官方动态拉取）+ 假流式变体。
 *  与原项目 ModelsWithFakeVariants 一致：仅 chat 模型展开 m / 假流式-m / fake-m 三条目；
 *  原生专用模型（veo 等 predict-only）不展开变体但保留在列表中。 */
export function handleGeminiListModels(): Response {
  const t = activeTable();
  return json({
    models: [...withFakeVariants(t.chat), ...t.native_only].map((variant) => {
      const base = stripOneFakePrefix(variant);
      const m = t.meta.get(base);
      return {
        name: "models/" + variant,
        displayName: m?.display_name ?? base,
        description: m?.description,
        inputTokenLimit: m?.input_token_limit,
        outputTokenLimit: m?.output_token_limit,
        thinking: m?.thinking,
        supportedGenerationMethods: m?.methods ?? ["generateContent", "streamGenerateContent", "countTokens"],
      };
    }),
  });
}
