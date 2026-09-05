// 对冲竞速引擎（Hedge Racing）—— 移植自 vertex-master race_engine.go 的 Workers 版编排。
// 纯逻辑（健康度/评分/候选选择）在 src/racing.ts；本文件负责 Promise 竞速编排，
// import 了 "cloudflare:sockets"（经由 proxyfetch.ts），只能在 Workers 运行时加载。
//
// 行为对齐原项目：
//   - 首个候选立即发出，之后每隔 hedge_delay_ms（或动态平均延迟）追加下一个候选，
//     在飞数不超过 max_concurrent；
//   - 任一候选拿到可用响应（2xx/3xx）即胜出，立即中止其余候选（AbortController 关闭底层 socket）；
//   - 429 → 记录限流冷却（30s）+ 驱逐粘性，继续竞速（原项目 ratelimit 语义）；
//   - 5xx / 连接失败 / 握手失败 → 记录失败连败冷却，立即极速接力下一候选；
//   - 其它 4xx（400/401/403 等）→ 请求级硬错误，与代理无关：直接返回该响应且不惩罚节点
//     （对齐原项目「非重试错误不计入代理健康」）；
//   - 全部候选失败 → 返回最后一个上游错误响应（交由上层映射协议错误），或抛出聚合错误。
//
// 关闭竞速时退回「健康分排序 + 轮换 + 故障接力」的顺序模式（rotateUpstream）。
import type { Env } from "../config.ts";
import { DEFAULT_RACING, type RacingConfig } from "../racing.ts";
import {
  averageLatency,
  ensureHealthLoaded,
  flushHealthIfDue,
  healthMapSnapshot,
  healthScore,
  isCooling,
  proxyHealth,
  recordProxyFailure,
  recordProxyRateLimit,
  recordProxySuccess,
  selectCandidates,
} from "../racing.ts";
import { viaProxy, type ProxyPool } from "./proxyfetch.ts";

export type { ProxyPool };

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface UpstreamResult {
  response: Response;
  via: string;
}

// ---------- 健康感知的轮换顺序模式 ----------

function healthyOrder(entries: ProxyPool["entries"]): ProxyPool["entries"] {
  const now = Date.now();
  const ok = entries.filter((e) => !isCooling(proxyHealth(e.raw), now));
  const cooling = entries.filter((e) => isCooling(proxyHealth(e.raw), now));
  const score = (e: { raw: string }) => healthScore(proxyHealth(e.raw), now);
  ok.sort((a, b) => score(b) - score(a));
  return [...ok, ...cooling];
}

let rrCursor = 0;

/** 顺序模式：按健康分排序后轮换，最多接力 3 个，429/5xx 也接力 */
export async function rotateUpstream(
  url: string,
  init: RequestInit,
  pool: ProxyPool,
): Promise<UpstreamResult> {
  const order = healthyOrder(pool.entries);
  const maxTry = Math.min(order.length, 3);
  const errors: string[] = [];
  const start = order.length > 0 ? rrCursor % order.length : 0;
  rrCursor = (rrCursor + 1) % Math.max(1, order.length);
  for (let i = 0; i < maxTry; i++) {
    const p = order[(start + i) % order.length];
    const started = Date.now();
    try {
      const resp = await viaProxy(p, url, init);
      if (resp.status === 429) {
        recordProxyRateLimit(p.raw);
        errors.push("[" + p.raw + "] 429 Rate Limit");
        void resp.body?.cancel().catch(() => {});
        continue;
      }
      if (resp.status >= 500) {
        recordProxyFailure(p.raw, "HTTP " + resp.status);
        errors.push("[" + p.raw + "] HTTP " + resp.status);
        void resp.body?.cancel().catch(() => {});
        continue;
      }
      recordProxySuccess(p.raw, Date.now() - started);
      return { response: resp, via: p.raw };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordProxyFailure(p.raw, msg);
      errors.push("[" + p.raw + "] " + msg);
    }
  }
  throw new Error("all proxy attempts failed: " + errors.join(" | "));
}

// ---------- 对冲竞速模式 ----------

type AttemptKind = "ok" | "ratelimit" | "retryable" | "hard";

interface AttemptResult {
  kind: AttemptKind;
  resp?: Response;
  ms: number;
  error?: string;
}

function classifyStatus(status: number): AttemptKind {
  if (status < 400) return "ok";
  if (status === 429) return "ratelimit";
  if (status >= 500 || status === 408 || status === 425) return "retryable";
  return "hard"; // 请求级 4xx：与代理无关
}

async function runAttempt(p: { raw: string }, url: string, init: RequestInit, signal: AbortSignal): Promise<AttemptResult> {
  const started = Date.now();
  try {
    const resp = await viaProxy(p as Parameters<typeof viaProxy>[0], url, init, signal);
    const ms = Date.now() - started;
    const kind = classifyStatus(resp.status);
    if (kind === "ok") recordProxySuccess(p.raw, ms);
    else if (kind === "ratelimit") recordProxyRateLimit(p.raw);
    else if (kind === "retryable") recordProxyFailure(p.raw, "HTTP " + resp.status);
    return { kind, resp, ms };
  } catch (err) {
    const ms = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    recordProxyFailure(p.raw, msg);
    return { kind: "retryable", ms, error: msg };
  }
}

/** 对冲竞速：首胜即停，败者中止；健康度记录随竞速自动进行 */
export async function raceUpstream(
  url: string,
  init: RequestInit,
  pool: ProxyPool,
  racing: RacingConfig,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<UpstreamResult> {
  const now = Date.now();
  const candidates = selectCandidates(pool.entries, healthMapSnapshot(), racing, now);
  if (candidates.length <= 1) {
    // 唯一候选：直接单发（失败不接力 —— 候选表已含全部健康节点）
    if (candidates.length === 1) {
      const started = Date.now();
      const resp = await viaProxy(candidates[0] as Parameters<typeof viaProxy>[0], url, init);
      const ms = Date.now() - started;
      const kind = classifyStatus(resp.status);
      if (kind === "ok") recordProxySuccess(candidates[0].raw, ms);
      else if (kind === "ratelimit") recordProxyRateLimit(candidates[0].raw);
      else if (kind === "retryable") recordProxyFailure(candidates[0].raw, "HTTP " + resp.status);
      return { response: resp, via: candidates[0].raw };
    }
    return rotateUpstream(url, init, pool);
  }

  const hedge = racing.dynamic_delay
    ? clampNum(averageLatency(healthMapSnapshot(), now), 100, 10_000)
    : racing.hedge_delay_ms;

  return new Promise<UpstreamResult>((resolve, reject) => {
    let nextIdx = 0;
    let active = 0;
    let settled = false;
    let lastResp: Response | null = null;
    let lastVia = "race";
    const errors: string[] = [];
    const controllers = new Map<string, AbortController>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanupTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanupTimer();
      fn();
    };
    const abortLosers = () => {
      for (const [, ac] of controllers) {
        try {
          ac.abort();
        } catch {
          // ignore
        }
      }
      controllers.clear();
    };

    const launch = (): boolean => {
      if (settled) return false;
      if (nextIdx >= candidates.length) return false;
      if (active >= racing.max_concurrent) return false;
      const p = candidates[nextIdx++];
      const ac = new AbortController();
      controllers.set(p.raw, ac);
      active++;
      runAttempt(p, url, init, ac.signal)
        .then((res) => onResult(p, res))
        .catch((err) => onResult(p, { kind: "retryable", ms: 0, error: err instanceof Error ? err.message : String(err) }));
      return true;
    };

    const scheduleHedge = () => {
      cleanupTimer();
      if (nextIdx < candidates.length && active < racing.max_concurrent) {
        timer = setTimeout(() => {
          if (launch()) scheduleHedge();
        }, hedge);
      }
    };

    const dropResp = (resp: Response | null | undefined) => {
      if (resp) void resp.body?.cancel().catch(() => {});
    };

    const onResult = (p: { raw: string }, res: AttemptResult) => {
      active--;
      controllers.delete(p.raw);
      if (settled) {
        // 败者迟到：主动释放其响应体与底层 socket
        dropResp(res.resp);
        return;
      }
      if (res.error) errors.push("[" + p.raw + "] " + res.error);

      if (res.kind === "ok") {
        abortLosers();
        finish(() => resolve({ response: res.resp!, via: p.raw }));
        return;
      }
      if (res.kind === "hard") {
        // 请求级 4xx：与代理无关，立即返回（不计惩罚，已在 runAttempt 跳过记录）
        abortLosers();
        finish(() => resolve({ response: res.resp!, via: p.raw }));
        return;
      }

      // ratelimit / retryable：极速接力
      if (res.resp) {
        dropResp(lastResp);
        lastResp = res.resp;
        lastVia = p.raw;
      }
      launch();
      scheduleHedge();
      if (active === 0 && nextIdx >= candidates.length) {
        const resp = lastResp;
        const via = lastVia;
        const errs = errors.join(" | ");
        finish(() => {
          if (resp) resolve({ response: resp, via });
          else reject(new Error("race: all " + candidates.length + " candidates failed: " + errs));
        });
      }
    };

    launch();
    scheduleHedge();
    void waitUntil;
  });
}

// ---------- 统一出站入口 ----------

/**
 * 统一出站 fetch：
 *   - 无代理池 → 直连；
 *   - 竞速关闭或池中仅 1 节点 → 健康排序轮换 + 故障接力（rotateUpstream）；
 *   - 竞速开启 → 对冲竞速（raceUpstream）。
 * 健康度快照冷启动恢复只发生一次；请求结束后按需批量刷盘 KV。
 */
export async function dispatchUpstream(
  url: string,
  init: RequestInit,
  pool: ProxyPool | null,
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  racing?: RacingConfig,
): Promise<UpstreamResult> {
  await ensureHealthLoaded(env);
  const rc = racing ?? DEFAULT_RACING;
  if (!pool || pool.size === 0) {
    const resp = await fetch(url, init);
    return { response: resp, via: "direct" };
  }
  let result: UpstreamResult;
  if (!rc.enabled || pool.size === 1) {
    result = await rotateUpstream(url, init, pool);
  } else {
    result = await raceUpstream(url, init, pool, rc, waitUntil);
  }
  waitUntil(flushHealthIfDue(env));
  return result;
}

// ---------- 全量测速（管理面板用） ----------

/** 并发测速全部节点（默认并发 6），结果按「可用优先 + 延迟升序」排序，健康度即时落盘 */
export async function testAllProxies(
  pool: ProxyPool,
  concurrency = 6,
): Promise<Array<{ proxy: string; kind: string; ok: boolean; latency_ms: number; error?: string }>> {
  const { testProxy } = await import("./proxyfetch.ts");
  const entries = pool.entries;
  const out: Array<{ proxy: string; kind: string; ok: boolean; latency_ms: number; error?: string }> = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++;
      if (idx >= entries.length) return;
      const e = entries[idx];
      const r = await testProxy(e.raw);
      if (r.ok) recordProxySuccess(e.raw, r.latency_ms);
      else recordProxyFailure(e.raw, r.error ?? "unreachable");
      out.push({ proxy: e.raw, kind: e.kind, ok: r.ok, latency_ms: r.latency_ms, error: r.error });
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, entries.length)) }, worker));
  return out.sort((a, b) => (a.ok === b.ok ? a.latency_ms - b.latency_ms : a.ok ? -1 : 1));
}
