// 管理端点（Bearer ADMIN_TOKEN 鉴权）+ Web 管理面板：
//   GET  /admin | /admin/panel    Web 管理面板（HTML；token 在面板登录页输入）
//   GET  /admin/config            查看配置（Gemini Key 打码）
//   POST /admin/config            覆盖保存配置（含代理链接自动清洗报告、打码 Key 保护）
//   POST /admin/proxies/refresh   强制刷新订阅
//   POST /admin/proxy/test        测试单个代理连通性 { proxy: "socks5://..." }
//   GET  /admin/models            内置模型表（面板用）
//   GET  /admin/usage             查询用量统计（KV 持久化，含聚合 totals）
//   POST /admin/usage/reset       清空用量统计
//   GET  /admin/logs              最近请求日志（内存环形缓冲）
//   POST /admin/logs/clear        清空请求日志
//   GET  /admin/health            节点健康度快照（竞速/接力依据，含竞速配置）
//   POST /admin/health/reset      清空节点健康度
//   POST /admin/proxies/test-all  并发全量测速（写入健康度，可用优先+延迟升序返回）
import { invalidateConfigCache, loadConfig, saveConfig, type Env } from "../config.ts";
import { json } from "../convert/common.ts";
import { cleanProxyList } from "../proxy/frames.ts";
import { ALL_MODELS, GEMINI_CHAT_MODELS, GEMINI_NATIVE_ONLY_MODELS } from "../models.ts";
import { clearLogs, listLogs } from "../logs.ts";
import { renderPanelHtml } from "./panel.ts";
import type { VProxyConfig } from "../types.ts";
import { allHealthRecords, averageLatency, flushHealthNow, healthMapSnapshot, recordProxyFailure, recordProxySuccess, resetHealth, sanitizeRacingConfig } from "../racing.ts";

function maskKey(k: string): string {
  if (!k) return "";
  if (k.length <= 8) return k.slice(0, 2) + "****";
  return k.slice(0, 6) + "****" + k.slice(-4);
}

const MASK_HINT = "****";

export async function handleAdmin(
  req: Request,
  path: string,
  envVars: Env,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  // ---- Web 面板：HTML 本身不需要 token（token 由前端登录页携带调 API） ----
  if (req.method === "GET" && (path === "/admin" || path === "/admin/" || path === "/admin/panel")) {
    return new Response(renderPanelHtml(), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!envVars.ADMIN_TOKEN) {
    return json({ error: "管理端点未启用：请先 wrangler secret put ADMIN_TOKEN" }, 403);
  }
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : new URL(req.url).searchParams.get("token") ?? "";
  if (token !== envVars.ADMIN_TOKEN) {
    return json({ error: "无效的管理 token" }, 401);
  }

  const cfg = await loadConfig(envVars);

  // ---- 配置查看 ----
  if (req.method === "GET" && (path === "/admin/config" || path === "/admin/config/")) {
    return json({
      ...cfg,
      gemini_key: maskKey(cfg.gemini_key),
      _hint:
        "gemini_key 已打码；保存时原样带回打码值（含 ****）即表示不修改。api_keys 为客户端鉴权 Key 列表。",
    });
  }

  // ---- 配置保存 ----
  if (req.method === "POST" && (path === "/admin/config" || path === "/admin/config/")) {
    let body: Partial<VProxyConfig> & { gemini_key?: string };
    try {
      body = (await req.json()) as Partial<VProxyConfig> & { gemini_key?: string };
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const next: VProxyConfig = {
      ...cfg,
      ...body,
    };
    // 打码保护：面板把打码值原样带回时，视为"未修改"，保留 KV 里的真实 Key
    if (typeof body.gemini_key === "string" && body.gemini_key.includes(MASK_HINT)) {
      next.gemini_key = cfg.gemini_key;
    }
    // 代理列表自动清洗：剔除 https:// 等不支持条目并去重，返回明细供面板提示
    let removedProxies: Array<{ raw: string; reason: string }> = [];
    if (Array.isArray(body.proxies)) {
      const report = cleanProxyList(body.proxies.map((x) => String(x)));
      next.proxies = report.kept;
      removedProxies = report.removed;
    }
    // 竞速参数白名单清洗（钳位防溢出）
    if (body.racing !== undefined) next.racing = sanitizeRacingConfig(body.racing);
    const normalized = { ...next, proxies: next.proxies };
    await saveConfig(envVars, normalized);
    invalidateConfigCache();
    return json({
      ok: true,
      config: { ...normalized, gemini_key: maskKey(normalized.gemini_key) },
      removed_proxies: removedProxies,
    });
  }

  // ---- 订阅刷新 ----
  if (req.method === "POST" && (path === "/admin/proxies/refresh" || path === "/admin/proxies/refresh/")) {
    if (!cfg.subscription) return json({ error: "未配置 subscription 订阅地址" }, 400);
    await envVars.VPROXY_KV.delete("proxy_cache");
    const { refreshSubscription } = await import("../proxy/proxyfetch.ts");
    const result = await refreshSubscription(envVars, cfg.subscription);
    if (!result) return json({ error: "订阅拉取失败（网络错误或返回非 200），旧缓存已清除" }, 502);
    return json({ ok: true, proxies: result.proxies.length, skipped_unsupported: result.skipped });
  }

  // ---- 代理连通性测试（单节点，写入健康度） ----
  if (req.method === "POST" && (path === "/admin/proxy/test" || path === "/admin/proxy/test/")) {
    let body: { proxy?: string };
    try {
      body = (await req.json()) as { proxy?: string };
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.proxy) return json({ error: "proxy 字段必填" }, 400);
    const { testProxy } = await import("../proxy/proxyfetch.ts");
    const r = await testProxy(body.proxy);
    if (r.ok) recordProxySuccess(body.proxy, r.latency_ms);
    else recordProxyFailure(body.proxy, r.error ?? "unreachable");
    waitUntil(flushHealthNow(envVars));
    return json(r);
  }

  // ---- 全量并发测速（写入健康度） ----
  if (req.method === "POST" && (path === "/admin/proxies/test-all" || path === "/admin/proxies/test-all/")) {
    const { resolveProxyPool } = await import("../proxy/proxyfetch.ts");
    const { testAllProxies } = await import("../proxy/racefetch.ts");
    const pool = await resolveProxyPool(envVars, cfg, waitUntil);
    if (pool.size === 0) return json({ error: "代理池为空：请先在配置页添加代理或配置订阅" }, 400);
    const results = await testAllProxies(pool, 6);
    await flushHealthNow(envVars);
    return json({
      ok: true,
      total: results.length,
      reachable: results.filter((r) => r.ok).length,
      results,
    });
  }

  // ---- 节点健康度 ----
  if (req.method === "GET" && (path === "/admin/health" || path === "/admin/health/")) {
    const now = Date.now();
    const sticky = [...healthMapSnapshot().entries()].filter(([, h]) => h.sticky).map(([uri]) => uri);
    return json({
      racing: cfg.racing,
      health: allHealthRecords(),
      avg_latency_ms: Math.round(averageLatency(healthMapSnapshot(), now)),
      sticky,
      _hint: "健康度为 isolate 内存 + KV 快照（20s 批量刷盘）；score 由成功率/延迟/连败/粘性综合计算",
    });
  }

  if (req.method === "POST" && (path === "/admin/health/reset" || path === "/admin/health/reset/")) {
    await resetHealth(envVars);
    return json({ ok: true });
  }

  // ---- 内置模型表 ----
  if (req.method === "GET" && (path === "/admin/models" || path === "/admin/models/")) {
    return json({
      chat_models: GEMINI_CHAT_MODELS,
      native_only_models: GEMINI_NATIVE_ONLY_MODELS,
      total: ALL_MODELS.length,
      aliases: cfg.model_aliases,
      disabled: cfg.disabled_models,
    });
  }

  // ---- 用量统计 ----
  if (req.method === "GET" && (path === "/admin/usage" || path === "/admin/usage/")) {
    const { listUsage, sumUsage } = await import("../usage.ts");
    const usage = await listUsage(envVars);
    return json({ usage, totals: sumUsage(usage) });
  }

  if (req.method === "POST" && (path === "/admin/usage/reset" || path === "/admin/usage/reset/")) {
    const { resetUsage } = await import("../usage.ts");
    const n = await resetUsage(envVars);
    return json({ ok: true, cleared: n });
  }

  // ---- 请求日志 ----
  if (req.method === "GET" && (path === "/admin/logs" || path === "/admin/logs/")) {
    return json({ logs: listLogs(), max: 64 });
  }

  if (req.method === "POST" && (path === "/admin/logs/clear" || path === "/admin/logs/clear/")) {
    clearLogs();
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}
