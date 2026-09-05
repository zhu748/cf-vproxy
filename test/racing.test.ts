// 竞速与健康度模块单测（Node 直跑，无 Workers 依赖）
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  averageLatency,
  cooldownSecondsFor,
  DEFAULT_RACING,
  emptyHealth,
  healthScore,
  isCooling,
  selectCandidates,
  sanitizeRacingConfig,
  type ProxyHealth,
  type RacingConfig,
} from "../src/racing.ts";

const NOW = 1_700_000_000_000; // epoch ms
const SEC = Math.floor(NOW / 1000);

function mkHealth(p: Partial<ProxyHealth>): ProxyHealth {
  return { ...emptyHealth(), ...p };
}

function rc(p: Partial<RacingConfig> = {}): RacingConfig {
  return { ...DEFAULT_RACING, ...p };
}

// ---------- cooldown ----------

test("cooldownSecondsFor：连败指数冷却 30s*2^(n-1)，封顶 1800s", () => {
  assert.equal(cooldownSecondsFor(1), 30);
  assert.equal(cooldownSecondsFor(2), 60);
  assert.equal(cooldownSecondsFor(3), 120);
  assert.equal(cooldownSecondsFor(7), 1920 - 120); // 30*2^6 = 1920 → min(1800,1920)=1800
  assert.equal(cooldownSecondsFor(7), Math.min(1800, 30 * Math.pow(2, 6)));
  assert.equal(cooldownSecondsFor(20), 1800);
  assert.equal(cooldownSecondsFor(0), 30); // 非法输入按 1 次失败计
});

// ---------- sanitizeRacingConfig ----------

test("sanitizeRacingConfig：默认值 / 钳位 / 类型兜底", () => {
  const d = sanitizeRacingConfig(undefined);
  assert.deepEqual(d, DEFAULT_RACING);
  assert.equal(DEFAULT_RACING.enabled, true);

  const clamped = sanitizeRacingConfig({
    enabled: 1,
    top_k: 999,
    max_concurrent: 0,
    hedge_delay_ms: 5,
    dynamic_delay: "yes",
    max_attempts: 100,
  });
  assert.equal(clamped.enabled, true);
  assert.equal(clamped.top_k, 16);
  assert.equal(clamped.max_concurrent, 1);
  assert.equal(clamped.hedge_delay_ms, 100);
  assert.equal(clamped.dynamic_delay, true);
  assert.equal(clamped.max_attempts, 20);

  const off = sanitizeRacingConfig({ enabled: false, top_k: "abc", hedge_delay_ms: 2000 });
  assert.equal(off.enabled, false);
  assert.equal(off.top_k, 6); // 非数字回默认
  assert.equal(off.hedge_delay_ms, 2000);
});

// ---------- healthScore ----------

test("healthScore：未测试 80 分；已验证按成功率/延迟/连败/粘性打分", () => {
  assert.equal(healthScore(undefined, NOW), 80);
  assert.equal(healthScore(emptyHealth(), NOW), 80);

  const perfect = mkHealth({
    success: 10,
    fail: 0,
    last_success_at: SEC,
    avg_ms: 200,
    sticky: true,
  });
  // 60 + 20*1 + clamp(20-4,0,20)=16 + 15 = 111
  assert.equal(healthScore(perfect, NOW), 60 + 20 + 16 + 15);

  const poor = mkHealth({ success: 0, fail: 10, consec_fail: 5, last_fail_at: SEC, avg_ms: 3000 });
  // 60 + 0 + 0 - 40 = 20
  assert.equal(healthScore(poor, NOW), 20);

  // 冷却中 0 分
  const cooling = mkHealth({ success: 10, cooldown_until: SEC + 100 });
  assert.equal(healthScore(cooling, NOW), 0);
  assert.equal(isCooling(cooling, NOW), true);
  assert.equal(isCooling(mkHealth({ cooldown_until: SEC - 1 }), NOW), false);
});

// ---------- selectCandidates ----------

test("selectCandidates：已验证按分数排序，未测试给探索名额，冷却垫底兜底", () => {
  const health = new Map<string, ProxyHealth>();
  const good = { raw: "socks5://good:1080" };
  const mid = { raw: "socks5://mid:1080" };
  const bad = { raw: "socks5://bad:1080" };
  const fresh = { raw: "socks5://fresh:1080" };
  const cold = { raw: "socks5://cold:1080" };

  health.set(good.raw, mkHealth({ success: 50, fail: 0, last_success_at: SEC, avg_ms: 150, sticky: true }));
  health.set(mid.raw, mkHealth({ success: 20, fail: 5, last_success_at: SEC, avg_ms: 800 }));
  health.set(bad.raw, mkHealth({ success: 1, fail: 30, consec_fail: 4, last_fail_at: SEC, avg_ms: 5000 }));
  health.set(cold.raw, mkHealth({ success: 10, fail: 0, cooldown_until: SEC + 60, last_success_at: SEC - 3600 }));

  const cfg = rc({ top_k: 3, max_attempts: 8 });
  const cands = selectCandidates([good, mid, bad, fresh, cold], health, cfg, NOW);

  // good(高分) → mid → fresh(探索) …；bad 冷却前不入选前列？bad 未冷却但低分 —— 仍然在 verified 里
  assert.equal(cands[0].raw, good.raw);
  assert.ok(cands.findIndex((c) => c.raw === mid.raw) < cands.findIndex((c) => c.raw === bad.raw));
  assert.ok(cands.some((c) => c.raw === fresh.raw)); // 探索名额存在
  assert.ok(!cands.some((c) => c.raw === cold.raw)); // 冷却节点在还有候选时不入选

  // 全部冷却：冷却节点兜底
  const onlyCold = [cold];
  const got = selectCandidates(onlyCold, health, rc({ top_k: 3, max_attempts: 8 }), NOW);
  assert.equal(got.length, 1);
  assert.equal(got[0].raw, cold.raw);
});

test("selectCandidates：top_k 与 max_attempts 双重钳位 + 去重", () => {
  const health = new Map<string, ProxyHealth>();
  const entries = Array.from({ length: 10 }, (_, i) => ({ raw: "socks5://n" + i + ":1080" }));
  entries.forEach((e, i) => health.set(e.raw, mkHealth({ success: 100 - i, last_success_at: SEC })));

  const cands = selectCandidates(entries, health, rc({ top_k: 3, max_attempts: 8 }), NOW);
  assert.equal(cands.length, 3); // top_k 生效

  const cands2 = selectCandidates(entries, health, rc({ top_k: 16, max_attempts: 5 }), NOW);
  assert.equal(cands2.length, 5); // max_attempts 生效

  const dup = selectCandidates([entries[0], entries[0], entries[1]], health, rc(), NOW);
  const seen = new Set(dup.map((e) => e.raw));
  assert.equal(seen.size, dup.length); // 无重复
});

test("selectCandidates：冷却早的排前面（兜底顺序）", () => {
  const health = new Map<string, ProxyHealth>();
  const a = { raw: "socks5://a:1080" };
  const b = { raw: "socks5://b:1080" };
  health.set(a.raw, mkHealth({ cooldown_until: SEC + 100 }));
  health.set(b.raw, mkHealth({ cooldown_until: SEC + 10 }));
  const got = selectCandidates([a, b], health, rc(), NOW);
  assert.deepEqual(got.map((g) => g.raw), [b.raw, a.raw]);
});

// ---------- averageLatency ----------

test("averageLatency：健康节点均值；无数据 500ms；冷却节点不计入", () => {
  const health = new Map<string, ProxyHealth>();
  assert.equal(averageLatency(health, NOW), 500);

  health.set("a", mkHealth({ avg_ms: 200, last_success_at: SEC }));
  health.set("b", mkHealth({ avg_ms: 400, last_success_at: SEC }));
  assert.equal(averageLatency(health, NOW), 300);

  health.set("c", mkHealth({ avg_ms: 9000, last_success_at: SEC, cooldown_until: SEC + 100 }));
  assert.equal(averageLatency(health, NOW), 300); // 冷却节点不计
});

// ---------- 竞速引擎尝试分类（classifyStatus 逻辑经 racefetch 内部函数覆盖，此处验证健康度写入路径） ----------

test("健康度写入路径：success/fail/ratelimit 的独立语义（通过健康分间接验证）", () => {
  // 由于 record* 直接操作 isolate 全局，这里只验证评分函数对字段的敏感性，
  // 实际 record 函数在 Workers 集成中验证（Node 侧避免全局态污染单测）。
  const h1 = mkHealth({ success: 5, fail: 0, last_success_at: SEC, avg_ms: 100 });
  const h2 = mkHealth({ success: 5, fail: 0, last_success_at: SEC, avg_ms: 100, rate_limit_count: 3, consec_fail: 1 });
  assert.ok(healthScore(h1, NOW) > healthScore(h2, NOW));
});
