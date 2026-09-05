// v1.6.0 特性回归测试：直连退避重试判定、常量时间比较、Gemini 响应规范化接线、
// count_tokens 缓存（single-flight + 缓存命中）、请求体上限判定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRetryDirect, retryDelayMs } from "../src/racing.ts";
import { tokensEqual } from "../src/convert/common.ts";
import { normalizeGeminiResponse, normalizeNativeStreamFrames, canonicalUsage } from "../src/geminihygiene.ts";
import { countTokensWithCache, countTokensCacheKey, cacheClear, cacheStats, unwrapCountTokensBody } from "../src/counttokens.ts";
import type { GResponse } from "../src/types.ts";

// ---------- 直连重试判定 ----------

test("shouldRetryDirect: 瞬时故障才重试", () => {
  for (const s of [429, 408, 425, 500, 502, 503, 504]) assert.equal(shouldRetryDirect(s), true, "status " + s);
  for (const s of [200, 201, 204, 301, 400, 401, 403, 404, 422]) assert.equal(shouldRetryDirect(s), false, "status " + s);
});

test("retryDelayMs: 遵循 Retry-After 秒数并钳位", () => {
  assert.equal(retryDelayMs("1"), 1000);
  assert.equal(retryDelayMs("0"), 250); // 下限钳位
  assert.equal(retryDelayMs("30"), 4000); // 上限钳位
  assert.equal(retryDelayMs("2.5"), 2500);
});

test("retryDelayMs: HTTP 日期格式 / 非法值 / 缺省", () => {
  // 取整秒边界构造目标时间，避免 toUTCString 毫秒截断带来的不确定性
  const now = Math.floor(Date.now() / 1000) * 1000;
  assert.equal(retryDelayMs(new Date(now + 2000).toUTCString(), now), 2000);
  assert.equal(retryDelayMs(new Date(now - 9999).toUTCString(), now), 250); // 过去时间 → 下限
  assert.equal(retryDelayMs("junk"), 500);
  assert.equal(retryDelayMs(null), 500);
  assert.equal(retryDelayMs(undefined), 500);
  assert.equal(retryDelayMs("  "), 500);
});

// ---------- 常量时间比较 ----------

test("tokensEqual: 相等/不等/长度不同", () => {
  assert.equal(tokensEqual("secret-token", "secret-token"), true);
  assert.equal(tokensEqual("secret-token", "secret-toked"), false); // 末位字符不同
  assert.equal(tokensEqual("short", "a-much-longer-token"), false);
  assert.equal(tokensEqual("", ""), true);
  assert.equal(tokensEqual("", "x"), false);
});

// ---------- Gemini 响应规范化（geminihygiene 接线验证） ----------

test("normalizeGeminiResponse: 清理 FINISH_REASON_UNSPECIFIED 占位", () => {
  const g: GResponse = {
    candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "FINISH_REASON_UNSPECIFIED", index: 0 }],
  };
  const out = normalizeGeminiResponse(g);
  assert.equal(out.candidates?.[0]?.finishReason, undefined);
  assert.equal((out.candidates?.[0]?.content?.parts?.[0] as { text?: string }).text, "hi"); // 其余字段保留
});

test("normalizeGeminiResponse: 空占位 promptFeedback 整体移除", () => {
  const g: GResponse = { candidates: [], promptFeedback: { blockReason: "BLOCKED_REASON_UNSPECIFIED" } };
  const out = normalizeGeminiResponse(g);
  assert.equal(out.promptFeedback, undefined);
  // 带 safetyRatings 的只删 blockReason
  const g2: GResponse = { candidates: [], promptFeedback: { blockReason: "", safetyRatings: [{}] } };
  const out2 = normalizeGeminiResponse(g2);
  assert.deepEqual(out2.promptFeedback, { safetyRatings: [{}] });
});

test("canonicalUsage: totalTokenCount 缺失时反推", () => {
  assert.deepEqual(canonicalUsage({ promptTokenCount: 10, candidatesTokenCount: 5 }), {
    promptTokenCount: 10,
    candidatesTokenCount: 5,
    totalTokenCount: 15,
  });
  assert.equal(canonicalUsage(undefined), undefined);
});

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

const textFrame = (text: string, finish?: string): GResponse => ({
  candidates: [{ content: { role: "model", parts: [{ text }] }, ...(finish ? { finishReason: finish } : {}) }],
});

test("normalizeNativeStreamFrames: 流末无 finishReason → 补合成 STOP 帧", async () => {
  const frames = await collect(
    normalizeNativeStreamFrames(
      (async function* () {
        yield textFrame("hello ");
        yield textFrame("world");
      })(),
    ),
  );
  assert.equal(frames.length, 3);
  const last = frames[frames.length - 1];
  assert.equal(last.candidates?.[0]?.finishReason, "STOP");
});

test("normalizeNativeStreamFrames: usage-only 帧注入合成空候选（RikkaHub 兼容）", async () => {
  const frames = await collect(
    normalizeNativeStreamFrames(
      (async function* () {
        yield textFrame("hi", "STOP");
        yield { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } } as GResponse;
      })(),
    ),
  );
  const usageFrame = frames[frames.length - 1];
  assert.ok(usageFrame.usageMetadata);
  assert.ok(Array.isArray(usageFrame.candidates) && usageFrame.candidates.length > 0, "usage-only 帧需带合成候选");
  assert.equal(usageFrame.usageMetadata?.totalTokenCount, 5); // canonical 反推
});

test("normalizeNativeStreamFrames: 空流 → 500 错误帧", async () => {
  const frames = await collect(normalizeNativeStreamFrames((async function* () {})()));
  assert.equal(frames.length, 1);
  assert.equal((frames[0] as unknown as { error?: { code?: number } }).error?.code, 500);
});

// ---------- count_tokens 缓存 ----------

test("countTokensWithCache: 命中缓存（loader 只调一次）+ single-flight 合并", async () => {
  cacheClear();
  let calls = 0;
  const loader = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return 42;
  };
  const key = countTokensCacheKey("gemini-2.5-pro", [{ role: "user", parts: [{ text: "abc" }] }]);
  // 并发两次相同查询 → single-flight 合并为一次 loader
  const [a, b] = await Promise.all([countTokensWithCache(key, loader), countTokensWithCache(key, loader)]);
  assert.equal(a, 42);
  assert.equal(b, 42);
  assert.equal(calls, 1);
  // 顺序再次查询 → 命中缓存
  const c = await countTokensWithCache(key, loader);
  assert.equal(c, 42);
  assert.equal(calls, 1);
  assert.equal(cacheStats().entries, 1);
});

test("countTokensWithCache: loader 抛错不上缓存、直接透出", async () => {
  cacheClear();
  const key = countTokensCacheKey("m", [{ role: "user", parts: [] }]);
  await assert.rejects(countTokensWithCache(key, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(cacheStats().entries, 0);
});

test("countTokensWithCache: 不同 key 不互相命中", async () => {
  cacheClear();
  const k1 = countTokensCacheKey("m-a", [{ role: "user", parts: [{ text: "x" }] }]);
  const k2 = countTokensCacheKey("m-b", [{ role: "user", parts: [{ text: "x" }] }]);
  assert.notEqual(k1, k2);
  assert.equal(await countTokensWithCache(k1, async () => 1), 1);
  assert.equal(await countTokensWithCache(k2, async () => 2), 2);
});

test("unwrapCountTokensBody: generateContentRequest 信封解包与字符串兼容", () => {
  const direct = unwrapCountTokensBody({ contents: [{ role: "user", parts: [{ text: "a" }] }] });
  assert.ok(Array.isArray(direct.contents));
  const enveloped = unwrapCountTokensBody({
    generateContentRequest: { contents: [{ role: "user", parts: [{ text: "a" }] }] },
  });
  assert.ok(Array.isArray(enveloped.contents));
  const asString = unwrapCountTokensBody({ contents: "hello" });
  assert.deepEqual(asString.contents, [{ role: "user", parts: [{ text: "hello" }] }]);
});
