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
import { allHealthRecords, averageLatency, ensureHealthLoaded, flushHealthNow, healthMapSnapshot, poolBreakerSnapshot, recordProxyFailure, recordProxySuccess, resetHealth, sanitizeRacingConfig } from "../racing.ts";
import { getMetrics, renderPrometheus } from "../metrics.ts";
import { getPromptDiagnostics, clearPromptDiagnostics } from "../promptpolicy.ts";
import { runHealthSweep, LAST_SWEEP_KEY, LAST_RUN_KEY } from "../cron.ts";
import { sanitizeConfig } from "../config.ts";

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
    // v1.8.0：整体过一遍 sanitizeConfig 再落盘 —— 此前 POST body 里的未知字段会原样写进 KV
    // （读取时虽会被剥离，但 KV 会堆积脏数据），且手工构造的畸形值（如 max_n 超界）落盘后才被矫正
    const normalized = sanitizeConfig({ ...next, proxies: next.proxies });
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
    // v1.8.0：不再先删 proxy_cache —— 旧实现「先删后拉」，拉取失败时旧缓存已被清掉、
    // 代理池退回纯静态列表（可用性回退）。refreshSubscription 成功时会整体覆盖 KV，
    // 失败时保留旧缓存即可，删除步骤毫无收益。
    const { refreshSubscription } = await import("../proxy/proxyfetch.ts");
    const result = await refreshSubscription(envVars, cfg.subscription);
    if (!result) return json({ error: "订阅拉取失败（网络错误或返回非 200），旧缓存已保留待用" }, 502);
    return json({ ok: true, proxies: result.proxies.length, skipped_unsupported: result.skipped });
  }

  // ---- 代理连通性测试（单节点，写入健康度；v2.2 支持 runs=2/3 同 isolate 连测验证连接复用） ----
  if (req.method === "POST" && (path === "/admin/proxy/test" || path === "/admin/proxy/test/")) {
    let body: { proxy?: string; runs?: number };
    try {
      body = (await req.json()) as { proxy?: string; runs?: number };
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.proxy) return json({ error: "proxy 字段必填" }, 400);
    const runs = Math.min(Math.max(Number(body.runs) || 1, 1), 3);
    // v1.8.0：先 ensureHealthLoaded —— 冷启动 isolate 直接测速会以「仅含本节点」的内存表
    // flush 覆盖 KV，其余节点的历史健康度（胜出记忆/冷却/延迟 EMA）全部丢失
    await ensureHealthLoaded(envVars);
    const { testProxy } = await import("../proxy/proxyfetch.ts");
    const { connPool } = await import("../proxy/connpool.ts");
    const results = [];
    for (let i = 0; i < runs; i++) {
      const r = await testProxy(body.proxy);
      if (r.ok) recordProxySuccess(body.proxy, r.latency_ms);
      else recordProxyFailure(body.proxy, r.error ?? "unreachable");
      results.push(r);
    }
    waitUntil(flushHealthNow(envVars));
    const connStats = connPool.stats();
    return json({
      ...results[0],
      runs: results,
      conn_pool: { idle_conns: connStats.idleConns, warm_proxies: connStats.warmProxies },
      _hint: runs > 1 ? "runs 依次在同一 isolate 内执行：第 2 次起命中 Keep-Alive 暖连接（跳过 TCP/代理/TLS 握手），latency_ms 显著下降即复用生效" : undefined,
    });
  }

  // ---- 全量并发测速（写入健康度） ----
  if (req.method === "POST" && (path === "/admin/proxies/test-all" || path === "/admin/proxies/test-all/")) {
    const { resolveProxyPool } = await import("../proxy/proxyfetch.ts");
    const { testAllProxies } = await import("../proxy/racefetch.ts");
    // v1.8.0：同样先 ensureHealthLoaded（理由同单节点测试：防 KV 健康快照被部分覆盖丢失）
    await ensureHealthLoaded(envVars);
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
    // v1.8.0：先从 KV 恢复快照 —— 冷启动 isolate 直接读内存会得到空表，面板显示「暂无数据」
    await ensureHealthLoaded(envVars);
    const now = Date.now();
    const sticky = [...healthMapSnapshot().entries()].filter(([, h]) => h.sticky).map(([uri]) => uri);
    // v2.2.0：连接复用池观测（isolate 内存级；warm 连接 = 下一个请求可跳过全部握手）
    const { connPool } = await import("../proxy/connpool.ts");
    const connStats = connPool.stats();
    // v2.5.0：订阅状态（跨 isolate 的 KV 视角）+ cron 心跳 —— 面板「代理」页据此展示
    // 节点数 / 上次拉取 / 下次自动拉取倒计时，以及定时任务链路是否活着。
    let subscription: Record<string, unknown> | null = null;
    let cron_last_run_at = 0;
    let maxProxies = 1000;
    try {
      // 动态导入：proxyfetch 依赖 cloudflare:sockets，静态引入会把 Node 测试一起炸掉
      const { SUB_CACHE_KEY, MAX_PROXIES } = await import("../proxy/proxyfetch.ts");
      maxProxies = MAX_PROXIES;
      const subCache = (await envVars.VPROXY_KV.get(SUB_CACHE_KEY, "json")) as { at?: number; proxies?: unknown[]; skipped?: number } | null;
      if (subCache && Array.isArray(subCache.proxies)) {
        const intervalMs = Math.max(5, cfg.subscription_refresh_minutes) * 60_000;
        subscription = {
          configured: !!cfg.subscription,
          nodes: subCache.proxies.length,
          cached_at: typeof subCache.at === "number" ? subCache.at : 0,
          age_sec: typeof subCache.at === "number" ? Math.max(0, Math.round((now - subCache.at) / 1000)) : 0,
          next_refresh_sec: typeof subCache.at === "number" ? Math.max(0, Math.round((subCache.at + intervalMs - now) / 1000)) : 0,
          refresh_minutes: cfg.subscription_refresh_minutes,
          max_proxies: maxProxies,
        };
      }
      cron_last_run_at = Number(await envVars.VPROXY_KV.get(LAST_RUN_KEY)) || 0;
    } catch {
      // KV 读失败不阻塞健康度返回
    }
    return json({
      racing: cfg.racing,
      health: allHealthRecords(),
      avg_latency_ms: Math.round(averageLatency(healthMapSnapshot(), now)),
      sticky,
      pool_breaker: poolBreakerSnapshot(),
      conn_pool: { idle_conns: connStats.idleConns, warm_proxies: connStats.warmProxies, conns: connStats.conns },
      subscription,
      cron: { last_run_at: cron_last_run_at, heartbeat_minutes: 15 },
      _hint: "健康度为 isolate 内存 + KV 快照（20s 批量刷盘）；score 由成功率/延迟/连败/粘性综合计算。pool_breaker.open=true 时代理池被熔断，请求自动回退直连。conn_pool 为 Keep-Alive 复用池。subscription/cron 为 v2.5.0 订阅自动拉取观测（节点数上限 max_proxies；cron.last_run_at 距今 >15 分钟 = 定时任务未跑，检查 wrangler triggers）",
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

  // ---- v2.5.0：手动执行一轮定时任务（light：订阅拉取 + 保活 + 落盘 + 心跳，跳过批量巡检）
  // 用于验证 Cron 链路（尤其「订阅是否到点自动拉取」），免等下一个 cron 跳。批量巡检用 /admin/health/sweep。
  if (req.method === "POST" && (path === "/admin/cron/run" || path === "/admin/cron/run/")) {
    const { runScheduledTasks } = await import("../cron.ts");
    const report = await runScheduledTasks(envVars, { light: true }).catch((e: unknown) => ({
      error: e instanceof Error ? e.message : String(e),
    }));
    return json({ ok: true, mode: "light", report, _hint: "与 cron 每跳同一实现但跳过批量巡检：验证订阅拉取（到点才真正拉，否则 skipped_reason=cache_fresh）/保活/统计落盘。批量巡检走 /admin/health/sweep" });
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
