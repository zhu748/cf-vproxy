// Cron Triggers 定时任务（移植自 vertex-master 的 keepalive/service.go 与代理健康巡检）
//
// 原项目行为对齐：
//   - keepalive（service.go）：按 keepalive_interval 秒周期 GET keepalive_url，首次立即发送，30s 超时；
//   - 健康巡检（proxy_health_check_*）：每 interval_minutes 分钟，最多测 batch_size 个代理，
//     并发 concurrency，单个超时 timeout_seconds，失败进入冷却（复用健康存储 RecordTest 语义）；
//   - 订阅差异更新：原项目每 60 分钟主动拉订阅；这里在每次 cron 触发时强制刷新订阅缓存。
//
// Workers 化：全部由 wrangler.jsonc 的 triggers.crons 驱动（scheduled 事件），
// "到点判断" 用 KV 时间戳（cron:last_*），使 keepalive_interval / interval_minutes
// 与 cron 表达式解耦（cron 只负责心跳，实际节奏由配置决定）。
import type { Env } from "./config.ts";
import { loadConfig } from "./config.ts";
import { resolveProxyPool, refreshSubscription, testProxy } from "./proxy/proxyfetch.ts";
import { recordProxySuccess, recordProxyFailure, flushHealthNow, ensureHealthLoaded, sweepDue, keepaliveDue } from "./racing.ts";
import { flushMetrics } from "./metrics.ts";

export const LAST_SWEEP_KEY = "cron:last_sweep_at";
export const LAST_KEEPALIVE_KEY = "cron:last_keepalive_at";

const KEEPALIVE_TIMEOUT_MS = 30_000; // 对齐原项目 requestTimeout
// sweepDue / keepaliveDue 纯逻辑判定在 src/racing.ts（无 Workers 依赖，可单测）；此处 re-export
export { sweepDue, keepaliveDue };

// ---------- 巡检执行 ----------

export interface SweepReport {
  tested: number;
  ok: number;
  failed: number;
  batch_size: number;
  concurrency: number;
  timeout_seconds: number;
  duration_ms: number;
  results: Array<{ proxy: string; kind: string; ok: boolean; latency_ms: number; error?: string }>;
}

/**
 * 执行一轮健康巡检（原项目 proxy_health_check 语义）：
 *   节点来源 = 手动列表 + 订阅缓存（不主动触发订阅刷新，由订阅刷新步骤负责）；
 *   每轮最多 batch_size 个（免费计划单次调用 50 子请求上限，batch 与 KV 读写共享额度）；
 *   并发 concurrency，单个超时 timeout_seconds；结果写入健康存储并立即落盘。
 */
export async function runHealthSweep(env: Env, cfg: Awaited<ReturnType<typeof loadConfig>>, opts?: { batchSize?: number; concurrency?: number; timeoutSeconds?: number }): Promise<SweepReport> {
  const hc = cfg.health_check;
  const batchSize = Math.min(opts?.batchSize ?? hc.batch_size, 40);
  const concurrency = Math.min(opts?.concurrency ?? hc.concurrency, 10);
  const timeoutSeconds = opts?.timeoutSeconds ?? hc.timeout_seconds;
  const started = Date.now();

  const pool = await resolveProxyPool(env, cfg, () => {});
  await ensureHealthLoaded(env);
  const entries = pool.entries.slice(0, batchSize);

  const results: SweepReport["results"] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++;
      if (idx >= entries.length) return;
      const e = entries[idx];
      const r = await testProxy(e.raw, timeoutSeconds * 1000);
      // 对齐原项目巡检行为：结果计入健康存储（成功刷新延迟分；失败进入指数冷却）
      if (r.ok) recordProxySuccess(e.raw, r.latency_ms);
      else recordProxyFailure(e.raw, r.error ?? "unreachable");
      results.push({ proxy: e.raw, kind: e.kind, ok: r.ok, latency_ms: r.latency_ms, error: r.error });
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, entries.length)) }, worker));
  await flushHealthNow(env).catch(() => {});

  return {
    tested: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    batch_size: batchSize,
    concurrency,
    timeout_seconds: timeoutSeconds,
    duration_ms: Date.now() - started,
    results: results.sort((a, b) => (a.ok === b.ok ? a.latency_ms - b.latency_ms : a.ok ? -1 : 1)),
  };
}

// ---------- 定时任务总入口 ----------

export interface ScheduledReport {
  sweep: SweepReport | null;
  sweep_skipped: boolean;
  keepalive: { url: string; status: number | null; error?: string } | null;
  subscription: { refreshed: boolean; proxies?: number; skipped?: number } | null;
}

/** scheduled 事件入口：健康巡检 + 订阅刷新 + keepalive ping + 统计落盘 */
export async function runScheduledTasks(env: Env): Promise<ScheduledReport> {
  const cfg = await loadConfig(env, true);
  const now = Date.now();
  const report: ScheduledReport = { sweep: null, sweep_skipped: false, keepalive: null, subscription: null };

  // 1. 健康巡检（KV 时间戳控制节奏）
  let lastSweepAt = 0;
  try {
    lastSweepAt = Number(await env.VPROXY_KV.get(LAST_SWEEP_KEY)) || 0;
  } catch {
    lastSweepAt = 0;
  }
  if (sweepDue(cfg, lastSweepAt, now)) {
    report.sweep = await runHealthSweep(env, cfg).catch(() => null);
    await env.VPROXY_KV.put(LAST_SWEEP_KEY, String(now)).catch(() => {});
  } else {
    report.sweep_skipped = true;
  }

  // 2. 订阅主动刷新（对齐原项目定时差异更新；失败不阻塞）
  if (cfg.subscription) {
    const cache = await refreshSubscription(env, cfg.subscription).catch(() => null);
    report.subscription = cache ? { refreshed: true, proxies: cache.proxies.length, skipped: cache.skipped } : { refreshed: false };
  }

  // 3. keepalive ping（首次立即发送，对齐原项目 Start 行为）
  let lastKeepaliveAt = 0;
  try {
    lastKeepaliveAt = Number(await env.VPROXY_KV.get(LAST_KEEPALIVE_KEY)) || 0;
  } catch {
    lastKeepaliveAt = 0;
  }
  if (keepaliveDue(cfg.keepalive_url, cfg.keepalive_interval, lastKeepaliveAt, now)) {
    let status: number | null = null;
    let error: string | undefined;
    try {
      const resp = await fetch(cfg.keepalive_url, {
        method: "GET",
        signal: AbortSignal.timeout(KEEPALIVE_TIMEOUT_MS),
        headers: { "User-Agent": "cf-vproxy-keepalive/1.0" },
      });
      status = resp.status;
      await resp.body?.cancel().catch(() => {});
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    report.keepalive = { url: cfg.keepalive_url, status, error };
    await env.VPROXY_KV.put(LAST_KEEPALIVE_KEY, String(now)).catch(() => {});
  }

  // 4. 顺手落盘统计（省一个窗口）
  await flushMetrics(env).catch(() => {});
  return report;
}
