// 协议转换层单元测试：OpenAI/Anthropic ⇄ Gemini + SSE 流转换
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSseStream, cleanJsonSchema, bytesToBase64, imageToInlineData } from "../src/convert/common.ts";
import { openaiToGemini, geminiToOpenAI, geminiSseToOpenaiChunks } from "../src/convert/openai.ts";
import { anthropicToGemini, geminiToAnthropic, geminiSseToAnthropicEvents } from "../src/convert/anthropic.ts";
import type { GResponse } from "../src/types.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// ===== SSE 解析 =====

test("parseSseStream handles CRLF and multi-line", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc('data: {"a":1}\r\n\r\ndata: {"b":2}\n\ndata: [DONE]\n\n'));
      c.close();
    },
  });
  const out: string[] = [];
  for await (const { data } of parseSseStream(body)) out.push(data);
  assert.deepEqual(out, ['{"a":1}', '{"b":2}', "[DONE]"]);
});

test("parseSseStream carries over split frames", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc("data: {\"x\":"));
      c.enqueue(enc("1}\n\n"));
      c.close();
    },
  });
  const out: string[] = [];
  for await (const { data } of parseSseStream(body)) out.push(data);
  assert.deepEqual(out, ['{"x":1}']);
});

// ===== OpenAI 请求转换 =====

test("openaiToGemini: system + multi-turn + images + tools", async () => {
  const oreq = {
    model: "gemini-3.7-flash",
    messages: [
      { role: "system", content: "你是助手" },
      { role: "developer", content: "规则2" },
      {
        role: "user",
        content: [
          { type: "text", text: "这是什么？" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"temp":25}' },
      { role: "user", content: "谢谢" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "查天气",
          parameters: { type: "object", properties: { city: { type: "string" } }, additionalProperties: false, $schema: "http://x" },
        },
      },
    ],
    tool_choice: "auto",
    temperature: 0.5,
    max_tokens: 100,
    stop: ["END"],
    response_format: { type: "json_object" },
  };
  const g = await openaiToGemini(oreq as never);

  assert.equal(g.systemInstruction?.parts.length, 2);
  assert.equal(g.contents.length, 4);
  assert.equal(g.contents[0].role, "user");
  // 图片：data URI → inlineData
  const imgPart = g.contents[0].parts[1] as { inlineData?: { mime_type: string; data: string } };
  assert.equal(imgPart.inlineData?.mime_type, "image/png");
  assert.equal(imgPart.inlineData?.data, "AAAA");
  // assistant tool_calls → model functionCall
  assert.deepEqual(g.contents[1].role, "model");
  const fc = g.contents[1].parts[0] as { functionCall?: { name: string; args?: unknown } };
  assert.deepEqual(fc.functionCall, { name: "get_weather", args: { city: "北京" } });
  // tool → functionResponse
  const fr = g.contents[2].parts[0] as { functionResponse?: { name: string; response: unknown } };
  assert.equal(fr.functionResponse?.name, "get_weather");
  assert.deepEqual(fr.functionResponse?.response, { result: { temp: 25 } });
  // tools → functionDeclarations，$schema/additionalProperties 被剥除
  const decl = g.tools?.[0].functionDeclarations?.[0];
  assert.equal(decl?.name, "get_weather");
  assert.ok(!("$schema" in (decl?.parameters ?? {})));
  assert.ok(!("additionalProperties" in (decl?.parameters ?? {})));
  // generationConfig
  assert.equal(g.generationConfig?.temperature, 0.5);
  assert.equal(g.generationConfig?.maxOutputTokens, 100);
  assert.deepEqual(g.generationConfig?.stopSequences, ["END"]);
  assert.equal(g.generationConfig?.responseMimeType, "application/json");
  // tool_choice auto → AUTO
  assert.equal(g.toolConfig?.functionCallingConfig?.mode, "AUTO");
});

test("openaiToGemini: tool_choice forced function", async () => {
  const g = await openaiToGemini({
    model: "gemini-3.7-flash",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "f1", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "f1" } },
  } as never);
  assert.deepEqual(g.toolConfig?.functionCallingConfig, { mode: "ANY", allowedFunctionNames: ["f1"] });
});

// ===== OpenAI 响应转换 =====

test("geminiToOpenAI: text + tool_calls + usage", () => {
  const g: GResponse = {
    candidates: [
      {
        content: { role: "model", parts: [{ text: "你好" }, { functionCall: { name: "f", args: { a: 1 } } }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };
  const out = geminiToOpenAI(g, "gemini-3.7-flash", "chatcmpl-x", 123);
  const choice = (out.choices as Array<Record<string, unknown>>)[0];
  assert.equal(choice.finish_reason, "tool_calls");
  const msg = choice.message as { role: string; content: string | null; tool_calls: Array<{ function: { name: string; arguments: string } }> };
  assert.equal(msg.content, "你好");
  assert.equal(msg.tool_calls[0].function.name, "f");
  assert.equal(msg.tool_calls[0].function.arguments, '{"a":1}');
  const usage = out.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  assert.deepEqual(usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test("geminiToOpenAI: finish reason mapping", () => {
  const mk = (fr: string): string =>
    (geminiToOpenAI({ candidates: [{ content: { role: "model", parts: [] }, finishReason: fr }] }, "m", "i", 0).choices as Array<{ finish_reason: string }>)[0]
      .finish_reason;
  assert.equal(mk("MAX_TOKENS"), "length");
  assert.equal(mk("SAFETY"), "content_filter");
  assert.equal(mk("STOP"), "stop");
  assert.equal(mk("OTHER"), "stop");
});

// ===== OpenAI 流式转换 =====

async function* gen(chunks: GResponse[]): AsyncGenerator<GResponse> {
  for (const c of chunks) yield c;
}

test("geminiSseToOpenaiChunks: text then finish then usage then DONE", async () => {
  const chunks: GResponse[] = [
    { candidates: [{ content: { role: "model", parts: [{ text: "你" }] } }], usageMetadata: { promptTokenCount: 3 } },
    { candidates: [{ content: { role: "model", parts: [{ text: "好" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } },
  ];
  const out: string[] = [];
  for await (const s of geminiSseToOpenaiChunks(gen(chunks), "gemini-3.7-flash", "id1", 1, true)) out.push(s);
  assert.ok(out[0].includes('"role"'));
  assert.ok(out[1].includes('"content":"你"'));
  assert.ok(out[2].includes('"content":"好"'));
  assert.ok(out[3].includes('"finish_reason":"stop"'));
  assert.ok(out[4].includes('"prompt_tokens":3'));
  assert.ok(out[4].includes('"choices":[]'));
  assert.equal(out[5], "data: [DONE]\n\n");
});

test("geminiSseToOpenaiChunks: tool call delta with index", async () => {
  const chunks: GResponse[] = [
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "f", args: { x: 2 } } }] }, finishReason: "STOP" }] },
  ];
  const out: string[] = [];
  for await (const s of geminiSseToOpenaiChunks(gen(chunks), "m", "id2", 1, false)) out.push(s);
  assert.ok(out.some((s) => s.includes('"tool_calls"') && s.includes('"index":0') && s.includes('"name":"f"')));
  assert.ok(out.some((s) => s.includes('"finish_reason":"tool_calls"')));
});

// ===== Anthropic 请求转换 =====

test("anthropicToGemini: system blocks + tool_use + tool_result + image url-less", async () => {
  const areq = {
    model: "gemini-3.7-flash",
    max_tokens: 200,
    system: [{ type: "text", text: "sys1" }],
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "我调用工具" },
          { type: "tool_use", id: "tu1", name: "lookup", input: { q: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: "工具结果文本" },
          { type: "text", text: "继续" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBCC" } },
        ],
      },
    ],
    tools: [{ name: "lookup", description: "d", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
    tool_choice: { type: "any" },
  };
  const g = await anthropicToGemini(areq as never);
  assert.equal(g.systemInstruction?.parts[0] && (g.systemInstruction.parts[0] as { text: string }).text, "sys1");
  assert.equal(g.contents[0].role, "model");
  assert.equal((g.contents[0].parts[0] as { text?: string }).text, "我调用工具");
  assert.deepEqual((g.contents[0].parts[1] as { functionCall?: unknown }).functionCall, { name: "lookup", args: { q: "x" } });
  // tool_result 名称来自 id 映射
  const fr = g.contents[1].parts[0] as { functionResponse?: { name: string; response: Record<string, unknown> } };
  assert.equal(fr.functionResponse?.name, "lookup");
  assert.deepEqual(fr.functionResponse?.response, { result: "工具结果文本" });
  const img = g.contents[1].parts[2] as { inlineData?: { data: string } };
  assert.equal(img.inlineData?.data, "BBCC");
  assert.equal(g.generationConfig?.maxOutputTokens, 200);
  assert.equal(g.toolConfig?.functionCallingConfig?.mode, "ANY");
});

// ===== Anthropic 响应转换 =====

test("geminiToAnthropic: blocks + stop_reason", () => {
  const g: GResponse = {
    candidates: [{ content: { role: "model", parts: [{ text: "答案" }, { functionCall: { name: "t", args: {} } }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 9, totalTokenCount: 16 },
  };
  const out = geminiToAnthropic(g, "gemini-3.7-flash", "msg_1");
  const content = out.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "tool_use");
  assert.equal(content[1].name, "t");
  assert.equal(out.stop_reason, "tool_use");
  assert.deepEqual(out.usage, { input_tokens: 7, output_tokens: 9 });
});

test("geminiSseToAnthropicEvents: full event sequence", async () => {
  const chunks: GResponse[] = [
    { candidates: [{ content: { role: "model", parts: [{ text: "AB" }] } }], usageMetadata: { promptTokenCount: 5 } },
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "fn", args: { k: "v" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 } },
  ];
  const events: string[] = [];
  for await (const s of geminiSseToAnthropicEvents(gen(chunks), "m", "msg_x")) events.push(s);

  assert.ok(events[0].startsWith("event: message_start"));
  assert.ok(events[1].startsWith("event: content_block_start"));
  assert.ok(events[1].includes('"type":"text"'));
  assert.ok(events[2].startsWith("event: content_block_delta"));
  assert.ok(events[2].includes('"text_delta"') && events[2].includes('"AB"'));
  // tool_use 块
  const toolStart = events.find((e) => e.startsWith("event: content_block_start") && e.includes("tool_use"));
  assert.ok(toolStart);
  const toolDelta = events.find((e) => e.includes("input_json_delta"));
  assert.ok(toolDelta);
  const deltaData = JSON.parse(toolDelta.split("\ndata: ")[1]) as { delta?: { partial_json?: string } };
  assert.equal(deltaData.delta?.partial_json, '{"k":"v"}');
  assert.ok(events.some((e) => e.startsWith("event: message_delta") && e.includes('"stop_reason":"tool_use"')));
  assert.ok(events[events.length - 1].startsWith("event: message_stop"));
});

// ===== Schema 清理 / base64 / 图片 =====

test("cleanJsonSchema strips unsupported keywords recursively", () => {
  const s = cleanJsonSchema({
    $schema: "x",
    type: "object",
    properties: { list: { type: "array", items: { type: "string", additionalProperties: false } } },
    additionalProperties: false,
  });
  assert.ok(!("$schema" in s));
  assert.ok(!("additionalProperties" in s));
  const items = (s.properties as { list: { items: Record<string, unknown> } }).list.items;
  assert.ok(!("additionalProperties" in items));
});

test("bytesToBase64 handles large binary", () => {
  const bytes = new Uint8Array(100000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const b64 = bytesToBase64(bytes);
  const rt = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  assert.deepEqual(Array.from(rt.slice(0, 100)), Array.from(bytes.slice(0, 100)));
});

test("imageToInlineData: data uri parse", async () => {
  const r = await imageToInlineData("data:image/webp;base64,QUJD");
  assert.deepEqual(r, { mime_type: "image/webp", data: "QUJD" });
});
