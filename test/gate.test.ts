// 请求闸门单元测试：max_concurrent_requests（并发门）与 max_request_mb（请求体上限）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireSlot, bodyLimitViolation, inFlightCount, resetGateForTest } from "../src/gate.ts";

test("gate: 并发门正常获取与归还", () => {
  resetGateForTest();
  const a = acquireSlot(2);
  assert.equal(a.acquired, true);
  assert.equal(inFlightCount(), 1);
  const b = acquireSlot(2);
  assert.equal(b.acquired, true);
  assert.equal(inFlightCount(), 2);
  b.release();
  assert.equal(inFlightCount(), 1);
  a.release();
  assert.equal(inFlightCount(), 0);
});

test("gate: 超出上限拒绝（503 语义由调用方构造）", () => {
  resetGateForTest();
  const a = acquireSlot(1);
  assert.equal(a.acquired, true);
  const b = acquireSlot(1);
  assert.equal(b.acquired, false);
  assert.equal(inFlightCount(), 1);
  b.release(); // 未获准的 release 是 no-op
  assert.equal(inFlightCount(), 1);
  a.release();
  assert.equal(inFlightCount(), 0);
});

test("gate: release 幂等（finally + 异常路径双释放安全）", () => {
  resetGateForTest();
  const s = acquireSlot(4);
  s.release();
  s.release();
  s.release();
  assert.equal(inFlightCount(), 0);
});

test("gate: 并发隔离 —— 释放后名额可复用", () => {
  resetGateForTest();
  const slots = [];
  for (let i = 0; i < 3; i++) slots.push(acquireSlot(3));
  assert.ok(slots.every((s) => s.acquired));
  assert.equal(acquireSlot(3).acquired, false);
  slots[1].release();
  assert.equal(acquireSlot(3).acquired, true);
  assert.equal(acquireSlot(3).acquired, false);
});

test("gate: 非法上限值防御（回退 1）", () => {
  resetGateForTest();
  assert.equal(acquireSlot(NaN).acquired, true); // NaN → 1
  resetGateForTest();
  assert.equal(acquireSlot(0).acquired, true); // 0 → 1
});

test("bodyLimitViolation: content-length 预检", () => {
  const max = 1024;
  assert.equal(bodyLimitViolation("1024", 0, max), null);
  assert.equal(bodyLimitViolation("1025", 0, max) !== null, true);
  assert.equal(bodyLimitViolation(null, 0, max), null); // 无头时预检放行
  assert.equal(bodyLimitViolation("abc", 0, max), null); // 非数字头交给实测兜底
});

test("bodyLimitViolation: 实际字节数复核（覆盖无头/分块场景）", () => {
  const max = 100;
  assert.equal(bodyLimitViolation(null, 100, max), null);
  assert.equal(bodyLimitViolation(null, 101, max) !== null, true);
  assert.equal(bodyLimitViolation("50", 101, max) !== null, true); // 头谎报，实测超限
  assert.equal(bodyLimitViolation("0", 0, max), null);
});

test("bodyLimitViolation: maxBytes<=0 不限制（防御）", () => {
  assert.equal(bodyLimitViolation("999999", 999999, 0), null);
});
