// 管理端点（Bearer ADMIN_TOKEN 鉴权）+ Web 管理面板：
//   GET  /admin | /admin/panel    Web 管理面板（HTML；token 在面板登录页输入）
//   GET  /admin/config            查看配置（Gemini Key 打码）
//   POST /admin/config            覆盖保存配置（含代理链接自动清洗报告、打码 Key 保护）
//   POST /admin/proxies/refresh   强制刷新订阅
//   POST /admin/proxy/test        测试单个代理连通性 { proxy: "socks5://..." }
//   GET  /admin/models            当前模型表（含来源/元数据）
//   POST /admin/models/refresh    从官方 ListModels 重新拉取模型列表（KV 持久化，立即生效）
//   POST /admin/models/reset      恢复内置模型表
//   GET  /admin/usage             查询用量统计（KV 持久化，含聚合 totals）
//   POST /admin/usage/reset       清空用量统计
//   GET  /admin/logs              最近请求日志（内存环形缓冲）
//   POST /admin/logs/clear        清空请求日志
//   GET  /admin/health            节点健康度快照（竞速/接力依据，含竞速配置）
//   POST /admin/health/reset      清空节点健康度
//   POST /admin/proxies/test-all  并发全量测速（写入健康度，可用优先+延迟升序返回）
import { loadConfig, saveConfig, type Env } from "../config.ts";
import { json, tokensEqual } from "../convert/common.ts";
import { cleanProxyList } from "../proxy/frames.ts";
import { activeSourceInfo, activeTable, builtinTable, classifyModels, clearDynamicModels, storeDynamicModels } from "../modellist.ts";
import { geminiBase } from "../upstream.ts";
import { clearLogs, listLogs } from "../logs.ts";
import { renderPanelHtml } from "./panel.ts";
import type { VProxyConfig } from "../types.ts";
import { allHealthRecords, averageLatency, flushHealthNow, healthMapSnapshot, recordProxyFailure, recordProxySuccess, resetHealth, sanitizeRacingConfig } from "../racing.ts";
import { getMetrics, renderPrometheus } from "../metrics.ts";
import { getPromptDiagnostics, clearPromptDiagnostics } from "../promptpolicy.ts";
import { runHealthSweep, LAST_SWEEP_KEY } from "../cron.ts";

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
  if (!tokensEqual(token, envVars.ADMIN_TOKEN)) {
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
    // v1.6.0：saveConfig 已同步刷新本 isolate 缓存，无需再 invalidate（旧代码会把刚写入的缓存清掉，
    // 导致下个请求多读一次 KV）；其他 isolate 最多滞后 60s TTL。
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

  // ---- 手动触发一轮健康巡检（与 Cron 定时巡检同一实现，见 src/cron.ts） ----
  if (req.method === "POST" && (path === "/admin/health/sweep" || path === "/admin/health/sweep/")) {
    const report = await runHealthSweep(envVars, cfg).catch((e: unknown) => ({
      tested: 0,
      ok: 0,
      failed: 0,
      batch_size: 0,
      concurrency: 0,
      timeout_seconds: 0,
      duration_ms: 0,
      results: [],
      error: e instanceof Error ? e.message : String(e),
    }));
    await envVars.VPROXY_KV.put(LAST_SWEEP_KEY, String(Date.now())).catch(() => {});
    return json({ ok: true, report });
  }

  // ---- 请求指标（原项目 metrics.go 语义；?format=prometheus 返回文本格式） ----
  if (req.method === "GET" && (path === "/admin/metrics" || path === "/admin/metrics/")) {
    const snap = await getMetrics(envVars);
    const format = new URL(req.url).searchParams.get("format");
    if (format === "prometheus" || format === "prom") {
      return new Response(renderPrometheus(snap), {
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return json({ metrics: snap, prometheus: "/admin/metrics?format=prometheus" });
  }

  // ---- Claude 提示词诊断（原项目 prompt_diagnostics 语义：最近一次生成/计数记录分开保存） ----
  if (req.method === "GET" && (path === "/admin/prompt-diagnostics" || path === "/admin/prompt-diagnostics/")) {
    return json({
      generate: getPromptDiagnostics("generate"),
      count_tokens: getPromptDiagnostics("count_tokens"),
      _hint: "记录 isolate 内存中每个端点最近一次 Claude 请求的 system 处理结果（含推广/前言/规则命中数与内容指纹），重启即清",
    });
  }

  if (req.method === "POST" && (path === "/admin/prompt-diagnostics/clear" || path === "/admin/prompt-diagnostics/clear/")) {
    clearPromptDiagnostics();
    return json({ ok: true });
  }

  // ---- 模型表（当前生效：内置 / 官方动态拉取） ----
  if (req.method === "GET" && (path === "/admin/models" || path === "/admin/models/")) {
    const info = activeSourceInfo();
    const t = activeTable();
    const b = builtinTable();
    return json({
      source: info.source,
      fetched_at: info.fetched_at ?? null,
      builtin_fetched_at: b.fetched_at ?? null,
      chat_models: t.chat,
      native_only_models: t.native_only,
      excluded_models: t.excluded,
      total: info.total,
      aliases: cfg.model_aliases,
      disabled: cfg.disabled_models,
      meta: Object.fromEntries(t.meta),
    });
  }

  // ---- 从官方重新拉取模型列表（单 Key 官方 ListModels 方式，代理池可用时经代理出站） ----
  if (req.method === "POST" && (path === "/admin/models/refresh" || path === "/admin/models/refresh/")) {
    if (!cfg.gemini_key) return json({ error: "未配置上游 Gemini Key（面板配置页填写后再拉取）" }, 400);
    const { resolveProxyPool } = await import("../proxy/proxyfetch.ts");
    const { fetchOfficialModels } = await import("../proxy/modelfetch.ts");
    const pool = await resolveProxyPool(envVars, cfg, waitUntil);
    try {
      const r = await fetchOfficialModels(geminiBase(cfg), cfg.gemini_key, pool, envVars, waitUntil);
      const cls = classifyModels(r.models);
      const usable = cls.chat.length + cls.native_only.length;
      if (usable === 0) return json({ error: "官方返回 0 个可用模型（检查 Key 是否有效/是否受限地区）" }, 502);
      await storeDynamicModels(envVars, r.models, r.fetched_at);
      return json({
        ok: true,
        total: usable,
        chat: cls.chat.length,
        native_only: cls.native_only.length,
        excluded: cls.excluded.length,
        pages: r.pages,
        via: r.via,
        fetched_at: r.fetched_at,
      });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }

  // ---- 恢复内置模型表（删除 KV 动态表） ----
  if (req.method === "POST" && (path === "/admin/models/reset" || path === "/admin/models/reset/")) {
    await clearDynamicModels(envVars);
    const b = builtinTable();
    return json({ ok: true, source: "builtin", total: b.chat.length + b.native_only.length });
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
