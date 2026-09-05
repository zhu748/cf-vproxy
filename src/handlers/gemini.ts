// Gemini 原生协议处理器：
//   GET  /v1beta/models                        → 当前生效模型表（内置或官方动态拉取，带官方元数据）
//   POST /v1beta/models/{model}:generateContent|streamGenerateContent|countTokens|predict|predictLongRunning
// 请求体原样透传（不解析、不改写），仅注入 x-goog-api-key 并经代理池出站。
import { errGemini, json } from "../convert/common.ts";
import { activeTable, isKnownModelActive } from "../modellist.ts";
import { callGemini, resolveModel, type HandlerCtx } from "../upstream.ts";
import { recordUsage, scheduleFlush } from "../usage.ts";
import { passthroughResponse } from "./sse.ts";

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
  let upstream: Response;
  try {
    upstream = await callGemini(ctx, resolved.model, action, bodyText);
  } catch (e) {
    return errGemini(503, "upstream request failed: " + (e instanceof Error ? e.message : String(e)), "UNAVAILABLE");
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

/** Gemini 模型列表：当前生效表（内置或官方动态拉取），带官方元数据 */
export function handleGeminiListModels(): Response {
  const t = activeTable();
  return json({
    models: [...t.chat, ...t.native_only].map((name) => {
      const m = t.meta.get(name);
      return {
        name: "models/" + name,
        displayName: m?.display_name ?? name,
        description: m?.description,
        inputTokenLimit: m?.input_token_limit,
        outputTokenLimit: m?.output_token_limit,
        thinking: m?.thinking,
        supportedGenerationMethods: m?.methods ?? ["generateContent", "streamGenerateContent", "countTokens"],
      };
    }),
  });
}
