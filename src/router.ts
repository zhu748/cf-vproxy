// 业务端点路由表 —— 纯函数模块（无任何运行时依赖，可在 Node 单测中直接验证）。
//
// index.ts 按匹配结果 dispatch 到对应处理器；本模块只做 方法/路径 匹配与参数提取，
// 保证路由规则集中一处、可测试（此前路由分散在 index.ts，无法在 Node 下回归）。
//
// v1.6.0：新增 /v1/responses、/v1/audio/speech、/v1/images/* 与 GET /v1/models/{model}
// 的注册（处理器早已存在，此前从未接入路由 —— 本次修复“死代码”缺陷）。

export type ApiRouteKind =
  | "chat_completions" // POST /v1/chat/completions
  | "openai_models" // GET  /v1/models
  | "openai_model_detail" // GET  /v1/models/{model}
  | "responses" // POST /v1/responses（OpenAI Responses API）
  | "audio_speech" // POST /v1/audio/speech（OpenAI TTS）
  | "images_generations" // POST /v1/images/generations
  | "images_edits" // POST /v1/images/edits
  | "images_variations" // POST /v1/images/variations
  | "anthropic_messages" // POST /v1/messages
  | "anthropic_count_tokens" // POST /v1/messages/count_tokens
  | "gemini_list_models" // GET  /v1beta/models
  | "gemini_native" // POST /v1beta/models/{model}:{action}
  | "unknown";

export interface ApiRoute {
  kind: ApiRouteKind;
  /** gemini_native / openai_model_detail：路径中的模型名（已 decode） */
  model?: string;
  /** gemini_native：动作名（generateContent / streamGenerateContent / countTokens / predict / predictLongRunning） */
  action?: string;
}

/** 需要出站上游（也就需要代理池）的端点；模型列表/详情类端点无需解析代理池 */
export const NEEDS_UPSTREAM: ReadonlySet<ApiRouteKind> = new Set<ApiRouteKind>([
  "chat_completions",
  "responses",
  "audio_speech",
  "images_generations",
  "images_edits",
  "images_variations",
  "anthropic_messages",
  "anthropic_count_tokens",
  "gemini_native",
]);

const GEMINI_ACTION_RE = /^\/v1beta\/models\/([^:]+):([a-zA-Z]+)$/;
const OPENAI_MODEL_RE = /^\/v1\/models\/([^\/]+)$/;

/**
 * 匹配业务端点（method + path）。
 * 注意：管理端点（/admin*）与健康检查（/、/healthz）不在此表 —— 由 index.ts 直接处理。
 */
export function matchApiRoute(method: string, path: string): ApiRoute {
  const m = method.toUpperCase();

  if (m === "GET" && path === "/v1/models") return { kind: "openai_models" };
  if (m === "GET") {
    const d = OPENAI_MODEL_RE.exec(path);
    if (d) return { kind: "openai_model_detail", model: decodeURIComponent(d[1]) };
  }

  if (m === "POST") {
    switch (path) {
      case "/v1/chat/completions":
        return { kind: "chat_completions" };
      case "/v1/responses":
        return { kind: "responses" };
      case "/v1/audio/speech":
        return { kind: "audio_speech" };
      case "/v1/images/generations":
        return { kind: "images_generations" };
      case "/v1/images/edits":
        return { kind: "images_edits" };
      case "/v1/images/variations":
        return { kind: "images_variations" };
      case "/v1/messages":
        return { kind: "anthropic_messages" };
      case "/v1/messages/count_tokens":
        return { kind: "anthropic_count_tokens" };
    }
    const g = GEMINI_ACTION_RE.exec(path);
    if (g) return { kind: "gemini_native", model: decodeURIComponent(g[1]), action: g[2] };
  }

  if (m === "GET" && path === "/v1beta/models") return { kind: "gemini_list_models" };

  return { kind: "unknown" };
}
