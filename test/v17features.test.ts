// v1.7.0 功能回归测试：
//   1. thought 思考摘要分流（Anthropic → thinking 块 / OpenAI → reasoning_content，不再混入正文）
//   2. Anthropic 流式/假流式 inlineData 图像 → markdown 文本（此前丢失）
//   3. Anthropic 空响应补空 text 块（此前 content:[]）
//   4. OpenAI 流式 prefill 回声剥离（此前真流式路径缺失）
//   5. sseResponseFromGenerator onDone 收尾回调（正常结束/取消各一次，幂等）
//   6. protocolOf 识别 /v1/responses、/v1/audio、/v1/images
// 说明：handlers/openai.ts 的导入链含 cloudflare: 模块（Node 不可加载），
//      fakeStreamFromGeminiResponse 的 thought 分流行为与 geminiSseToOpenaiChunks 共用
//      isThoughtPart 判定，此处经由 convert 层全覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isThoughtPart } from "../src/convert/common.ts";
import { geminiToOpenAI, geminiSseToOpenaiChunks } from "../src/convert/openai.ts";
import { geminiToAnthropic, geminiSseToAnthropicEvents, fakeStreamAnthropicEvents } from "../src/convert/anthropic.ts";
import { sseResponseFromGenerator } from "../src/handlers/sse.ts";
import { protocolOf } from "../src/logs.ts";
import type { GResponse } from "../src/types.ts";

// ---------- 测试工具 ----------

async function* gen(chunks: GResponse[]): AsyncGenerator<GResponse> {
  for (const c of chunks) yield c;
}

async function collect(genx: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of genx) out.push(s);
  return out;
}

/** 从 "event: X\ndata: {json}" 帧提取事件名与解析后的 data */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseAnthropicEvent(frame: string): { event: string; data: any } {
  const m = /^event: ([^\n]+)\ndata: (.*)$/s.exec(frame.trim());
  assert.ok(m, "bad anthropic frame: " + frame);
  return { event: m[1], data: JSON.parse(m[2]) };
}

/** 从 "data: {json}" 帧提取解析后的 chunk（跳过 [DONE] 帧） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseOaiChunk(frame: string): any {
  assert.ok(frame.startsWith("data: "));
  const payload = frame.slice(6).trim();
  if (payload === "[DONE]") return { done: true };
  return JSON.parse(payload);
}

const THOUGHT_RESP: GResponse = {
  candidates: [
    {
      content: {
        role: "model",
        parts: [
          { text: "内部思考：用户想要天气", thought: true },
          { text: "北京今天 25 度。" },
        ],
      },
      finishReason: "STOP",
    },
  ],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 20, totalTokenCount: 35 },
};

// ---------- 1. thought 分流 ----------

test("isThoughtPart: 仅 thought:true 判定为思考摘要", () => {
  assert.equal(isThoughtPart({ text: "x", thought: true }), true);
  assert.equal(isThoughtPart({ text: "x" }), false);
  assert.equal(isThoughtPart({ text: "x", thought: false }), false);
  assert.equal(isThoughtPart({ functionCall: { name: "f", args: {} } }), false);
});

test("geminiToAnthropic: thought → thinking 块（带 signature），正文不混入思考", () => {
  const out = geminiToAnthropic(THOUGHT_RESP, "m", "msg_1") as { content: Array<Record<string, unknown>> };
  assert.equal(out.content.length, 2);
  assert.equal(out.content[0].type, "thinking");
  assert.equal(out.content[0].thinking, "内部思考：用户想要天气");
  assert.equal(out.content[0].signature, "");
  assert.equal(out.content[1].type, "text");
  assert.equal(out.content[1].text, "北京今天 25 度。");
});

test("geminiToOpenAI: thought → reasoning_content，content 不混入思考", () => {
  const out = geminiToOpenAI(THOUGHT_RESP, "m", "chatcmpl-1", 1) as {
    choices: Array<{ message: { content: string | null; reasoning_content?: string } }>;
  };
  assert.equal(out.choices[0].message.content, "北京今天 25 度。");
  assert.equal(out.choices[0].message.reasoning_content, "内部思考：用户想要天气");
});

test("geminiToOpenAI: 无 thought 时不输出 reasoning_content 字段（不污染普通响应）", () => {
  const g: GResponse = {
    candidates: [{ content: { role: "model", parts: [{ text: "普通回复" }] }, finishReason: "STOP" }],
  };
  const out = geminiToOpenAI(g, "m", "chatcmpl-2", 1) as {
    choices: Array<{ message: Record<string, unknown> }>;
  };
  assert.equal(out.choices[0].message.content, "普通回复");
  assert.equal("reasoning_content" in out.choices[0].message, false);
});

test("geminiSseToAnthropicEvents: thought → thinking 块完整事件序列（start/delta/signature/stop）", async () => {
  const frames: GResponse[] = [
    { candidates: [{ content: { role: "model", parts: [{ text: "思考片段", thought: true }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "正文" }] }, finishReason: "STOP" }] },
  ];
  const events = (await collect(gen2wrap())).map(parseAnthropicEvent);
  async function* gen2wrap(): AsyncGenerator<string> {
    yield* geminiSseToAnthropicEvents(gen(frames), "m", "msg_x");
  }
  const kinds = events.map((e) => e.event);
  assert.deepEqual(kinds, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(events[1].data.content_block.type, "thinking");
  assert.equal(events[2].data.delta.type, "thinking_delta");
  assert.equal(events[2].data.delta.thinking, "思考片段");
  assert.equal(events[3].data.delta.type, "signature_delta");
  assert.equal(events[5].data.content_block.type, "text");
  assert.equal(events[6].data.delta.text, "正文");
});

test("fakeStreamAnthropicEvents: thought → 单个 thinking 块 + 正文 text 块", async () => {
  const events = (await collect(fakeStreamAnthropicEvents(THOUGHT_RESP, "m", "msg_f"))).map(parseAnthropicEvent);
  const starts = events.filter((e) => e.event === "content_block_start");
  assert.equal(starts.length, 2);
  assert.equal(starts[0].data.content_block.type, "thinking");
  assert.equal(starts[1].data.content_block.type, "text");
  const thinkingDelta = events.find(
    (e) => e.event === "content_block_delta" && e.data.delta?.type === "thinking_delta",
  );
  assert.equal(thinkingDelta?.data.delta.thinking, "内部思考：用户想要天气");
  const textDelta = events.find((e) => e.event === "content_block_delta" && e.data.delta?.type === "text_delta");
  assert.equal(textDelta?.data.delta.text, "北京今天 25 度。");
});

test("geminiSseToOpenaiChunks: thought → reasoning_content delta，不进 content", async () => {
  const frames: GResponse[] = [
    { candidates: [{ content: { role: "model", parts: [{ text: "想想", thought: true }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "答" }] }, finishReason: "STOP" }] },
  ];
  const chunks = (await collect((async function* () {
    yield* geminiSseToOpenaiChunks(gen(frames), "m", "id", 1, false);
  })())).map(parseOaiChunk);
  const reasoningDeltas = chunks.filter((c) => c.choices?.[0]?.delta?.reasoning_content !== undefined);
  const contentDeltas = chunks.filter((c) => c.choices?.[0]?.delta?.content !== undefined);
  assert.equal(reasoningDeltas.length, 1);
  assert.equal(reasoningDeltas[0].choices[0].delta.reasoning_content, "想想");
  const contents = contentDeltas.map((c) => c.choices[0].delta.content).join("");
  assert.equal(contents, "答");
});

// ---------- 2. Anthropic 流式图像 ----------

test("geminiSseToAnthropicEvents: inlineData → markdown 文本块（图像不再丢失）", async () => {
  const frames: GResponse[] = [
    {
      candidates: [
        {
          content: { role: "model", parts: [{ inlineData: { mime_type: "image/png", data: "QUJD" } }] },
          finishReason: "STOP",
        },
      ],
    },
  ];
  const events = (await collect((async function* () {
    yield* geminiSseToAnthropicEvents(gen(frames), "m", "msg_img");
  })())).map(parseAnthropicEvent);
  const textStart = events.find((e) => e.event === "content_block_start");
  assert.equal(textStart?.data.content_block.type, "text");
  const textDelta = events.find((e) => e.event === "content_block_delta" && e.data.delta?.type === "text_delta");
  assert.equal(textDelta?.data.delta.text, "![image](data:image/png;base64,QUJD)");
});

test("fakeStreamAnthropicEvents: inlineData 聚合进文本（对齐非流式行为）", async () => {
  const g: GResponse = {
    candidates: [{ content: { role: "model", parts: [{ inlineData: { mime_type: "image/png", data: "QUJD" } }] }, finishReason: "STOP" }],
  };
  const events = (await collect(fakeStreamAnthropicEvents(g, "m", "msg_fi"))).map(parseAnthropicEvent);
  const textDelta = events.find((e) => e.event === "content_block_delta" && e.data.delta?.type === "text_delta");
  assert.equal(textDelta?.data.delta.text, "![image](data:image/png;base64,QUJD)");
});

// ---------- 3. 空响应兜底 ----------

test("geminiToAnthropic: 空候选（安全拒答）→ 补空 text 块，不再输出 content:[]", () => {
  const g: GResponse = { candidates: [{ finishReason: "SAFETY" }] };
  const out = geminiToAnthropic(g, "m", "msg_e") as { content: Array<Record<string, unknown>>; stop_reason: string };
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0].type, "text");
  assert.equal(out.content[0].text, "");
  assert.equal(out.stop_reason, "refusal");
});

test("geminiSseToAnthropicEvents: 空流收尾补空 text 块", async () => {
  const events = (await collect((async function* () {
    yield* geminiSseToAnthropicEvents(gen([{}]), "m", "msg_es");
  })())).map(parseAnthropicEvent);
  const starts = events.filter((e) => e.event === "content_block_start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].data.content_block.type, "text");
});

// ---------- 4. OpenAI 流式 prefill 剥离 ----------

test("geminiSseToOpenaiChunks: prefill 回声逐块剥离 + 流末冲刷残余", async () => {
  const frames: GResponse[] = [
    { candidates: [{ content: { role: "model", parts: [{ text: "前" }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "缀" }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "正文来了" }] }, finishReason: "STOP" }] },
  ];
  const chunks = (await collect((async function* () {
    yield* geminiSseToOpenaiChunks(gen(frames), "m", "id", 1, false, undefined, "前缀");
  })())).map(parseOaiChunk);
  const contents = chunks
    .filter((c) => c.choices?.[0]?.delta?.content !== undefined)
    .map((c) => c.choices[0].delta.content)
    .join("");
  assert.equal(contents, "正文来了");
});

test("geminiSseToOpenaiChunks: 前缀不匹配时全部放行（无误伤）", async () => {
  const frames: GResponse[] = [
    { candidates: [{ content: { role: "model", parts: [{ text: "完全不同的开头" }] }, finishReason: "STOP" }] },
  ];
  const chunks = (await collect((async function* () {
    yield* geminiSseToOpenaiChunks(gen(frames), "m", "id", 1, false, undefined, "前缀");
  })())).map(parseOaiChunk);
  const contents = chunks
    .filter((c) => c.choices?.[0]?.delta?.content !== undefined)
    .map((c) => c.choices[0].delta.content)
    .join("");
  assert.equal(contents, "前缀完全不同的开头");
});

// ---------- 5. sseResponseFromGenerator onDone ----------

test("sseResponseFromGenerator: 流正常结束 → onDone 恰好一次，body 完整", async () => {
  let calls = 0;
  async function* g(): AsyncGenerator<string> {
    yield "data: a\n\n";
    yield "data: b\n\n";
  }
  const resp = sseResponseFromGenerator(g(), null, () => {
    calls += 1;
  });
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("content-type") ?? "", /^text\/event-stream/);
  const text = await resp.text();
  assert.equal(text, "data: a\n\ndata: b\n\n");
  assert.equal(calls, 1);
});

test("sseResponseFromGenerator: 客户端取消 → onDone 调用且生成器被终止", async () => {
  let calls = 0;
  let genReturned = false;
  async function* g(): AsyncGenerator<string> {
    try {
      let i = 0;
      for (;;) {
        yield "data: " + i++ + "\n\n";
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      genReturned = true;
    }
  }
  const resp = sseResponseFromGenerator(g(), null, () => {
    calls += 1;
  });
  const reader = resp.body!.getReader();
  await reader.read(); // 读一帧
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1);
  assert.equal(genReturned, true);
});

test("sseResponseFromGenerator: 生成器抛错 → onDone 调用、错误透传到流", async () => {
  let calls = 0;
  async function* g(): AsyncGenerator<string> {
    yield "data: x\n\n";
    throw new Error("boom");
  }
  const resp = sseResponseFromGenerator(g(), null, () => {
    calls += 1;
  });
  await assert.rejects(() => resp.text(), /boom/);
  assert.equal(calls, 1);
});

// ---------- 6. protocolOf 新端点 ----------

test("protocolOf: v1.7.0 新端点归入 openai 协议家族", () => {
  assert.equal(protocolOf("/v1/responses"), "openai");
  assert.equal(protocolOf("/v1/audio/speech"), "openai");
  assert.equal(protocolOf("/v1/images/generations"), "openai");
  assert.equal(protocolOf("/v1/messages"), "anthropic");
  assert.equal(protocolOf("/v1beta/models"), "gemini");
  assert.equal(protocolOf("/v1/chat/completions"), "openai");
});
