// v1.5.0 假流式全端点对齐单测：
//   - geminiFakeStreamFrames（移植自原项目 gemini_handler.go，含 usage 收尾帧）
//   - geminiFakeStreamSseBody（alt=sse 响应体）
//   - fakeStreamAnthropicEvents（聚合语义：整段文本单 delta）
//   - withFakeVariants（模型列表变体，顺序对齐 ModelsWithFakeVariants）
// （Node 直跑，无 Workers 依赖）
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  splitFakeChunks,
  geminiFakeStreamFrames,
  geminiFakeStreamSseBody,
  withFakeVariants,
} from "../src/fakestream.ts";
import { fakeStreamAnthropicEvents } from "../src/convert/anthropic.ts";
import type { GResponse } from "../src/types.ts";

// ---------- withFakeVariants ----------

test("withFakeVariants: 每个模型展开为 m / 假流式-m / fake-m（顺序对齐原项目）", () => {
  const out = withFakeVariants(["gemini-2.5-pro", "gemini-2.5-flash"]);
  assert.deepEqual(out, [
    "gemini-2.5-pro",
    "假流式-gemini-2.5-pro",
    "fake-gemini-2.5-pro",
    "gemini-2.5-flash",
    "假流式-gemini-2.5-flash",
    "fake-gemini-2.5-flash",
  ]);
});

test("withFakeVariants: 空表返回空", () => {
  assert.deepEqual(withFakeVariants([]), []);
});

// ---------- geminiFakeStreamFrames ----------

test("geminiFakeStreamFrames: 长文本按码点切 ≤8 帧，拼接还原原文", () => {
  const text = "一二三四五六七八九十一二三四五六七八九十"; // 20 码点
  const g: GResponse = {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
  };
  const frames = geminiFakeStreamFrames(g);
  // 20 码点 → 8 块 + 1 个 usage 收尾帧
  assert.equal(frames.length, 9);
  const textFrames = frames.slice(0, 8);
  const joined = textFrames
    .map((f) => (f.candidates?.[0]?.content?.parts?.[0] as { text?: string }).text ?? "")
    .join("");
  assert.equal(joined, text);
  // 每块 ≤8 码点
  for (const f of textFrames) {
    const t = (f.candidates?.[0]?.content?.parts?.[0] as { text?: string }).text ?? "";
    assert.ok(Array.from(t).length <= 8);
  }
  // finishReason 只出现在候选最后一帧（第 8 帧），不在中间帧
  for (let i = 0; i < 7; i++) assert.equal(textFrames[i].candidates?.[0]?.finishReason, undefined);
  assert.equal(textFrames[7].candidates?.[0]?.finishReason, "STOP");
  // usage 收尾帧：空 parts + usageMetadata
  const usageFrame = frames[8];
  assert.deepEqual(usageFrame.candidates?.[0]?.content?.parts, []);
  assert.equal(usageFrame.usageMetadata?.totalTokenCount, 30);
});

test("geminiFakeStreamFrames: 短文本逐码点吐帧（打字机效果，对齐原项目）", () => {
  const g: GResponse = { candidates: [{ content: { role: "model", parts: [{ text: "hello" }] } }] };
  const frames = geminiFakeStreamFrames(g);
  assert.equal(frames.length, 5);
  assert.deepEqual(
    frames.map((f) => (f.candidates?.[0]?.content?.parts?.[0] as { text?: string }).text),
    ["h", "e", "l", "l", "o"],
  );
});

test("geminiFakeStreamFrames: 非 text part（functionCall）原样单帧并携带 finishReason", () => {
  const g: GResponse = {
    candidates: [
      {
        content: { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "北京" } } }] },
        finishReason: "STOP",
        safetyRatings: [{ category: "HARM_CATEGORY_HARASSMENT", probability: "NEGLIGIBLE" }],
      },
    ],
  };
  const frames = geminiFakeStreamFrames(g);
  assert.equal(frames.length, 1);
  const part = frames[0].candidates?.[0]?.content?.parts?.[0] as { functionCall?: { name: string } };
  assert.equal(part.functionCall?.name, "get_weather");
  assert.equal(frames[0].candidates?.[0]?.finishReason, "STOP");
  assert.deepEqual(frames[0].candidates?.[0]?.safetyRatings, [
    { category: "HARM_CATEGORY_HARASSMENT", probability: "NEGLIGIBLE" },
  ]);
});

test("geminiFakeStreamFrames: 混合 part 顺序保持，文本切块后 functionCall 帧跟随其后", () => {
  const g: GResponse = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: "let me check the weather now ok" }, { functionCall: { name: "f" } }],
        },
        finishReason: "STOP",
      },
    ],
  };
  const frames = geminiFakeStreamFrames(g);
  // 31 码点 → 8 文本帧 + 1 functionCall 帧
  const textFrameCount = frames.filter((f) => "text" in (f.candidates?.[0]?.content?.parts?.[0] ?? {})).length;
  const fcFrame = frames.find((f) =>
    "functionCall" in (f.candidates?.[0]?.content?.parts?.[0] ?? {}),
  );
  assert.equal(textFrameCount, 8);
  assert.ok(fcFrame);
  // functionCall 帧是候选最后一帧，携带 finishReason
  const lastCandidateFrame = frames[frames.length - 1];
  assert.equal(
    (lastCandidateFrame.candidates?.[0]?.content?.parts?.[0] as { functionCall?: unknown }).functionCall !== undefined,
    true,
  );
  assert.equal(lastCandidateFrame.candidates?.[0]?.finishReason, "STOP");
});

test("geminiFakeStreamFrames: 空 parts 候选输出单空帧；无候选输出空数组", () => {
  const empty: GResponse = { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] };
  const f1 = geminiFakeStreamFrames(empty);
  assert.equal(f1.length, 1);
  assert.deepEqual(f1[0].candidates?.[0]?.content?.parts, []);
  assert.equal(f1[0].candidates?.[0]?.finishReason, "STOP");

  const none: GResponse = {};
  assert.deepEqual(geminiFakeStreamFrames(none), []);
});

test("geminiFakeStreamFrames: 顶层元数据合并进最后一帧", () => {
  const g: GResponse = {
    candidates: [{ content: { role: "model", parts: [{ text: "hello world" }] }, finishReason: "STOP" }],
    modelVersion: "gemini-2.5-pro",
    responseId: "abc123",
    createTime: "2026-09-05T00:00:00Z",
  };
  const frames = geminiFakeStreamFrames(g);
  const last = frames[frames.length - 1];
  assert.equal(last.modelVersion, "gemini-2.5-pro");
  assert.equal(last.responseId, "abc123");
  assert.equal(last.createTime, "2026-09-05T00:00:00Z");
});

test("geminiFakeStreamSseBody: 输出可被逐帧解析的 alt=sse 文本", () => {
  const g: GResponse = {
    candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
  };
  const body = geminiFakeStreamSseBody(g);
  const lines = body.split("\n\n").filter(Boolean);
  for (const line of lines) assert.ok(line.startsWith("data: "), "每帧应为 data: 前缀");
  const parsed = lines.map((l) => JSON.parse(l.slice("data: ".length)) as GResponse);
  assert.equal(parsed.length, 3); // h / i / usage
  assert.equal(parsed[parsed.length - 1].usageMetadata?.totalTokenCount, 3);
});

// ---------- fakeStreamAnthropicEvents ----------

async function collect(gen: AsyncGenerator<string>): Promise<Array<{ event: string; data: any }>> {
  const out: Array<{ event: string; data: any }> = [];
  for await (const chunk of gen) {
    const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? "";
    out.push({ event, data: JSON.parse(/^data: (.+)$/m.exec(chunk)?.[1] ?? "{}") });
  }
  return out;
}

test("fakeStreamAnthropicEvents: 整段文本单个 text_delta（聚合语义）+ 完整事件序列", async () => {
  const g: GResponse = {
    candidates: [
      { content: { role: "model", parts: [{ text: "第一段" }, { text: "第二段" }] }, finishReason: "STOP" },
    ],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 6, thoughtsTokenCount: 0, totalTokenCount: 13 },
  };
  let usage: { input: number; output: number } | null = null;
  const events = await collect(fakeStreamAnthropicEvents(g, "claude-client-model", "msg_test", (i, o) => {
    usage = { input: i, output: o };
  }));
  const names = events.map((e) => e.event);
  assert.deepEqual(names, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  // 两个 text part 合并为一个块、一个 delta
  const delta = events[2].data;
  assert.equal(delta.delta.type, "text_delta");
  assert.equal(delta.delta.text, "第一段第二段");
  assert.equal(delta.index, 0);
  // stop_reason 与 usage
  assert.equal(events[4].data.delta.stop_reason, "end_turn");
  assert.equal(events[4].data.usage.output_tokens, 6);
  assert.equal(events[4].data.usage.input_tokens, 7);
  assert.deepEqual(usage, { input: 7, output: 6 });
});

test("fakeStreamAnthropicEvents: 工具调用输出 tool_use 块，stop_reason=tool_use", async () => {
  const g: GResponse = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ functionCall: { name: "get_weather", args: { city: "上海" } } }],
        },
        finishReason: "STOP",
      },
    ],
  };
  const events = await collect(fakeStreamAnthropicEvents(g, "m", "msg_1"));
  const names = events.map((e) => e.event);
  assert.deepEqual(names, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(events[1].data.content_block.type, "tool_use");
  assert.equal(events[1].data.content_block.name, "get_weather");
  assert.deepEqual(JSON.parse(events[2].data.delta.partial_json), { city: "上海" });
  assert.equal(events[4].data.delta.stop_reason, "tool_use");
});

test("fakeStreamAnthropicEvents: 空响应仍输出完整事件序列（v1.7.0：补空 text 块，end_turn）", async () => {
  const events = await collect(fakeStreamAnthropicEvents({}, "m", "msg_2"));
  assert.deepEqual(
    events.map((e) => e.event),
    ["message_start", "content_block_start", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal(events[1].data.content_block.type, "text");
  assert.equal(events[events.length - 2].data.delta.stop_reason, "end_turn");
});

test("fakeStreamAnthropicEvents: MAX_TOKENS → stop_reason=max_tokens（Anthropic 规范值）", async () => {
  const g: GResponse = {
    candidates: [{ content: { role: "model", parts: [{ text: "截断" }] }, finishReason: "MAX_TOKENS" }],
  };
  const events = await collect(fakeStreamAnthropicEvents(g, "m", "msg_3"));
  assert.equal(events[events.length - 2].data.delta.stop_reason, "max_tokens");
});

// ---------- splitFakeChunks 回归（码点边界） ----------

test("splitFakeChunks: 不切断 emoji 代理对", () => {
  const text = "😀".repeat(16); // 16 码点（32 字节）
  const chunks = splitFakeChunks(text);
  assert.equal(chunks.join(""), text);
  for (const c of chunks) assert.ok(!c.includes("\uFFFD"));
});
