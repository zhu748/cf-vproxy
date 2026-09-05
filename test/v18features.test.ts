// v1.8.0 功能回归测试：
//   1. subscriptionDue 订阅新鲜度判定（cron 不再每跳无条件拉订阅，按 subscription_refresh_minutes 节流）
//   2. protocolErrorResponse 协议感知错误（Anthropic/Gemini 客户端收到各自原生错误结构，含 retry-after）
//   3. errAnthropic / errGemini 可选 headers 透传
//   4. tokensEqual 常量时间比较语义（客户端 Key 校验改用此函数）
// 说明：均测试纯逻辑层（racing.ts / convert/common.ts），不触碰 cloudflare: 导入链。
import { test } from "node:test";
import assert from "node:assert/strict";
import { subscriptionDue } from "../src/racing.ts";
import { protocolErrorResponse, errAnthropic, errGemini, tokensEqual } from "../src/convert/common.ts";

// ---------- subscriptionDue ----------

test("subscriptionDue: 从未拉过（cacheAt=0）→ 立即需要刷新", () => {
  assert.equal(subscriptionDue(0, 30, Date.now()), true);
});

test("subscriptionDue: 缓存新鲜（< refresh 分钟）→ 跳过", () => {
  const now = 1_000_000;
  assert.equal(subscriptionDue(now - 29 * 60_000, 30, now), false);
});

test("subscriptionDue: 缓存过期（≥ refresh 分钟）→ 刷新", () => {
  const now = 1_000_000;
  assert.equal(subscriptionDue(now - 30 * 60_000, 30, now), true);
  assert.equal(subscriptionDue(now - 31 * 60_000, 30, now), true);
});

test("subscriptionDue: refresh 分钟下限 5（防 0/负值把 cron 变成每跳必拉）", () => {
  const now = 1_000_000;
  // 配 0 分钟：钳位到 5 分钟 —— 4 分钟前的缓存仍算新鲜
  assert.equal(subscriptionDue(now - 4 * 60_000, 0, now), false);
  assert.equal(subscriptionDue(now - 5 * 60_000, 0, now), true);
});

// ---------- protocolErrorResponse ----------

test("protocolErrorResponse: anthropic 401 → {type:error, error.type:authentication_error}", async () => {
  const r = protocolErrorResponse("anthropic", 401, "Invalid API key");
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("content-type"), "application/json");
  const body = (await r.json()) as { type: string; error: { type: string; message: string } };
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "authentication_error");
  assert.equal(body.error.message, "Invalid API key");
});

test("protocolErrorResponse: anthropic 503 → api_error + retry-after 头", async () => {
  const r = protocolErrorResponse("anthropic", 503, "busy", { retryAfter: "1" });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("retry-after"), "1");
  const body = (await r.json()) as { error: { type: string } };
  assert.equal(body.error.type, "api_error");
});

test("protocolErrorResponse: anthropic 403 → permission_error；404/413/400 → invalid_request_error", async () => {
  const mk = async (status: number) => {
    const body = (await protocolErrorResponse("anthropic", status, "x").json()) as { error: { type: string } };
    return body.error.type;
  };
  assert.equal(await mk(403), "permission_error");
  assert.equal(await mk(404), "invalid_request_error");
  assert.equal(await mk(413), "invalid_request_error");
  assert.equal(await mk(400), "invalid_request_error");
});

test("protocolErrorResponse: gemini 401 → error.status=UNAUTHENTICATED；404 → NOT_FOUND", async () => {
  const r1 = protocolErrorResponse("gemini", 401, "Invalid API key");
  const b1 = (await r1.json()) as { error: { code: number; status: string; message: string } };
  assert.equal(r1.status, 401);
  assert.equal(b1.error.code, 401);
  assert.equal(b1.error.status, "UNAUTHENTICATED");
  assert.equal(b1.error.message, "Invalid API key");

  const b2 = (await protocolErrorResponse("gemini", 404, "nope").json()) as { error: { status: string } };
  assert.equal(b2.error.status, "NOT_FOUND");
});

test("protocolErrorResponse: gemini 429/503 → RESOURCE_EXHAUSTED/UNAVAILABLE + retry-after", async () => {
  const b429 = (await protocolErrorResponse("gemini", 429, "limit").json()) as { error: { status: string } };
  assert.equal(b429.error.status, "RESOURCE_EXHAUSTED");
  const r503 = protocolErrorResponse("gemini", 503, "busy", { retryAfter: "1" });
  const b503 = (await r503.json()) as { error: { status: string } };
  assert.equal(b503.error.status, "UNAVAILABLE");
  assert.equal(r503.headers.get("retry-after"), "1");
});

test("protocolErrorResponse: openai 家族（含 other/health）保持 OpenAI 形态与 code", async () => {
  const r = protocolErrorResponse("openai", 503, "busy", { code: "server_busy", retryAfter: "1" });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("retry-after"), "1");
  const body = (await r.json()) as { error: { message: string; type: string; code: string | null } };
  assert.equal(body.error.type, "api_error");
  assert.equal(body.error.code, "server_busy");
  assert.equal(body.error.message, "busy");

  // 协议未识别（other）也回落 OpenAI 形态
  const body2 = (await protocolErrorResponse("other", 401, "x").json()) as { error: { type: string } };
  assert.equal(body2.error.type, "invalid_request_error");
});

test("protocolErrorResponse: 无 retryAfter 时不输出 retry-after 头", () => {
  const r = protocolErrorResponse("gemini", 500, "boom");
  assert.equal(r.headers.get("retry-after"), null);
  const r2 = protocolErrorResponse("anthropic", 500, "boom");
  assert.equal(r2.headers.get("retry-after"), null);
});

// ---------- errAnthropic / errGemini 可选 headers（v1.8.0 新签名） ----------

test("errAnthropic/errGemini: 可选 headers 透传（不传时行为与旧签名一致）", async () => {
  const ra = errAnthropic(429, "rate_limit_error", "slow down", { "retry-after": "7" });
  assert.equal(ra.status, 429);
  assert.equal(ra.headers.get("retry-after"), "7");
  const ba = (await ra.json()) as { type: string; error: { type: string } };
  assert.equal(ba.error.type, "rate_limit_error");

  const rg = errGemini(429, "slow down", "RESOURCE_EXHAUSTED", { "retry-after": "7" });
  assert.equal(rg.status, 429);
  assert.equal(rg.headers.get("retry-after"), "7");
  const bg = (await rg.json()) as { error: { status: string } };
  assert.equal(bg.error.status, "RESOURCE_EXHAUSTED");

  // 旧签名（无 headers）不报错
  const plain = errAnthropic(400, "invalid_request_error", "x");
  assert.equal(plain.status, 400);
  assert.equal(plain.headers.get("retry-after"), null);
});

// ---------- tokensEqual（index.ts 客户端 Key 校验改用） ----------

test("tokensEqual: 相等/不等/长度不同", () => {
  assert.equal(tokensEqual("sk-abc123", "sk-abc123"), true);
  assert.equal(tokensEqual("sk-abc123", "sk-abc124"), false);
  assert.equal(tokensEqual("short", "shorter-string"), false);
  assert.equal(tokensEqual("", ""), true);
});

test("tokensEqual: 数组 some 语义（模拟 api_keys 列表命中）", () => {
  const keys = ["sk-a", "sk-b", "sk-c"];
  const clientKey = "sk-b";
  assert.equal(keys.some((k) => tokensEqual(k, clientKey)), true);
  assert.equal(keys.some((k) => tokensEqual(k, "sk-z")), false);
});
