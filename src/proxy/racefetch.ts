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
import {
  DEFAULT_RACING,
  PLATFORM_TLS_FAILURE_SIGNATURE,
  breakerOnPoolFailure,
  breakerOnPoolSuccess,
  poolBreakerIsOpen,
  poolBreakerSnapshot,
  retryDelayMs,
  shouldRetryDirect,
  type RacingConfig,
} from "../racing.ts";
import {
  averageLatency,
  ensureHealthLoaded,
  flushHealthIfDue,
  flushHealthNow,
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
import { connPool } from "./connpool.ts";

export type { ProxyPool };

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// v2.2：暖连接优先 —— 池内有可用空闲连接的代理排到候选最前（保持其余相对次序不变）。
// 暖连接请求跳过 TCP/代理/TLS 全部握手，几乎必然最先胜出；无暖连接时原样返回零开销。
// v2.3：单遍扫描（旧版对每个候选调 isWarm 两次：先探测后过滤，浪费一倍扫描）。
function warmFirst<T extends { raw: string }>(cands: T[]): T[] {
  const warm: T[] = [];
  const cold: T[] = [];
  for (const c of cands) {
    (connPool.isWarm(c.raw) ? warm : cold).push(c);
  }
  return warm.length > 0 ? [...warm, ...cold] : cands;
}

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
  // v2.2：暖连接节点优先（跳过全部握手的零成本尝试）
  return warmFirst([...ok, ...cooling]);
}

let rrCursor = 0;

/** 节点内单次尝试结果 */
interface NodeAttempt {
  resp?: Response;
  error?: string;
  ms: number;
}

async function attemptOnce(p: { raw: string }, url: string, init: RequestInit): Promise<NodeAttempt> {
  const started = Date.now();
  try {
    const resp = await viaProxy(p as Parameters<typeof viaProxy>[0], url, init);
    return { resp, ms: Date.now() - started };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
  }
}

/**
 * 节点内重试（原项目 parallel_pool_retry_enabled）：
 * 网络层错误或上游 5xx 时，同一节点立即重试一次（这类失败常与出口无关）。
 * 429 不重试 —— 直接冷却该节点并接力下一个更有价值。
 */
async function retrySameNodeOnce(
  p: { raw: string },
  url: string,
  init: RequestInit,
  errors: string[],
  reason: string,
): Promise<Response | null> {
  const second = await attemptOnce(p, url, init);
  if (second.resp && second.resp.status < 400) {
    recordProxySuccess(p.raw, second.ms);
    return second.resp;
  }
  if (second.resp) {
    if (second.resp.status === 429) recordProxyRateLimit(p.raw);
    else recordProxyFailure(p.raw, "HTTP " + second.resp.status);
    errors.push("[" + p.raw + "] retry(" + reason + ") HTTP " + second.resp.status);
    void second.resp.body?.cancel().catch(() => {});
  } else {
    recordProxyFailure(p.raw, second.error ?? "retry failed");
    errors.push("[" + p.raw + "] retry(" + reason + ") " + (second.error ?? "failed"));
  }
  return null;
}

/** 顺序模式：按健康分排序后轮换，最多接力 3 个，429/5xx 也接力 */
export async function rotateUpstream(
  url: string,
  init: RequestInit,
  pool: ProxyPool,
  nodeRetry = false,
): Promise<UpstreamResult> {
  const order = healthyOrder(pool.entries);
  const maxTry = Math.min(order.length, 3);
  const errors: string[] = [];
  const retried = new Set<string>();
  const start = order.length > 0 ? rrCursor % order.length : 0;
  rrCursor = (rrCursor + 1) % Math.max(1, order.length);
  for (let i = 0; i < maxTry; i++) {
    const p = order[(start + i) % order.length];
    const r = await attemptOnce(p, url, init);
    if (r.resp && r.resp.status < 400) {
      recordProxySuccess(p.raw, r.ms);
      return { response: r.resp, via: p.raw };
    }
    if (r.resp && r.resp.status === 429) {
      recordProxyRateLimit(p.raw);
      errors.push("[" + p.raw + "] 429 Rate Limit");
      void r.resp.body?.cancel().catch(() => {});
      continue;
    }
    if (r.resp && r.resp.status >= 500) {
      recordProxyFailure(p.raw, "HTTP " + r.resp.status);
      errors.push("[" + p.raw + "] HTTP " + r.resp.status);
      void r.resp.body?.cancel().catch(() => {});
      if (nodeRetry && !retried.has(p.raw)) {
        retried.add(p.raw);
        const again = await retrySameNodeOnce(p, url, init, errors, "5xx");
        if (again) return { response: again, via: p.raw };
      }
      continue;
    }
    if (r.resp) {
      // 请求级 4xx：与代理无关，直接返回（原项目语义：不惩罚节点、不接力）
      return { response: r.resp, via: p.raw };
    }
    recordProxyFailure(p.raw, r.error ?? "network error");
    errors.push("[" + p.raw + "] " + (r.error ?? "network error"));
    if (nodeRetry && !retried.has(p.raw)) {
      retried.add(p.raw);
      const again = await retrySameNodeOnce(p, url, init, errors, "network");
      if (again) return { response: again, via: p.raw };
    }
  }
  throw new Error("all proxy attempts failed: " + errors.join(" | "));
}

// ---------- 对冲竞速模式 ----------

type AttemptKind = "ok" | "ratelimit" | "retryable" | "hard" | "aborted";

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
    // v2.3 修复：竞速败者被主动中止（signal.aborted）不是节点故障 —— 不计失败、不进冷却。
    // 旧版把「慢一点的第二名」也记一次失败：连败指数冷却（30s×2^n）会持续侵蚀
    // 健康节点，竞速越活跃全池健康度衰减越快 —— 竞速的代价转嫁给了它自己受益的健康分。
    if (signal.aborted) return { kind: "aborted", ms, error: msg };
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
  // v2.2：暖连接优先参与竞速（首个立即发出的候选优先选中零握手成本的节点）
  const candidates = warmFirst(selectCandidates(pool.entries, healthMapSnapshot(), racing, now));
  if (candidates.length <= 1) {
    // 唯一候选：直接单发（失败不接力 —— 候选表已含全部健康节点）
    if (candidates.length === 1) {
      const only = candidates[0] as { raw: string };
      const r = await attemptOnce(only, url, init);
      if (r.resp) {
        const kind = classifyStatus(r.resp.status);
        if (kind === "ok") recordProxySuccess(only.raw, r.ms);
        else if (kind === "ratelimit") recordProxyRateLimit(only.raw);
        else if (kind === "retryable") {
          recordProxyFailure(only.raw, "HTTP " + r.resp.status);
          // 节点内重试：5xx/网络抖动同节点立即再试一次
          if (racing.node_retry) {
            const again = await retrySameNodeOnce(only, url, init, [], "single-candidate");
            if (again) return { response: again, via: only.raw };
          }
        }
        return { response: r.resp, via: only.raw };
      }
      recordProxyFailure(only.raw, r.error ?? "network error");
      if (racing.node_retry) {
        const again = await retrySameNodeOnce(only, url, init, [], "single-candidate");
        if (again) return { response: again, via: only.raw };
      }
      throw new Error("upstream attempt failed: " + (r.error ?? "network error"));
    }
    return rotateUpstream(url, init, pool, racing.node_retry);
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
      // v2.3：被主动中止的败者 —— 既已定胜负，不计错误也不接力
      if (res.kind === "aborted") {
        dropResp(res.resp);
        if (settled) return;
      }
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

/** 直连 fetch（429/408/425/5xx 按 Retry-After 退避重试一次 —— v1.6.0 语义） */
async function directFetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let resp = await fetch(url, init);
  if (shouldRetryDirect(resp.status)) {
    const delay = retryDelayMs(resp.headers.get("retry-after"));
    void resp.body?.cancel().catch(() => {});
    await sleep(delay);
    resp = await fetch(url, init);
  }
  return resp;
}

/** 熔断器状态（racing.ts 持有：isolate 内存 + KV 快照同步，跨 isolate 共享） */
export { poolBreakerSnapshot };

/**
 * 统一出站 fetch：
 *   - 无代理池 / 熔断打开 → 直连（429/408/425/5xx 退避重试一次）；
 *   - 竞速关闭或池中仅 1 节点 → 健康排序轮换 + 故障接力（rotateUpstream）；
 *   - 竞速开启 → 对冲竞速（raceUpstream）；
 *   - v1.9.1：全池失败不再直接报错 —— 记入熔断器并兜底直连一次
 *     （Workers 平台 startTls 与代理隧道不兼容时保命；原项目 VPS 语义不受影响，
 *      因为 VPS 上代理池可用时本分支不会触发）。错误聚合串命中平台 TLS 签名时
 *     立即打开熔断并立即落盘 KV（其他 isolate 下一个请求即跳过死代理池）。
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
  const now = Date.now();
  const hasPool = !!pool && pool.size > 0;
  const bypassPool = !hasPool || poolBreakerIsOpen(poolBreakerSnapshot(), now);
  if (bypassPool) {
    const via = hasPool ? "direct(pool-breaker-open)" : "direct";
    const resp = await directFetchWithRetry(url, init);
    return { response: resp, via };
  }
  let result: UpstreamResult;
  try {
    if (!rc.enabled || pool!.size === 1) {
      result = await rotateUpstream(url, init, pool!, rc.node_retry);
    } else {
      result = await raceUpstream(url, init, pool!, rc, waitUntil);
    }
  } catch (err) {
    // v1.9.1：全池失败 → 熔断计数（命中平台 TLS 签名则立即打开）+ 直连兜底
    const msg = err instanceof Error ? err.message : String(err);
    const signature = PLATFORM_TLS_FAILURE_SIGNATURE.test(msg);
    const opened = breakerOnPoolFailure(signature);
    if (opened) {
      console.warn("[upstream] proxy pool exhausted (" + (signature ? "platform TLS-over-tunnel signature" : "consecutive failures") + ") — circuit breaker OPEN, direct fallback for " + "10" + "min. Last error: " + msg.slice(0, 200));
      // 立即落盘：其他 isolate 的下一个请求直接跳过死代理池（熔断打开是罕见事件，≤1次/10分钟，无写放大）
      waitUntil(flushHealthNow(env));
    }
    waitUntil(flushHealthIfDue(env));
    const resp = await directFetchWithRetry(url, init);
    return { response: resp, via: "direct(pool-fallback)" };
  }
  breakerOnPoolSuccess();
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
