// 请求指标（移植自 vertex-master internal/api/metrics.go 的 requestMetrics）
//
// 原项目用 atomic 计数器 + /admin 上的 JSON 快照；Workers 化对齐：
//   - isolate 内存计数（active/total/errors/latency sum/max/status classes/protocol 分桶）；
//   - KV 单键快照持久化（isolate 冷启动先合并快照再累加），复用 usage 的 25 秒批量刷盘节奏；
//   - GET /admin/metrics 返回 JSON 快照；?format=prometheus 返回 Prometheus 文本格式。
//
// 纯逻辑部分（累加/合并/快照/Prometheus 渲染）不依赖运行时 API，可在 Node 单测中直接运行。
import type { Env } from "./config.ts";

export interface MetricsSnapshot {
  /** 在飞请求数 */
  active: number;
  total: number;
  errors: number;
  average_latency_ms: number;
  maximum_latency_ms: number;
  status: {
    informational: number; // 1xx
    successful: number; // 2xx
    redirection: number; // 3xx
    client_error: number; // 4xx
    server_error: number; // 5xx
    unknown: number;
  };
  /** 按协议分桶（openai/anthropic/gemini/admin/other） */
  protocol: Record<string, number>;
  updated_at: string;
}

export const METRICS_KEY = "metrics";
const FLUSH_INTERVAL_MS = 25_000;

interface MemState {
  active: number;
  total: number;
  errors: number;
  latency_sum_ms: number;
  latency_max_ms: number;
  statusClasses: [number, number, number, number, number, number]; // 0..5
  protocol: Record<string, number>;
  oldestPendingAt: number;
}

const mem: MemState = {
  active: 0,
  total: 0,
  errors: 0,
  latency_sum_ms: 0,
  latency_max_ms: 0,
  statusClasses: [0, 0, 0, 0, 0, 0],
  protocol: {},
  oldestPendingAt: 0,
};

let flushing: Promise<void> | null = null;

export function metricsBegin(): void {
  mem.active += 1;
  mem.total += 1;
  if (mem.oldestPendingAt === 0) mem.oldestPendingAt = Date.now();
}

export function metricsFinish(status: number, elapsedMs: number, protocol?: string): void {
  mem.active = Math.max(0, mem.active - 1);
  const cls = status >= 100 && status <= 599 ? Math.floor(status / 100) : 0;
  mem.statusClasses[cls] += 1;
  if (status >= 400) mem.errors += 1;
  const ms = Math.max(0, Math.floor(elapsedMs));
  mem.latency_sum_ms += ms;
  if (ms > mem.latency_max_ms) mem.latency_max_ms = ms;
  if (protocol) mem.protocol[protocol] = (mem.protocol[protocol] ?? 0) + 1;
}

export function snapshotMetrics(): MetricsSnapshot {
  const [unknown, informational, successful, redirection, client_error, server_error] = mem.statusClasses;
  return {
    active: mem.active,
    total: mem.total,
    errors: mem.errors,
    average_latency_ms: mem.total > 0 ? Math.round((mem.latency_sum_ms / mem.total) * 100) / 100 : 0,
    maximum_latency_ms: mem.latency_max_ms,
    status: { unknown, informational, successful, redirection, client_error, server_error },
    protocol: { ...mem.protocol },
    updated_at: new Date().toISOString(),
  };
}

/** 快照合成：KV 历史总量 + 内存未刷盘增量（active 取内存实时值） */
export function mergeSnapshots(kv: MetricsSnapshot | null | undefined, memSnap: MetricsSnapshot): MetricsSnapshot {
  if (!kv || typeof kv !== "object") return memSnap;
  const statusKeys = ["unknown", "informational", "successful", "redirection", "client_error", "server_error"] as const;
  const status: Record<string, number> = {};
  for (const k of statusKeys) status[k] = (kv.status?.[k] ?? 0) + (memSnap.status[k] ?? 0);
  const protocol: Record<string, number> = { ...(kv.protocol ?? {}) };
  for (const [p, n] of Object.entries(memSnap.protocol ?? {})) protocol[p] = (protocol[p] ?? 0) + n;
  const total = (kv.total ?? 0) + memSnap.total;
  const errors = (kv.errors ?? 0) + memSnap.errors;
  // 延迟按总量加权合并
  const kvAvg = kv.average_latency_ms ?? 0;
  const avg = total > 0 ? ((kvAvg * (kv.total ?? 0) + memSnap.average_latency_ms * memSnap.total) / total) : 0;
  return {
    active: memSnap.active,
    total,
    errors,
    average_latency_ms: Math.round(avg * 100) / 100,
    maximum_latency_ms: Math.max(kv.maximum_latency_ms ?? 0, memSnap.maximum_latency_ms),
    status: status as MetricsSnapshot["status"],
    protocol,
    updated_at: memSnap.updated_at,
  };
}

/**
 * 查询当前指标快照（KV 历史总量 + 内存未刷盘增量的合并视图）。
 * 管理面板 /admin/metrics 使用；不改变任何计数状态。
 */
export async function getMetrics(env: Env): Promise<MetricsSnapshot> {
  let kv: MetricsSnapshot | null = null;
  try {
    kv = (await env.VPROXY_KV.get(METRICS_KEY, "json")) as MetricsSnapshot | null;
  } catch {
    kv = null;
  }
  return mergeSnapshots(kv, snapshotMetrics());
}

/** 到点批量刷盘（请求收尾 waitUntil 调用） */
export async function flushMetricsIfDue(env: Env): Promise<void> {
  if (mem.oldestPendingAt === 0) return;
  if (Date.now() - mem.oldestPendingAt < FLUSH_INTERVAL_MS) return;
  await flushMetrics(env);
}

/** 强制刷盘（scheduled / 管理 API 用） */
export async function flushMetrics(env: Env): Promise<void> {
  if (flushing) {
    await flushing.catch(() => {});
    return;
  }
  flushing = doFlushInner(env).finally(() => {
    flushing = null;
  });
  await flushing.catch(() => {});
}

async function doFlushInner(env: Env): Promise<void> {
  // delta 模式：把「自上次刷盘以来的内存增量」并入 KV 总量，然后重置内存 delta。
  // active（在飞请求数）是实时值，不落盘；刷盘瞬间的并发增量误差可忽略（尽力而为语义，与原项目一致）。
  const delta = snapshotMetrics();
  try {
    const prev = (await env.VPROXY_KV.get(METRICS_KEY, "json")) as MetricsSnapshot | null;
    const merged = mergeForFlush(prev, delta);
    await env.VPROXY_KV.put(METRICS_KEY, JSON.stringify(merged));
    mem.total = 0;
    mem.errors = 0;
    mem.latency_sum_ms = 0;
    mem.latency_max_ms = 0;
    mem.statusClasses = [0, 0, 0, 0, 0, 0];
    mem.protocol = {};
    mem.oldestPendingAt = 0;
  } catch {
    // 失败保留内存待下个窗口
  }
}

/** 刷盘合并：KV 历史总量 + 内存增量快照（active 不入 KV） */
function mergeForFlush(prev: MetricsSnapshot | null, memSnap: MetricsSnapshot): MetricsSnapshot {
  if (!prev || typeof prev !== "object") return memSnap;
  const statusKeys = ["unknown", "informational", "successful", "redirection", "client_error", "server_error"] as const;
  const status: Record<string, number> = {};
  for (const k of statusKeys) {
    status[k] = (prev.status?.[k] ?? 0) + (memSnap.status[k] ?? 0);
  }
  const protocol: Record<string, number> = { ...(prev.protocol ?? {}) };
  for (const [p, n] of Object.entries(memSnap.protocol ?? {})) protocol[p] = (protocol[p] ?? 0) + n;
  const total = (prev.total ?? 0) + memSnap.total;
  const errors = (prev.errors ?? 0) + memSnap.errors;
  const kvAvg = prev.average_latency_ms ?? 0;
  const avg = total > 0 ? ((kvAvg * (prev.total ?? 0) + memSnap.average_latency_ms * memSnap.total) / total) : 0;
  return {
    active: 0,
    total,
    errors,
    average_latency_ms: Math.round(avg * 100) / 100,
    maximum_latency_ms: Math.max(prev.maximum_latency_ms ?? 0, memSnap.maximum_latency_ms),
    status: status as MetricsSnapshot["status"],
    protocol,
    updated_at: memSnap.updated_at,
  };
}

// ---------- Prometheus 文本格式 ----------

const PROM_STATUS_LABEL: Record<string, string> = {
  unknown: "unknown",
  informational: "1xx",
  successful: "2xx",
  redirection: "3xx",
  client_error: "4xx",
  server_error: "5xx",
};

/** 渲染 Prometheus exposition 文本（移植原项目 metrics 快照语义） */
export function renderPrometheus(s: MetricsSnapshot): string {
  const lines: string[] = [];
  const emit = (name: string, mtype: string, help: string, value: string | number, labels = "") => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${mtype}`);
    lines.push(`${name}${labels} ${value}`);
  };
  emit("cfvproxy_requests_active", "gauge", "In-flight requests.", s.active);
  emit("cfvproxy_requests_total", "counter", "Total requests handled.", s.total);
  emit("cfvproxy_request_errors_total", "counter", "Total requests answered with 4xx/5xx.", s.errors);
  emit("cfvproxy_request_latency_avg_ms", "gauge", "Average request latency in milliseconds.", s.average_latency_ms);
  emit("cfvproxy_request_latency_max_ms", "gauge", "Maximum request latency in milliseconds.", s.maximum_latency_ms);
  for (const [k, v] of Object.entries(s.status ?? {})) {
    emit("cfvproxy_requests_status_total", "counter", "Requests by HTTP status class.", v, `{status="${PROM_STATUS_LABEL[k] ?? k}"}`);
  }
  for (const [p, v] of Object.entries(s.protocol ?? {})) {
    emit("cfvproxy_requests_protocol_total", "counter", "Requests by protocol family.", v, `{protocol="${p}"}`);
  }
  return lines.join("\n") + "\n";
}

// ---------- 测试辅助 ----------

/** 重置内存计数（仅测试用） */
export function resetMetricsForTest(): void {
  mem.active = 0;
  mem.total = 0;
  mem.errors = 0;
  mem.latency_sum_ms = 0;
  mem.latency_max_ms = 0;
  mem.statusClasses = [0, 0, 0, 0, 0, 0];
  mem.protocol = {};
  mem.oldestPendingAt = 0;
}
