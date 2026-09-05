// 用量统计（KV 持久化 —— 回应“CF 没有记忆”的担忧：KV 就是持久记忆）
//
// 设计要点：
//   - 免费计划 KV 写入限额 1000 次/天，逐请求写 KV 会瞬间打爆；
//   - 因此采用「isolate 内存累积 + 30 秒批量合并刷盘」策略；
//   - 极端情况下 isolate 被回收，最多丢最近 30 秒内的统计尾巴，可接受。
//
// 记录维度：每个客户端 API Key 一条，含请求数、token 数、按模型分桶、首次/最近使用时间。
import type { Env } from "./config.ts";

export interface ModelUsage {
  requests: number;
  input_tokens: number;
  output_tokens: number;
}

export interface UsageRecord {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  first_used: string; // ISO 时间
  last_used: string;
  models: Record<string, ModelUsage>;
}

const USAGE_PREFIX = "usage:";
const FLUSH_INTERVAL_MS = 25_000; // 留出 waitUntil 30s 窗口余量

// isolate 级内存缓冲：apiKey -> 累积记录
const mem = new Map<string, UsageRecord>();
let oldestPendingAt = 0;
let flushing: Promise<void> | null = null;

export function emptyRecord(): UsageRecord {
  return {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    first_used: "",
    last_used: "",
    models: {},
  };
}

export function recordUsage(
  apiKey: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): void {
  if (!apiKey) apiKey = "anonymous";
  let r = mem.get(apiKey);
  if (!r) {
    r = emptyRecord();
    r.first_used = new Date().toISOString();
    mem.set(apiKey, r);
  }
  r.requests += 1;
  r.input_tokens += inputTokens || 0;
  r.output_tokens += outputTokens || 0;
  r.last_used = new Date().toISOString();
  let m = r.models[model];
  if (!m) {
    m = { requests: 0, input_tokens: 0, output_tokens: 0 };
    r.models[model] = m;
  }
  m.requests += 1;
  m.input_tokens += inputTokens || 0;
  m.output_tokens += outputTokens || 0;
  if (oldestPendingAt === 0) oldestPendingAt = Date.now();
}

/** 每个请求收尾时调用：距离首条待刷记录超过间隔才真正写 KV（省 KV 写入额度） */
export async function flushIfDue(env: Env): Promise<void> {
  if (mem.size === 0) return;
  if (Date.now() - oldestPendingAt < FLUSH_INTERVAL_MS) return;
  await doFlush(env);
}

/** 流式请求结束后调用：等满间隔再刷（用于 ctx.waitUntil，窗口 ≤ 30s） */
export async function scheduleFlush(env: Env): Promise<void> {
  if (mem.size === 0) return;
  const wait = Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - oldestPendingAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  await doFlush(env);
}

async function doFlush(env: Env): Promise<void> {
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
  // 深拷贝当前缓冲后立刻清空，减少写入期间的并发问题
  const batch: Array<[string, UsageRecord]> = [];
  for (const [k, v] of mem.entries()) batch.push([k, structuredClone(v)]);
  mem.clear();
  oldestPendingAt = 0;
  for (const [apiKey, rec] of batch) {
    const key = USAGE_PREFIX + encodeURIComponent(apiKey);
    try {
      const prev = await env.VPROXY_KV.get(key, "json");
      const merged = mergeRecords(prev as UsageRecord | null, rec);
      await env.VPROXY_KV.put(key, JSON.stringify(merged));
    } catch {
      // KV 读写失败时把数据放回内存，等下个窗口重试
      const back = mem.get(apiKey);
      if (back) mem.set(apiKey, mergeRecords(back, rec));
      else {
        mem.set(apiKey, rec);
        if (oldestPendingAt === 0) oldestPendingAt = Date.now();
      }
    }
  }
}

export function mergeRecords(a: UsageRecord | null, b: UsageRecord): UsageRecord {
  if (!a || typeof a !== "object") return b;
  const out: UsageRecord = {
    requests: (a.requests || 0) + (b.requests || 0),
    input_tokens: (a.input_tokens || 0) + (b.input_tokens || 0),
    output_tokens: (a.output_tokens || 0) + (b.output_tokens || 0),
    first_used: a.first_used && (!b.first_used || a.first_used < b.first_used) ? a.first_used : b.first_used,
    last_used: a.last_used && a.last_used > b.last_used ? a.last_used : b.last_used,
    models: { ...(a.models || {}) },
  };
  for (const [m, u] of Object.entries(b.models || {})) {
    const t = out.models[m] || { requests: 0, input_tokens: 0, output_tokens: 0 };
    out.models[m] = {
      requests: t.requests + u.requests,
      input_tokens: t.input_tokens + u.input_tokens,
      output_tokens: t.output_tokens + u.output_tokens,
    };
  }
  return out;
}

export async function listUsage(env: Env): Promise<Record<string, UsageRecord>> {
  const out: Record<string, UsageRecord> = {};
  // 先把内存里还没刷盘的统计带出来，保证查询即时可见
  for (const [k, v] of mem.entries()) out[k] = structuredClone(v);
  let cursor: string | undefined;
  try {
    do {
      const page = await env.VPROXY_KV.list({ prefix: USAGE_PREFIX, cursor });
      for (const k of page.keys) {
        const v = await env.VPROXY_KV.get(k.name, "json");
        if (!v) continue;
        const apiKey = decodeURIComponent(k.name.slice(USAGE_PREFIX.length));
        out[apiKey] = mergeRecords(out[apiKey] ?? null, v as UsageRecord);
      }
      cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
    } while (cursor);
  } catch {
    // KV list 失败时返回内存部分
  }
  return out;
}

export async function resetUsage(env: Env): Promise<number> {
  let n = 0;
  mem.clear();
  oldestPendingAt = 0;
  let cursor: string | undefined;
  do {
    const page = await env.VPROXY_KV.list({ prefix: USAGE_PREFIX, cursor });
    for (const k of page.keys) {
      await env.VPROXY_KV.delete(k.name);
      n += 1;
    }
    cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
  } while (cursor);
  return n;
}

/** 聚合总计（面板仪表盘用） */
export function sumUsage(recs: Record<string, UsageRecord>): {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  keys: number;
  top_models: Array<{ model: string; requests: number }>;
} {
  let requests = 0;
  let input_tokens = 0;
  let output_tokens = 0;
  const models = new Map<string, number>();
  for (const r of Object.values(recs)) {
    requests += r.requests || 0;
    input_tokens += r.input_tokens || 0;
    output_tokens += r.output_tokens || 0;
    for (const [m, u] of Object.entries(r.models || {})) {
      models.set(m, (models.get(m) ?? 0) + (u.requests || 0));
    }
  }
  const top_models = [...models.entries()]
    .map(([model, n]) => ({ model, requests: n }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 8);
  return { requests, input_tokens, output_tokens, keys: Object.keys(recs).length, top_models };
}
