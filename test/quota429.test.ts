// v2.4.1 回归：isKeyLevelQuota429 —— Key 级配额 429 与节点级限流 429 的区分。
// 用真实上游响应体样本（脱敏）验证：配额型必须命中，节点级/其他错误不得误杀。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isKeyLevelQuota429 } from "../src/racing.ts";

const QUOTA_RPD = JSON.stringify({
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

test("quota429: 免费层 RPD 配额（真实样本）→ Key 级", () => {
  assert.equal(isKeyLevelQuota429(QUOTA_RPD), true);
});

test("quota429: 纯文案片段（exceeded your current quota）→ Key 级", () => {
  assert.equal(isKeyLevelQuota429("You exceeded your current quota, please check your plan and billing details."), true);
});

test("quota429: quotaId / PerProject 维度名 → Key 级", () => {
  assert.equal(isKeyLevelQuota429('"quotaId":"GenerateRequestsPerMinutePerProjectPerModel"'), true);
  assert.equal(isKeyLevelQuota429("FreeTier"), true);
});

test("quota429: 节点级限流（无配额特征）→ 不是 Key 级", () => {
  assert.equal(isKeyLevelQuota429(NODE_LEVEL_RL), false);
  assert.equal(isKeyLevelQuota429("Rate limit reached. Try again in 30 seconds."), false);
});

test("quota429: 空/无关内容 → 不是 Key 级（安全回退：按节点级处理）", () => {
  assert.equal(isKeyLevelQuota429(""), false);
  assert.equal(isKeyLevelQuota429("<html><body>429 Too Many Requests</body></html>"), false);
  assert.equal(isKeyLevelQuota429("some proxy 429 page"), false);
});
