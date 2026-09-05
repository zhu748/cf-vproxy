// 上游调用 + 模型校验 —— 三个协议处理器共用的胶水层
import type { VProxyConfig } from "./types.ts";
import { pickGeminiKey } from "./config.ts";
import { isChatModel, isKnownModel } from "./models.ts";
import { dispatchUpstream, type ProxyPool } from "./proxy/racefetch.ts";
import { errOpenAI, json } from "./convert/common.ts";

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

export interface ModelResolution {
  ok: boolean;
  model: string;
  status?: number;
  message?: string;
}

/** 别名解析 + 内置模型表校验 */
export function resolveModel(cfg: VProxyConfig, requested: string, chatOnly: boolean): ModelResolution {
  const alias = cfg.model_aliases[requested] ?? requested;
  if (cfg.disabled_models.includes(alias)) {
    return { ok: false, model: alias, status: 403, message: "模型 " + alias + " 已被管理员禁用" };
  }
  const known = chatOnly ? isChatModel(alias) : isKnownModel(alias);
  if (!known) {
    return {
      ok: false,
      model: alias,
      status: 404,
      message:
        "模型 " +
        alias +
        " 不在内置模型表中。可用模型见 GET /v1/models；如需映射其它名称，请通过 /admin/config 配置 model_aliases。",
    };
  }
  return { ok: true, model: alias };
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
    GEMINI_BASE + "/models/" + encodeURIComponent(model) + ":" + action + (action === "streamGenerateContent" ? "?alt=sse" : "");
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
