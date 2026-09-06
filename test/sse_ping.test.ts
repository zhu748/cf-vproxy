// v2.4 回归：sseResponseFromGenerator 的 ping 保活与定时器治理。
// 用 node:test 的 mock.timers 驱动 10s ping 间隔（不等待真实时间），
// 验证：① 数据先到 → 无 ping、流正常结束；② 生成器慢于 ping 间隔 → 先收 ping、
// 之后仍能收到同一次 next() 的数据（重置计时器后继续等待同一 promise）；
// ③ onDone 恰好调用一次；④ 生成器抛错 → 流 error、onDone 仍被调用。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { sseResponseFromGenerator } from "../src/handlers/sse.ts";
import { ssePingFrame } from "../src/fakestream.ts";

const tick = () => new Promise<void>((r) => setImmediate(r));

test("sse ping: 数据立即可用 → 不发 ping，流正常结束，onDone 调用一次", async () => {
  let doneCalls = 0;
  async function* gen(): AsyncGenerator<string> {
    yield "data: a\n\n";
    yield "data: b\n\n";
  }
  const resp = sseResponseFromGenerator(gen(), null, () => {
    doneCalls++;
  });
  const text = await resp.text();
  assert.equal(text, "data: a\n\ndata: b\n\n");
  assert.equal(doneCalls, 1);
});

test("sse ping: 生成器慢于 ping 间隔 → 先 ping 后数据（同一 next() 不丢失）", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let doneCalls = 0;
    async function* gen(): AsyncGenerator<string> {
      await gate; // 卡住首个 next()，逼出 ping
      yield "data: hello\n\n";
    }
    const resp = sseResponseFromGenerator(gen(), null, () => {
      doneCalls++;
    });
    const reading = resp.text();
    await tick(); // 让 pull 启动并武装 ping 计时器
    mock.timers.tick(10_000); // ping 间隔到 → 应发出一个 ping 帧
    await tick();
    release!(); // 放行生成器 → 数据应当胜出并结束流
    const text = await reading;
    assert.ok(text.startsWith(ssePingFrame()), "expected ping frame first, got: " + JSON.stringify(text));
    assert.equal(text, ssePingFrame() + "data: hello\n\n");
    assert.equal(doneCalls, 1);
  } finally {
    mock.timers.reset();
  }
});

test("sse ping: 多个 ping 周期逐个发出（计时器重置语义）", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    async function* gen(): AsyncGenerator<string> {
      await gate;
      yield "data: end\n\n";
    }
    const resp = sseResponseFromGenerator(gen());
    const reading = resp.text();
    await tick();
    mock.timers.tick(10_000);
    await tick();
    mock.timers.tick(10_000);
    await tick();
    mock.timers.tick(10_000);
    await tick();
    release!();
    const text = await reading;
    assert.equal(text, ssePingFrame().repeat(3) + "data: end\n\n");
  } finally {
    mock.timers.reset();
  }
});

test("sse ping: 生成器抛错 → 流 error，onDone 仍被调用", async () => {
  let doneCalls = 0;
  async function* gen(): AsyncGenerator<string> {
    yield "data: partial\n\n";
    throw new Error("boom");
  }
  const resp = sseResponseFromGenerator(gen(), null, () => {
    doneCalls++;
  });
  await assert.rejects(() => resp.text(), /boom/u);
  assert.equal(doneCalls, 1);
});
