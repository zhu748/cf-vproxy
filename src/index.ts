// cf-vproxy — Vertex Master 精简移植版（Cloudflare Workers）
//
// 路由总览：
//   GET  /                                          服务信息
//   GET  /healthz | /readyz                         健康检查
//   GET  /admin | /admin/panel                      Web 管理面板（登录后可管配置/代理/用量/日志）
//   GET  /v1/models                                 OpenAI 模型列表
//   POST /v1/chat/completions                       OpenAI Chat Completions（流式/非流式）
//   POST /v1/messages                               Anthropic Messages（流式/非流式）
//   POST /v1/messages/count_tokens                  Anthropic Token 计数
//   GET  /v1beta/models                             Gemini 模型列表（当前生效表，带官方元数据）
//   POST /v1beta/models/{model}:{action}            Gemini 原生透传（generateContent/stream/countTokens/predict/predictLongRunning）
//   /admin/*                                        管理端点（ADMIN_TOKEN）
//
// 鉴权：客户端携带的 Key（Bearer / x-api-key / x-goog-api-key / ?key=）必须命中
//       KV 配置中的 api_keys 列表；上游使用单个 Gemini 官方 API Key（单 Key 直连）。
import { handleAdmin } from "./handlers/admin.ts";
import { handleAnthropicCountTokens, handleAnthropicMessages } from "./handlers/anthropic.ts";
import { handleGeminiListModels, handleGeminiNative } from "./handlers/gemini.ts";
import { handleChatCompletions, handleOpenAIModels } from "./handlers/openai.ts";
import { errOpenAI, json } from "./convert/common.ts";
import type { Env } from "./config.ts";
import { loadConfig } from "./config.ts";
import { resolveProxyPool } from "./proxy/proxyfetch.ts";
import { loadActiveModels } from "./modellist.ts";
import { flushIfDue } from "./usage.ts";
import { flushMetricsIfDue, metricsBegin, metricsFinish } from "./metrics.ts";
import { runScheduledTasks } from "./cron.ts";
import { maskClientKey, protocolOf, pushLog } from "./logs.ts";
import type { HandlerCtx } from "./upstream.ts";

const VERSION = "1.4.0";

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-api-key, x-goog-api-key, anthropic-version, x-requested-with",
    "access-control-max-age": "86400",
  };
}

function withCors(resp: Response): Response {
  const out = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(corsHeaders())) out.headers.set(k, v);
  return out;
}

function extractClientKey(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const xapi = req.headers.get("x-api-key");
  if (xapi) return xapi.trim();
  const goog = req.headers.get("x-goog-api-key");
  if (goog) return goog.trim();
  const keyParam = new URL(req.url).searchParams.get("key");
  if (keyParam) return keyParam.trim();
  return "";
}

function serviceInfo(): Response {
  return json({
    service: "cf-vproxy",
    version: VERSION,
    based_on: "vertex-master (official 单 Key 直连模式)",
    panel: "/admin",
    features: [
      "openai/anthropic/gemini 三协议转换",
      "socks4/4a/socks5/http 出站代理",
      "对冲竞速（原项目 race engine 移植）",
      "节点健康度 + 粘性优选 + 节点内重试",
      "Cron 定时健康巡检 / 订阅差异更新 / keepalive 保活",
      "OpenAI n 多候选（max_n，原项目 CompleteChatN 移植）",
      "上游镜像/中转基地址（gemini_base_url）",
      "请求指标（JSON / Prometheus）+ Claude 提示词诊断",
      "订阅拉取 + 不支持协议自动剔除",
      "官方 ListModels 拉取模型表（内置 + 面板一键重新拉取）",
      "KV 配置热更新",
      "用量/请求日志持久化",
    ],
    endpoints: {
      openai: ["GET /v1/models", "POST /v1/chat/completions"],
      anthropic: ["POST /v1/messages", "POST /v1/messages/count_tokens"],
      gemini: ["GET /v1beta/models", "POST /v1beta/models/{model}:{generateContent|streamGenerateContent|countTokens|predict|predictLongRunning}"],
      admin: [
        "GET /admin (Web 面板)",
        "GET|POST /admin/config",
        "GET /admin/models",
        "POST /admin/models/refresh (从官方重新拉取模型表)",
        "POST /admin/models/reset (恢复内置表)",
        "GET /admin/usage",
        "POST /admin/usage/reset",
        "GET /admin/logs",
        "POST /admin/logs/clear",
        "POST /admin/proxies/refresh",
        "POST /admin/proxy/test",
        "POST /admin/proxies/test-all",
        "GET /admin/health",
        "POST /admin/health/sweep (手动巡检)",
        "POST /admin/health/reset",
        "GET /admin/metrics[?format=prometheus]",
        "GET /admin/prompt-diagnostics",
        "POST /admin/prompt-diagnostics/clear",
      ],
    },
    outbound_proxies: ["socks4://", "socks4a://", "socks5://", "http://"],
    proxy_notes: "https:// 代理在 Workers 上不可用（无法 TLS-in-TLS），配置与订阅中的此类链接会被自动剔除",
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const started = Date.now();
    const url = new URL(req.url);
    metricsBegin();
    try {
      const resp = await route(req, env, ctx);
      ctx.waitUntil(flushIfDue(env));
      ctx.waitUntil(flushMetricsIfDue(env));
      metricsFinish(resp.status, Date.now() - started, protocolOf(url.pathname));
      pushLog({
        at: new Date().toISOString(),
        protocol: protocolOf(url.pathname),
        method: req.method,
        path: url.pathname,
        model: "-",
        status: resp.status,
        ms: Date.now() - started,
        via: (resp as Response & { __via?: string }).__via ?? "-",
        key: maskClientKey(extractClientKey(req)),
        ok: resp.status < 400,
      });
      return withCors(resp);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      metricsFinish(500, Date.now() - started, protocolOf(url.pathname));
      pushLog({
        at: new Date().toISOString(),
        protocol: protocolOf(url.pathname),
        method: req.method,
        path: url.pathname,
        model: "-",
        status: 500,
        ms: Date.now() - started,
        via: "-",
        key: maskClientKey(extractClientKey(req)),
        ok: false,
      });
      return withCors(errOpenAI(500, "internal error: " + message));
    }
  },

  // Cron Triggers：定时健康巡检 + 订阅差异更新 + keepalive 保活（见 src/cron.ts）
  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScheduledTasks(env).catch((e) => {
        console.log("[cron] scheduled tasks failed:", e instanceof Error ? e.message : String(e));
      }),
    );
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/" || path === "")) return serviceInfo();
  if (req.method === "GET" && (path === "/healthz" || path === "/readyz")) return json({ ok: true, version: VERSION });

  // ===== 管理端点（面板 HTML 无需 token，API 走 ADMIN_TOKEN） =====
  if (path.startsWith("/admin")) {
    return handleAdmin(req, path, env, (p) => ctx.waitUntil(p));
  }

  // ===== 业务端点：加载配置 + 代理池 + 鉴权 =====
  const cfg = await loadConfig(env);
  if (cfg.api_keys.length === 0) {
    return errOpenAI(403, "服务未配置任何客户端 API Key：请打开 Web 面板 /admin 配置，或通过 wrangler secret（API_KEYS）提供");
  }
  const clientKey = extractClientKey(req);
  if (!clientKey || !cfg.api_keys.includes(clientKey)) {
    return errOpenAI(401, "Invalid API key");
  }

  const pool = await resolveProxyPool(env, cfg, (p) => ctx.waitUntil(p));
  // 模型表：KV 动态表（官方拉取）优先，否则内置表（60s 内存缓存，KV 读失败回退内置）
  await loadActiveModels(env);
  const hctx: HandlerCtx = {
    env,
    cfg,
    pool,
    waitUntil: (p) => ctx.waitUntil(p),
    clientKey,
  };

  // ---- OpenAI ----
  if (req.method === "POST" && path === "/v1/chat/completions") {
    return handleChatCompletions(req, hctx);
  }
  if (req.method === "GET" && path === "/v1/models") {
    return handleOpenAIModels();
  }

  // ---- Anthropic ----
  if (req.method === "POST" && path === "/v1/messages") {
    return handleAnthropicMessages(req, hctx);
  }
  if (req.method === "POST" && path === "/v1/messages/count_tokens") {
    return handleAnthropicCountTokens(req, hctx);
  }

  // ---- Gemini 原生 ----
  if (req.method === "GET" && path === "/v1beta/models") {
    return handleGeminiListModels();
  }
  const m = /^\/v1beta\/models\/([^:]+):([a-zA-Z]+)$/.exec(path);
  if (req.method === "POST" && m) {
    return handleGeminiNative(decodeURIComponent(m[1]), m[2], req, hctx);
  }

  return errOpenAI(404, "未知的路径：" + path + "，可用端点见 GET /");
}
