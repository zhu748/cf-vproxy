// 并发竞速与节点健康度 —— 移植自 vertex-master 的对冲竞速引擎（race_engine.go）
// 与节点健康存储（nodes/store.go 健康评分/冷却/衰减 + sticky.go 粘性池）。
//
// Workers 化裁剪：
//   - 原项目 SQLite 持久化 → KV 快照（isolate 内存累积 + 20 秒批量刷盘，规避免费计划 1000 写/天）；
//   - 原项目 goroutine 竞速 → Promise 竞速（编排见 proxy/racefetch.ts，本文件只放纯逻辑）；
//   - 健康语义与原项目对齐：
//       * 连败指数冷却 30s * 2^(n-1)，封顶 30 分钟（RecordTest）；
//       * 429 固定 30 秒冷却并递增计次，重复 429 自然降权（RecordRateLimit）；
//       * 计数衰减防溢出（decayHealthCounters）；
//       * 粘性池：竞速胜出节点优先复用，触发限流/连败即驱逐（StickyNodePool）；
//       * 未测试节点只给少量探索名额，不能压过已验证节点（SelectForParallel）；
//       * 冷却节点垫底兜底，仅在无可用节点时启用。
//
// ⚠️ 本文件不 import "cloudflare:sockets"，可在 Node 单测中直接运行；
//    KV 仅为鸭子类型读写（测试可注入假 KV）。
import type { Env } from "./config.ts";

// ---------- 竞速配置 ----------

export interface RacingConfig {
  /** 是否启用并发竞速；关闭时退回「健康排序 + 轮换 + 故障接力」模式 */
  enabled: boolean;
  /** 参与竞速的已验证候选上限（按健康分取前 K） */
  top_k: number;
  /** 同时在飞的竞速请求数上限 */
  max_concurrent: number;
  /** 对冲延迟（毫秒）：首个节点发出后，每隔该时间追加下一个候选 */
  hedge_delay_ms: number;
  /** 动态对冲：用全体健康节点的平均延迟作为对冲间隔 */
  dynamic_delay: boolean;
  /** 单个请求最多尝试的节点数（Workers 子请求限额保护） */
  max_attempts: number;
  /** 节点内重试（原项目 parallel_pool_retry_enabled）：网络/5xx 错误时同一节点立即重试一次；429 仍直接冷却换节点 */
  node_retry: boolean;
}

export const DEFAULT_RACING: RacingConfig = {
  enabled: true,
  top_k: 6,
  max_concurrent: 3,
  hedge_delay_ms: 1000,
  dynamic_delay: false,
  max_attempts: 8,
  node_retry: true,
};

// ---------- 定时健康巡检（原项目 proxy_health_check_*，Workers 用 Cron Triggers 驱动） ----------

export interface HealthCheckConfig {
  /** 是否启用定时健康巡检（需在 wrangler.jsonc 配置 triggers.crons） */
  enabled: boolean;
  /** 巡检间隔（分钟，对齐原项目 interval_minutes 默认 15） */
  interval_minutes: number;
  /** 每轮巡检最多测试的代理数（免费计划单次调用 50 子请求上限，默认 40 留余量） */
  batch_size: number;
  /** 巡检并发数 */
  concurrency: number;
  /** 单个代理巡检超时（秒） */
  timeout_seconds: number;
}

export const DEFAULT_HEALTH_CHECK: HealthCheckConfig = {
  enabled: true,
  interval_minutes: 15,
  batch_size: 40,
  concurrency: 5,
  timeout_seconds: 8,
};

export function sanitizeHealthCheckConfig(raw: unknown): HealthCheckConfig {
  const d = raw && typeof raw === "object" ? (raw as Partial<HealthCheckConfig>) : {};
  return {
    enabled: d.enabled === undefined ? DEFAULT_HEALTH_CHECK.enabled : !!d.enabled,
    interval_minutes: clampInt(d.interval_minutes, DEFAULT_HEALTH_CHECK.interval_minutes, 5, 1440),
    batch_size: clampInt(d.batch_size, DEFAULT_HEALTH_CHECK.batch_size, 1, 40),
    concurrency: clampInt(d.concurrency, DEFAULT_HEALTH_CHECK.concurrency, 1, 10),
    timeout_seconds: clampInt(d.timeout_seconds, DEFAULT_HEALTH_CHECK.timeout_seconds, 2, 30),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(clamp(n, lo, hi)) : def;
}

export function sanitizeRacingConfig(raw: unknown): RacingConfig {
  const d = raw && typeof raw === "object" ? (raw as Partial<RacingConfig>) : {};
  return {
    enabled: d.enabled === undefined ? DEFAULT_RACING.enabled : !!d.enabled,
    top_k: clampInt(d.top_k, DEFAULT_RACING.top_k, 1, 16),
    max_concurrent: clampInt(d.max_concurrent, DEFAULT_RACING.max_concurrent, 1, 6),
    hedge_delay_ms: clampInt(d.hedge_delay_ms, DEFAULT_RACING.hedge_delay_ms, 100, 10_000),
    dynamic_delay: !!d.dynamic_delay,
    max_attempts: clampInt(d.max_attempts, DEFAULT_RACING.max_attempts, 1, 20),
    node_retry: d.node_retry === undefined ? DEFAULT_RACING.node_retry : !!d.node_retry,
  };
}

// ---------- 定时任务纯逻辑判定（供 cron.ts 与单测使用；racing.ts 无 Workers 依赖） ----------

/** 是否该跑健康巡检：开关开启 且（从未巡检过 或 距上次 ≥ interval 分钟） */
export function sweepDue(
  cfg: { health_check: { enabled: boolean; interval_minutes: number } },
  lastSweepAt: number,
  now: number,
): boolean {
  if (!cfg.health_check.enabled) return false;
  if (!lastSweepAt) return true;
  return now - lastSweepAt >= cfg.health_check.interval_minutes * 60_000;
}

/** 是否该发保活：URL 非空 且（从未发过（首次立即发，对齐原项目）或 距上次 ≥ interval 秒） */
export function keepaliveDue(keepaliveUrl: string, keepaliveIntervalSec: number, lastAt: number, now: number): boolean {
  if (!keepaliveUrl) return false;
  const interval = Math.max(5, keepaliveIntervalSec) * 1000;
  if (!lastAt) return true;
  return now - lastAt >= interval;
}

/** 是否该主动刷新订阅（v1.8.0）：从未拉过 或 缓存距上次拉取 ≥ refresh 分钟。
 *  此前 cron 每跳（15 分钟）都无条件拉订阅 + 写 KV —— 无视 subscription_refresh_minutes，
 *  免费计划每天白耗 ~96 次 KV 写与 96 次订阅出站请求。 */
export function subscriptionDue(cacheAt: number, refreshMinutes: number, now: number): boolean {
  if (!cacheAt) return true;
  const interval = Math.max(5, refreshMinutes) * 60_000;
  return now - cacheAt >= interval;
}

// ---------- 健康记录 ----------

export interface ProxyHealth {
  success: number;
  fail: number;
  consec_fail: number;
  /** 最近一次成功请求延迟（毫秒） */
  last_ms: number;
  /** 成功延迟的指数移动平均 */
  avg_ms: number;
  last_error: string;
  last_success_at: number; // epoch 秒
  last_fail_at: number; // epoch 秒
  cooldown_until: number; // epoch 秒
  rate_limit_count: number;
  /** 粘性标记：近期竞速胜出节点 */
  sticky: boolean;
}

export function emptyHealth(): ProxyHealth {
  return {
    success: 0,
    fail: 0,
    consec_fail: 0,
    last_ms: 0,
    avg_ms: 0,
    last_error: "",
    last_success_at: 0,
    last_fail_at: 0,
    cooldown_until: 0,
    rate_limit_count: 0,
    sticky: false,
  };
}

/** 连败指数冷却：30s * 2^(n-1)，封顶 30 分钟（对齐原项目 RecordTest） */
export function cooldownSecondsFor(consecFail: number): number {
  const n = Math.max(1, consecFail);
  return Math.min(1800, 30 * Math.pow(2, Math.min(n - 1, 6)));
}

export const RATE_LIMIT_COOLDOWN_SEC = 30;

/** 计数衰减：量大时对半，防止长期运行后成功率失真（对齐原项目 decayHealthCounters） */
function decayCounters(h: ProxyHealth): void {
  if (h.success <= 1000 && h.fail <= 200) return;
  h.success = Math.floor(h.success / 2);
  h.fail = Math.floor(h.fail / 2);
}

/**
 * 节点健康分（越高越优先）：
 *   - 未测试节点固定 80 分（探索档，永远排在已验证节点之后）；
 *   - 已验证节点 = 60 基础分 + 20*成功率 + 延迟加分(0~20) - 8*连败(封顶5) + 粘性加分15。
 */
export function healthScore(h: ProxyHealth | undefined, now: number): number {
  if (isCooling(h, now)) return 0; // 冷却中（防御：优先于未测试判断）
  if (!h || (h.last_success_at === 0 && h.last_fail_at === 0)) return 80; // 未测试
  const total = h.success + h.fail;
  const rate = total > 0 ? h.success / total : 0;
  const latencyBonus = clamp(20 - h.avg_ms / 50, 0, 20); // 1000ms+ → 0 分，0ms → 20 分
  const failPenalty = 8 * Math.min(h.consec_fail, 5);
  const stickyBonus = h.sticky ? 15 : 0;
  return 60 + 20 * rate + latencyBonus - failPenalty + stickyBonus;
}

export function isCooling(h: ProxyHealth | undefined, now: number): boolean {
  return !!h && h.cooldown_until * 1000 > now;
}

// ---------- 竞速候选选择（纯函数，供单测与 racefetch 使用） ----------

export interface CandidateLike {
  raw: string;
}

/**
 * 选择竞速候选（对齐原项目 SelectForParallel 语义）：
 *   1. 已验证且未冷却的节点按健康分降序取前 top_k；
 *   2. 未测试节点最多给 2 个探索名额（排在已验证节点之后）；
 *   3. 冷却节点按「最早恢复」排序垫底兜底；
 *   4. 总数不超过 max_attempts。
 */
export function selectCandidates<T extends CandidateLike>(
  entries: T[],
  healthMap: Map<string, ProxyHealth>,
  cfg: RacingConfig,
  now: number,
): T[] {
  const verified: Array<{ e: T; score: number }> = [];
  const untested: T[] = [];
  const cooling: Array<{ e: T; recoverAt: number }> = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.raw)) continue;
    seen.add(e.raw);
    const h = healthMap.get(e.raw);
    if (isCooling(h, now)) {
      cooling.push({ e, recoverAt: h!.cooldown_until });
      continue;
    }
    if (!h || (h.last_success_at === 0 && h.last_fail_at === 0)) {
      untested.push(e);
      continue;
    }
    verified.push({ e, score: healthScore(h, now) });
  }
  verified.sort((a, b) => b.score - a.score);
  cooling.sort((a, b) => a.recoverAt - b.recoverAt);

  const out: T[] = [];
  const cap = Math.max(1, cfg.max_attempts);
  for (const v of verified) {
    if (out.length >= Math.min(cap, Math.max(1, cfg.top_k))) break;
    out.push(v.e);
  }
  for (const u of untested) {
    if (out.length >= Math.min(cap, Math.max(1, cfg.top_k) + 2)) break; // 最多 2 个探索名额
    out.push(u);
  }
  if (out.length === 0) {
    // 全部冷却：让最早恢复的节点兜底，避免直接放弃
    for (const c of cooling) {
      if (out.length >= cap) break;
      out.push(c.e);
    }
  }
  return out.slice(0, cap);
}

/** 全体健康节点平均延迟（动态对冲用）；无数据时 500ms（对齐原项目 GetAverageLatency） */
export function averageLatency(healthMap: Map<string, ProxyHealth>, now: number): number {
  let sum = 0;
  let count = 0;
  for (const h of healthMap.values()) {
    if (h.avg_ms > 0 && !isCooling(h, now)) {
      sum += h.avg_ms;
      count++;
    }
  }
  return count === 0 ? 500 : sum / count;
}

/** v1.9.0：巡检选点 —— 「最久未测优先」轮转。
 * 旧版固定 `slice(0, batch)` 只反复测池子头部节点：200 节点的池子后 160 个
 * 永远不会被巡检探索（若头部 40 个全坏，巡检就永远因在死节点上）。
 * 现在按 max(last_success_at, last_fail_at) 升序排（未测试 = 0 最优先），
 * 数轮巡检即可全池轮转覆盖；同时间戳保持池子原顺序（稳定排序）。 */
export function leastRecentlyTestedOrder<T extends CandidateLike>(
  entries: T[],
  healthMap: Map<string, ProxyHealth>,
): T[] {
  const lastTested = (e: T): number => {
    const h = healthMap.get(e.raw);
    if (!h) return 0;
    return Math.max(h.last_success_at, h.last_fail_at);
  };
  return [...entries].sort((a, b) => lastTested(a) - lastTested(b));
}

// ---------- 代理池平台级熔断（v1.9.1，纯逻辑） ----------

/**
 * Workers 平台适配：cloudflare:sockets 的 startTls() 无法在已承载代理握手流量的
 * socket 上完成 TLS 升级（workerd runtime 限制，100% 复现 "TLS Handshake Failed."，
 * 与代理质量/协议实现无关 —— 隧道双向透传原始 TLS 字节正常）。因此代理池在
 * Workers 上可能「整体不可用」：若沿用原项目语义（全池失败 → 直接报错），
 * 配置了订阅的部署会全站瘫痪。熔断器在全池连续失败 N 次后打开，后续请求
 * 直接走直连 fetch（保命），冷却窗口过后自动半开重试代理池 —— 若平台修复
 * 或用户换到可用代理，行为自动恢复。
 */
export interface PoolBreakerState {
  /** 全池连续失败次数（任一代理成功即清零） */
  consecutivePoolFailures: number;
  /** 熔断打开至（epoch ms）；0 = 关闭 */
  openUntil: number;
}

export const POOL_BREAKER_THRESHOLD = 3;
export const POOL_BREAKER_COOLDOWN_MS = 10 * 60_000;

export const CLOSED_POOL_BREAKER: PoolBreakerState = { consecutivePoolFailures: 0, openUntil: 0 };

/** 熔断器当前是否处于打开（跳过代理池）状态 */
export function poolBreakerIsOpen(b: PoolBreakerState, now: number): boolean {
  return b.openUntil > now;
}

/** 一次「全池尝试」的结果回写：成功清零；失败累计并在达到阈值时打开熔断。
 * v1.9.1：platformTlsSignature=true（本次全池失败的错误中含 workerd 平台签名
 * 「TLS Handshake Failed」，即 startTls 无法在代理隧道上完成 TLS 升级）时
 * 立即打开熔断，不等阈值 —— 冷 isolate 的首个请求就跳过代理池，免烧 2–5 秒。 */
export function poolBreakerOnOutcome(
  b: PoolBreakerState,
  poolSucceeded: boolean,
  now: number,
  platformTlsSignature = false,
): PoolBreakerState {
  if (poolSucceeded) return CLOSED_POOL_BREAKER;
  if (platformTlsSignature) {
    return { consecutivePoolFailures: Math.max(b.consecutivePoolFailures + 1, POOL_BREAKER_THRESHOLD), openUntil: now + POOL_BREAKER_COOLDOWN_MS };
  }
  const failures = b.consecutivePoolFailures + 1;
  const openUntil = failures >= POOL_BREAKER_THRESHOLD ? now + POOL_BREAKER_COOLDOWN_MS : b.openUntil;
  return { consecutivePoolFailures: failures, openUntil };
}

/** 错误聚合串中是否命中 workerd 平台级代理隧道 TLS 失败签名 */
export const PLATFORM_TLS_FAILURE_SIGNATURE = /TLS Handshake Failed/i;

// 熔断运行时状态（isolate 内存 + KV 快照同步，跨 isolate 共享；详见下方 KV 快照段）
let breakerMem: PoolBreakerState = CLOSED_POOL_BREAKER;

/** 面板/管理端读取熔断器当前状态（/admin/health 暴露） */
export function poolBreakerSnapshot(): PoolBreakerState & { open: boolean } {
  return { ...breakerMem, open: poolBreakerIsOpen(breakerMem, Date.now()) };
}

/** 全池成功：清零并标记待刷盘 */
export function breakerOnPoolSuccess(): void {
  breakerMem = CLOSED_POOL_BREAKER;
  touchPending();
}

/** 全池失败：按结果/签名更新熔断器；返回是否处于「打开」状态 */
export function breakerOnPoolFailure(platformTlsSignature: boolean): boolean {
  breakerMem = poolBreakerOnOutcome(breakerMem, false, Date.now(), platformTlsSignature);
  return poolBreakerIsOpen(breakerMem, Date.now());
}

// ---------- 直连（无代理池）模式退避重试（v1.6.0） ----------

/**
 * 直连模式下是否值得单次重试：
 * 429 / 408 / 425 / 5xx 属于瞬时故障（上游限流或抖动），退避后重发一次价值高；
 * 2xx / 3xx 成功与其余 4xx（请求级错误，重发必然同样失败）不重试。
 */
export function shouldRetryDirect(status: number): boolean {
  return status === 429 || status === 408 || status === 425 || status >= 500;
}

/**
 * 重试退避时长（毫秒）：优先遵循上游 Retry-After 头（秒数或 HTTP 日期格式），
 * 钳位 250ms–4s（避免请求长时间挂起），无头时默认 500ms。
 */
export function retryDelayMs(retryAfterHeader: string | null | undefined, nowMs: number = Date.now()): number {
  const clamp = (v: number) => Math.min(Math.max(v, 250), 4_000);
  if (typeof retryAfterHeader === "string" && retryAfterHeader.trim()) {
    const sec = Number(retryAfterHeader.trim());
    if (Number.isFinite(sec) && sec >= 0) return clamp(sec * 1000);
    const date = Date.parse(retryAfterHeader);
    if (Number.isFinite(date)) return clamp(date - nowMs);
  }
  return 500;
}

// ---------- isolate 全局健康存储 + KV 快照同步 ----------

const HEALTH_KEY = "proxy_health";
const HEALTH_FLUSH_MS = 20_000;
const HEALTH_TTL_SEC = 24 * 3600; // 快照新鲜度：超过一天的记录直接丢弃
const HEALTH_MAX_NODES = 200;

const healthMem = new Map<string, ProxyHealth>();
let healthLoaded = false;
let oldestPendingAt = 0;
let healthFlushing = false;

function touchPending(): void {
  if (oldestPendingAt === 0) oldestPendingAt = Date.now();
}

function healthOf(uri: string): ProxyHealth {
  let h = healthMem.get(uri);
  if (!h) {
    h = emptyHealth();
    healthMem.set(uri, h);
  }
  return h;
}

/** 记录一次成功（真实请求或测速）：清冷却、清连败、更新延迟 EMA、加入粘性池 */
export function recordProxySuccess(uri: string, ms: number, now: number = Date.now()): void {
  if (!uri) return;
  const h = healthOf(uri);
  h.success += 1;
  h.consec_fail = 0;
  h.last_ms = Math.max(0, ms);
  h.avg_ms = h.avg_ms > 0 ? h.avg_ms * 0.7 + Math.max(0, ms) * 0.3 : Math.max(0, ms);
  h.last_success_at = Math.floor(now / 1000);
  h.cooldown_until = 0;
  h.last_error = "";
  h.sticky = true;
  decayCounters(h);
  touchPending();
}

/** 记录一次失败（连接/握手/5xx）：连败冷却 + 驱逐粘性（对齐原项目 recordProxyAttempt） */
export function recordProxyFailure(uri: string, error: string, now: number = Date.now()): void {
  if (!uri) return;
  const h = healthOf(uri);
  h.fail += 1;
  h.consec_fail += 1;
  h.last_fail_at = Math.floor(now / 1000);
  h.last_error = String(error).slice(0, 200);
  h.cooldown_until = Math.floor(now / 1000) + cooldownSecondsFor(h.consec_fail);
  h.sticky = false;
  decayCounters(h);
  touchPending();
}

/** 记录 429 限流：固定 30 秒冷却 + 计次递增降权 + 驱逐粘性 */
export function recordProxyRateLimit(uri: string, now: number = Date.now()): void {
  if (!uri) return;
  const h = healthOf(uri);
  h.rate_limit_count += 1;
  h.last_error = "429 Rate Limit";
  h.last_fail_at = Math.floor(now / 1000);
  h.cooldown_until = Math.floor(now / 1000) + RATE_LIMIT_COOLDOWN_SEC;
  h.sticky = false;
  touchPending();
}

export function proxyHealth(uri: string): ProxyHealth | undefined {
  return healthMem.get(uri);
}

export function healthMapSnapshot(): Map<string, ProxyHealth> {
  return healthMem;
}

/** 面板用：健康表（raw -> health）转普通对象 */
export function allHealthRecords(): Record<string, ProxyHealth> {
  const out: Record<string, ProxyHealth> = {};
  for (const [k, v] of healthMem.entries()) out[k] = structuredClone(v);
  return out;
}

// ---------- KV 快照 ----------

interface HealthSnapshot {
  at: number; // epoch 秒
  nodes: Record<string, ProxyHealth>;
  /** v1.9.1：代理池熔断器（跨 isolate 共享；缺失时视为关闭，首个请求重新学习） */
  breaker?: PoolBreakerState;
}

/** 冷启动恢复：从 KV 读取快照（24 小时内有效；内存已有数据时以内存为准） */
export async function ensureHealthLoaded(env: Env): Promise<void> {
  if (healthLoaded) return;
  healthLoaded = true;
  try {
    const snap = (await env.VPROXY_KV.get(HEALTH_KEY, "json")) as HealthSnapshot | null;
    if (!snap || typeof snap !== "object" || !snap.nodes) return;
    const now = Date.now();
    if (snap.at && now / 1000 - snap.at > HEALTH_TTL_SEC) return;
    for (const [uri, h] of Object.entries(snap.nodes)) {
      if (!h || typeof h !== "object" || healthMem.has(uri)) continue;
      if (healthMem.size >= HEALTH_MAX_NODES) break;
      healthMem.set(uri, { ...emptyHealth(), ...h });
    }
    const b = snap.breaker;
    if (b && typeof b === "object" && Number.isFinite(b.consecutivePoolFailures) && Number.isFinite(b.openUntil)) {
      // v1.9.1：恢复其他 isolate 写入的熔断状态（冷 isolate 首个请求即跳过死代理池）
      breakerMem = { consecutivePoolFailures: Math.max(0, b.consecutivePoolFailures), openUntil: Math.max(0, b.openUntil) };
    }
  } catch {
    // KV 读失败不影响请求
  }
}

/** 定期刷盘：距首条待刷记录超过间隔才真正写 KV（waitUntil 调用） */
export async function flushHealthIfDue(env: Env): Promise<void> {
  if (healthMem.size === 0 || oldestPendingAt === 0) return;
  if (Date.now() - oldestPendingAt < HEALTH_FLUSH_MS) return;
  await flushHealthNow(env);
}

/** 立即刷盘（管理端点与 schedule 场景用） */
export async function flushHealthNow(env: Env): Promise<void> {
  if (healthFlushing) return;
  healthFlushing = true;
  try {
    const breakerClosed = breakerMem.consecutivePoolFailures === 0 && breakerMem.openUntil === 0;
    if (healthMem.size === 0 && breakerClosed) return;
    const snap: HealthSnapshot = { at: Math.floor(Date.now() / 1000), nodes: {}, breaker: breakerMem };
    for (const [uri, h] of healthMem.entries()) snap.nodes[uri] = h;
    await env.VPROXY_KV.put(HEALTH_KEY, JSON.stringify(snap));
    oldestPendingAt = 0;
  } catch {
    // 写失败保留内存，下个窗口重试
  } finally {
    healthFlushing = false;
  }
}

/** 清空健康度（管理端点用） */
export async function resetHealth(env: Env): Promise<void> {
  healthMem.clear();
  oldestPendingAt = 0;
  try {
    await env.VPROXY_KV.delete(HEALTH_KEY);
  } catch {
    // ignore
  }
}
