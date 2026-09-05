// v1.9.1 特性测试：
//   - 代理池平台级熔断器（poolBreakerIsOpen / poolBreakerOnOutcome 纯函数）
//   - leastRecentlyTestedOrder 已在 proxy.test.ts 覆盖（v1.9.0），此处补熔断语义
import {
  CLOSED_POOL_BREAKER,
  POOL_BREAKER_COOLDOWN_MS,
  POOL_BREAKER_THRESHOLD,
  PLATFORM_TLS_FAILURE_SIGNATURE,
  poolBreakerIsOpen,
  poolBreakerOnOutcome,
} from "../src/racing.ts";
import { test } from "node:test";
import assert from "node:assert/strict";

const NOW = 1_000_000;

test("pool breaker: 初始关闭", () => {
  assert.equal(poolBreakerIsOpen(CLOSED_POOL_BREAKER, NOW), false);
  assert.equal(CLOSED_POOL_BREAKER.consecutivePoolFailures, 0);
  assert.equal(CLOSED_POOL_BREAKER.openUntil, 0);
});

test("pool breaker: 阈值前不打开（1、2 次全池失败）", () => {
  let b = poolBreakerOnOutcome(CLOSED_POOL_BREAKER, false, NOW);
  assert.equal(b.consecutivePoolFailures, 1);
  assert.equal(poolBreakerIsOpen(b, NOW), false);
  b = poolBreakerOnOutcome(b, false, NOW + 1);
  assert.equal(b.consecutivePoolFailures, 2);
  assert.equal(poolBreakerIsOpen(b, NOW + 1), false);
  assert.equal(POOL_BREAKER_THRESHOLD, 3);
});

test("pool breaker: 第 N 次失败打开并保持冷却时长", () => {
  let b = CLOSED_POOL_BREAKER;
  for (let i = 0; i < POOL_BREAKER_THRESHOLD; i++) b = poolBreakerOnOutcome(b, false, NOW);
  assert.equal(b.consecutivePoolFailures, POOL_BREAKER_THRESHOLD);
  assert.equal(b.openUntil, NOW + POOL_BREAKER_COOLDOWN_MS);
  assert.equal(poolBreakerIsOpen(b, NOW + POOL_BREAKER_COOLDOWN_MS - 1), true);
});

test("pool breaker: 冷却窗口过后自动半开（重新尝试代理池）", () => {
  let b = CLOSED_POOL_BREAKER;
  for (let i = 0; i < POOL_BREAKER_THRESHOLD; i++) b = poolBreakerOnOutcome(b, false, NOW);
  // 窗口内打开
  assert.equal(poolBreakerIsOpen(b, NOW + 1000), true);
  // 窗口外关闭（半开：请求会再次尝试代理池）
  assert.equal(poolBreakerIsOpen(b, NOW + POOL_BREAKER_COOLDOWN_MS + 1), false);
});

test("pool breaker: 任意一次全池成功即清零", () => {
  let b = CLOSED_POOL_BREAKER;
  b = poolBreakerOnOutcome(b, false, NOW);
  b = poolBreakerOnOutcome(b, false, NOW);
  b = poolBreakerOnOutcome(b, true, NOW);
  assert.deepEqual(b, CLOSED_POOL_BREAKER);
});

test("pool breaker: 打开后若半开期再失败，窗口顺延刷新", () => {
  const t0 = NOW;
  let b = CLOSED_POOL_BREAKER;
  for (let i = 0; i < POOL_BREAKER_THRESHOLD; i++) b = poolBreakerOnOutcome(b, false, t0);
  const openedUntil = b.openUntil;
  // 半开期（窗口刚过）再次全池失败 → 重新累计并在阈值后刷新窗口
  const t1 = openedUntil + 1;
  let b2 = { consecutivePoolFailures: 0, openUntil: 0 } as typeof b;
  for (let i = 0; i < POOL_BREAKER_THRESHOLD; i++) b2 = poolBreakerOnOutcome(b2, false, t1);
  assert.equal(b2.openUntil, t1 + POOL_BREAKER_COOLDOWN_MS);
  assert.ok(b2.openUntil > openedUntil);
});

test("pool breaker: 已打开状态下继续失败不提前延长（保持既有窗口直至再次达标）", () => {
  // 连续失败 2 次（未打开）→ 第 3 次打开。打开后 via=breaker 路径不再走代理池，
  // 不会继续累计 —— 但若半开后立刻又失败 1 次，计数从 1 开始（窗口内 openUntil 保持 0）
  let b = CLOSED_POOL_BREAKER;
  b = poolBreakerOnOutcome(b, false, NOW);
  b = poolBreakerOnOutcome(b, false, NOW);
  assert.equal(b.openUntil, 0); // 2 次还不够
  b = poolBreakerOnOutcome(b, false, NOW);
  assert.ok(b.openUntil > 0); // 第 3 次打开
});

test("pool breaker: 不可变性 —— 不修改入参对象", () => {
  const input = { consecutivePoolFailures: 5, openUntil: 12345 };
  const out = poolBreakerOnOutcome(input, false, NOW);
  assert.notEqual(out, input);
  assert.equal(input.consecutivePoolFailures, 5);
  assert.equal(input.openUntil, 12345);
  assert.equal(out.consecutivePoolFailures, 6);
});

test("pool breaker: 平台 TLS 签名 → 首次失败立即打开（不等阈值）", () => {
  const b = poolBreakerOnOutcome(CLOSED_POOL_BREAKER, false, NOW, true);
  assert.equal(poolBreakerIsOpen(b, NOW), true);
  assert.equal(b.openUntil, NOW + POOL_BREAKER_COOLDOWN_MS);
  assert.ok(b.consecutivePoolFailures >= POOL_BREAKER_THRESHOLD);
});

test("pool breaker: 平台签名优先取更大计数（不回退既有累计）", () => {
  const prior = { consecutivePoolFailures: 9, openUntil: 0 };
  const b = poolBreakerOnOutcome(prior, false, NOW, true);
  assert.equal(b.consecutivePoolFailures, 10);
});

test("PLATFORM_TLS_FAILURE_SIGNATURE: 匹配 workerd 签名与聚合错误串", () => {
  assert.ok(PLATFORM_TLS_FAILURE_SIGNATURE.test("TLS Handshake Failed."));
  assert.ok(
    PLATFORM_TLS_FAILURE_SIGNATURE.test(
      "all proxy attempts failed: [http://107.167.18.122:443] TLS Handshake Failed. | [socks5://43.135.176.121:1080] socks5 handshake timeout",
    ),
  );
  assert.ok(!PLATFORM_TLS_FAILURE_SIGNATURE.test("socks5: CONNECT failed — 405 Not Allowed"));
  assert.ok(!PLATFORM_TLS_FAILURE_SIGNATURE.test("connection reset"));
});

test("pool breaker: 签名失败后成功一次即复位（自愈）", () => {
  let b = poolBreakerOnOutcome(CLOSED_POOL_BREAKER, false, NOW, true);
  assert.ok(poolBreakerIsOpen(b, NOW + 1000));
  b = poolBreakerOnOutcome(b, true, NOW + 2000);
  assert.deepEqual(b, CLOSED_POOL_BREAKER);
});
