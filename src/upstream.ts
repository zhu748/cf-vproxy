// 上游调用 + 模型校验 —— 各协议处理器共用的胶水层
import type { VProxyConfig } from "./types.ts";
import type { GGenerationConfig } from "./types.ts";
import { pickGeminiKey } from "./config.ts";
import { isChatModel, isKnownModel } from "./models.ts";
import { dispatchUpstream, type ProxyPool } from "./proxy/racefetch.ts";
import { errOpenAI, json } from "./convert/common.ts";
import { hasFakePrefix, stripOneFakePrefix } from "./fakestream.ts";
import { isGemini36OrLater, normalizeThinkingConfig } from "./thinking.ts";

export interface HandlerCtx {
  env: {
    VPROXY_KV: KVNamespace;
    API_KEYS?: string;
    GEMINI_API_KEY?: string;
    GEMINI_API_KEYS?: string;
    PROXY_URLS?: string;
    ADMIN_TOKEN?: string;
  };
  cfg: VProxyConfig;
  pool: ProxyPool | null;
  waitUntil: (p: Promise<unknown>) => void;
  clientKey: string;
}

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** 上游基地址（原项目 gemini_api_base_url 语义）：配置了镜像/中转则用之，否则官方地址 */
export function geminiBase(cfg: VProxyConfig): string {
  return cfg.gemini_base_url || GEMINI_BASE;
}

export interface ModelResolution {
  ok: boolean;
  model: string;
  /** 客户端看到的原始名称（含 fake- 前缀与别名，用于响应回显） */
  display?: string;
  /** 假流式：fake-/假流式- 前缀或 aggregate_stream 配置生效 */
  fake?: boolean;
  status?: number;
  message?: string;
}

/**
 * 请求模型解析（对齐原项目 resolveRequestedModel）：
 *   剥 fake 前缀 → 别名解析 → 再剥一次 fake 前缀 → 内置表校验。
 * 支持三种写法：fake-gemini-3.6-flash、fake-<别名>、<别名>→fake-目标。
 */
export function resolveModel(cfg: VProxyConfig, requested: string, chatOnly: boolean): ModelResolution {
  const fakeRequested = hasFakePrefix(requested);
  let name = stripOneFakePrefix(requested);
  const alias = cfg.model_aliases[name] ?? name;
  name = hasFakePrefix(alias) ? stripOneFakePrefix(alias) : alias;
  if (cfg.disabled_models.includes(name) || cfg.disabled_models.includes(alias)) {
    return { ok: false, model: name, display: requested, status: 403, message: "模型 " + name + " 已被管理员禁用" };
  }
  const known = chatOnly ? isChatModel(name) : isKnownModel(name);
  if (!known) {
    return {
      ok: false,
      model: name,
      display: requested,
      status: 404,
      message:
        "模型 " +
        name +
        " 不在内置模型表中。可用模型见 GET /v1/models；如需映射其它名称，请通过 /admin/config 配置 model_aliases。",
    };
  }
  return { ok: true, model: name, display: requested, fake: fakeRequested || hasFakePrefix(alias) };
}

/**
 * 出站 generationConfig 收尾（移植原项目 buildGenerationConfig 阶段行为）：
 *   - drop_max_tokens 开启，或目标是 Gemini 3.6+ 时删除 maxOutputTokens（思考 token 不再挤占正文）；
 *   - thinkingConfig 按模型家族归一化（budget/level 只留一个，不支持则删除）。
 */
export function finalizeGenerationConfig(cfg: VProxyConfig, model: string, gc: GGenerationConfig | undefined): GGenerationConfig | undefined {
  if (!gc) return gc;
  const out: GGenerationConfig = { ...gc };
  if (out.maxOutputTokens !== undefined && (cfg.drop_max_tokens || isGemini36OrLater(model))) {
    delete out.maxOutputTokens;
  }
  if (out.thinkingConfig !== undefined) {
    const normalized = normalizeThinkingConfig(model, out.thinkingConfig);
    if (normalized) out.thinkingConfig = normalized;
    else delete out.thinkingConfig;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 调用 Gemini 官方 API（单 Key 直连注入、经代理池出口：竞速开启走对冲竞速，否则健康排序轮换） */
export async function callGemini(ctx: HandlerCtx, model: string, action: string, bodyText: string | null): Promise<Response> {
  const key = pickGeminiKey(ctx.cfg);
  if (!key) {
    return json(
      {
        error: {
          code: 401,
          message: "未配置 Gemini 官方 API Key，请通过 wrangler secret（GEMINI_API_KEY）或 Web 面板 /admin 的配置页提供",
          status: "UNAUTHENTICATED",
        },
      },
      401,
    );
  }
  const url =
    geminiBase(ctx.cfg) + "/models/" + encodeURIComponent(model) + ":" + action + (action === "streamGenerateContent" ? "?alt=sse" : "");
  const { response, via } = await dispatchUpstream(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
        accept: "text/event-stream, application/json",
      },
      body: bodyText ?? "",
    },
    ctx.pool,
    ctx.env,
    ctx.waitUntil,
    ctx.cfg.racing,
  );
  (response as Response & { __via?: string }).__via = via;
  return response;
}

/** 将上游错误响应转成对应协议格式的 Response */
export async function mapUpstreamError(
  upstream: Response,
  protocol: "openai" | "anthropic" | "gemini",
): Promise<Response> {
  let message = "upstream error HTTP " + upstream.status;
  let status = upstream.status;
  try {
    const body = (await upstream.json()) as { error?: { code?: number; message?: string; status?: string } };
    if (body?.error?.message) message = body.error.message;
    if (typeof body?.error?.code === "number") status = body.error.code;
  } catch {
    // 保留默认 message
  }
  if (protocol === "openai") return errOpenAI(status, message);
  if (protocol === "anthropic") {
    const t =
      status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status === 400 ? "invalid_request_error" : "api_error";
    return new Response(JSON.stringify({ type: "error", error: { type: t, message } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  const s =
    status === 401
      ? "UNAUTHENTICATED"
      : status === 429
        ? "RESOURCE_EXHAUSTED"
        : status >= 500
          ? "UNAVAILABLE"
          : "INVALID_ARGUMENT";
  return json({ error: { code: status, message, status: s } }, status);
}
