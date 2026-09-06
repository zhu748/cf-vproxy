// v2.5.0 回归：classify429Body —— 「单 IP 滑动窗口限流（可换节点轮转）」与
// 「项目级每日配额（硬失败）」的区分。修正 v2.4.1 误判：
//   - "You exceeded your current quota" 文案同时出现在两类错误里（不能单独定性）；
//   - RPM 型 quotaId（GenerateRequestsPerMinute**PerProject**PerModel）含 PerProject；
//   - 用户实测（配额无限的 Key + 每 IP 独立 20 次/窗口）：
//     "Quota exceeded for metric: ...generate_content_free_tier_requests, limit: 20,
//      model: gemini-3-flash. Please retry in 20.464172338s." —— 等 ~20s 即恢复，
//     换代理节点立即可用 —— 必须判 per-ip 轮转，而不是透传 429。
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify429Body, parse429RetryAfterSecs, recordProxyRateLimit, proxyHealth } from "../src/racing.ts";

// 用户线上实测样本（v2.4.1 误判为 Key 级 → 硬失败，v2.5.0 必须判 per-ip 可轮转）
const USER_RPM = [
  "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.",
  "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3-flash",
  "Please retry in 20.464172338s.",
].join("\n");

// 完整 RPM 型 JSON（quotaId 含 PerProject —— v2.4.1 的误杀特征）
const RPM_JSON = JSON.stringify({
  error: {
    code: 429,
    message: "You exceeded your current quota, please check your plan and billing details.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            quotaDimensions: { location: "global", model: "gemini-3-flash", project_id: "12345" },
            quotaValue: "20",
          },
        ],
      },
    ],
  },
});

// 真正的项目级每日配额（换节点无法绕过 → 保持 v2.4.1 硬失败保护）
const RPD_JSON = JSON.stringify({
  error: {
    code: 429,
    message:
      "You exceeded your current quota, please check your plan and billing details. ... * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3-flash",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            quotaDimensions: { location: "global", model: "gemini-3-flash", project_id: "12345" },
            quotaValue: "20",
          },
        ],
      },
    ],
  },
});

const NODE_LEVEL_RL = JSON.stringify({
  error: {
    code: 429,
    message: "Rate limit exceeded for API. Please try again later.",
    status: "RESOURCE_EXHAUSTED",
  },
});

// ---------- classify429Body ----------

test("quota429: 用户实测 RPM 样本（exceeded your current quota + retry in 20.46s）→ per-ip 可轮转", () => {
  const c = classify429Body(USER_RPM);
  assert.equal(c.level, "per-ip");
  assert.ok(c.retryAfterSecs != null && Math.abs(c.retryAfterSecs - 20.464172338) < 0.01);
});

test("quota429: RPM 型 JSON（quotaId 含 PerProject + FreeTier）→ per-ip（v2.4.1 误杀回归）", () => {
  assert.equal(classify429Body(RPM_JSON).level, "per-ip");
});

test("quota429: 项目级每日配额（quotaId PerDay）→ project 硬失败（保留 v2.4.1 保护）", () => {
  assert.equal(classify429Body(RPD_JSON).level, "project");
  assert.equal(classify429Body('"quotaId":"GenerateRequestsPerDayPerProjectPerModel"').level, "project");
  assert.equal(classify429Body("daily limit reached").level, "project");
});

test("quota429: 纯文案片段（exceeded your current quota，无 PerDay/无秒级提示）→ per-ip（可用性优先）", () => {
  assert.equal(classify429Body("You exceeded your current quota, please check your plan and billing details.").level, "per-ip");
});

test("quota429: 节点级限流 / 代理自制 429 页 / 空 → per-ip（安全回退：按节点级处理）", () => {
  assert.equal(classify429Body(NODE_LEVEL_RL).level, "per-ip");
  assert.equal(classify429Body("").level, "per-ip");
  assert.equal(classify429Body("<html><body>429 Too Many Requests</body></html>").level, "per-ip");
  assert.equal(classify429Body("some proxy 429 page").level, "per-ip");
});

test("quota429: PerDay 与秒级 retry 提示并存时每日配额优先（小时级 reset 才是窗口限流）", () => {
  const c = classify429Body(RPD_JSON + ' "retryDelay":"120s"');
  assert.equal(c.level, "project");
});

// ---------- parse429RetryAfterSecs ----------

test("parse429: 支持 Please retry in / try again in / retryDelay 三种形态，只认 ≤300s", () => {
  assert.equal(parse429RetryAfterSecs("Please retry in 20.464172338s."), 20.464172338);
  assert.equal(parse429RetryAfterSecs("Rate limit reached. Try again in 30 seconds."), 30);
  assert.equal(parse429RetryAfterSecs('"retryDelay":"25s"'), 25);
  assert.equal(parse429RetryAfterSecs("Please retry in 86400s."), null); // 小时级 = 每日 reset，不当窗口
  assert.equal(parse429RetryAfterSecs("no hint here"), null);
  assert.equal(parse429RetryAfterSecs(""), null);
});

// ---------- recordProxyRateLimit 冷却时长 ----------

test("recordProxyRateLimit: 上游明示 20.46s → 冷却 23s（+2s 缓冲）；无提示 → 默认 30s；>120s 截断", () => {
  const uri = "socks5://rl-cooldown.test:1080";
  const now = Date.now();
  recordProxyRateLimit(uri, now, 20.464172338);
  const h = proxyHealth(uri)!;
  assert.equal(h.cooldown_until - Math.floor(now / 1000), 23); // ceil(20.46)+2
  assert.equal(h.sticky, false);

  recordProxyRateLimit(uri, now + 1000, undefined);
  assert.equal(proxyHealth(uri)!.cooldown_until - Math.floor((now + 1000) / 1000), 30);

  recordProxyRateLimit(uri, now + 2000, 500); // 超上限（parse 已挡 300+，此处防御 clamp）
  assert.equal(proxyHealth(uri)!.cooldown_until - Math.floor((now + 2000) / 1000), 120);
});
