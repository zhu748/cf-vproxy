// OpenAI Responses API（/v1/responses）—— 完整移植自 vertex-master internal/api/responses_handler.go
//
// 面向无状态生成：支持 input、instructions、图片、函数工具（含 namespace）、结构化输出
// 和 SSE；previous_response_id / Conversations / OpenAI 托管工具不持久化不执行
// （web_search/image_generation/file_search/computer/code_interpreter 静默丢弃，对齐原项目）。
//
// 请求映射（responsesToChatRequest → 内部 OAI chat 形态 → 共享 Gemini 转换器）：
//   - reasoning.effort → reasoning_effort；text.format json_schema/json_object → response_format；
//   - instructions → 前置 system 消息；
//   - input 数组：message（含图片 part）、function_call（连续项聚合成一条 assistant 消息）、
//     function_call_output（tool 消息）、reasoning 项静默跳过（Codex 会回放）；
//   - namespace 工具：子工具名扁平化为 namespace__name，出站响应再还原。
//
// SSE 事件词汇（与原项目逐一对齐，sequence_number 单调递增）：
//   response.created → response.in_progress → [文本块: output_item.added → content_part.added →
//   output_text.delta* → output_text.done(含 annotations:[] + logprobs:[]) → content_part.done →
//   output_item.done] → [工具: output_item.added → function_call_arguments.delta →
//   function_call_arguments.done → output_item.done] → response.completed | response.incomplete
import { errOpenAI, json, randomId, partFunctionCall, partInlineData, partText } from "../convert/common.ts";
import { openaiToGemini } from "../convert/openai.ts";
import type { GPart, GResponse, ORequest, RInputItem, RRequest, RTool } from "../types.ts";
import { callGemini, finalizeGenerationConfig, mapUpstreamError, resolveModel, type HandlerCtx } from "../upstream.ts";
import { adaptPrefill, PrefillEchoFilter } from "../prefill.ts";
import { recordUsage, scheduleFlush } from "../usage.ts";
import { geminiJsonChunks, sseResponseFromGenerator } from "./sse.ts";
import { isThoughtPart } from "../convert/common.ts";

// ---------- 请求转换 ----------

interface ResponsesConversion {
  oreq: ORequest;
  namespaceTools: Map<string, { namespace: string; name: string }>; // 扁平名 → 原始名
}

function inputItemText(item: RInputItem): string {
  const c = item.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((p) => !p.type || p.type === "text" || p.type === "input_text" || p.type === "output_text")
      .map((p) => String(p.text ?? ""))
      .join("");
  }
  return "";
}

function flattenToolName(namespace: string, name: string): string {
  return namespace + "__" + name;
}

export function responsesToChatRequest(rreq: RRequest): { ok: true; conv: ResponsesConversion } | { ok: false; error: string } {
  const conv: ResponsesConversion = {
    oreq: {
      model: rreq.model,
      messages: [],
      stream: rreq.stream,
      temperature: rreq.temperature,
      top_p: rreq.top_p,
      max_completion_tokens: rreq.max_output_tokens,
      parallel_tool_calls: rreq.parallel_tool_calls,
    },
    namespaceTools: new Map(),
  };

  // reasoning.effort → reasoning_effort
  if (rreq.reasoning && typeof rreq.reasoning === "object") {
    const e = rreq.reasoning.effort;
    if (e !== undefined) {
      if (typeof e !== "string") return { ok: false, error: "reasoning.effort must be a string" };
      conv.oreq.reasoning_effort = e;
    }
  }

  // text.format → response_format
  if (rreq.text && typeof rreq.text === "object" && rreq.text.format && typeof rreq.text.format === "object") {
    const t = rreq.text.format.type;
    if (t === "json_schema") {
      conv.oreq.response_format = { type: "json_schema", json_schema: rreq.text.format.json_schema as Record<string, unknown> };
    } else if (t === "json_object") {
      conv.oreq.response_format = { type: "json_object" };
    }
  }

  // instructions → 前置 system 消息
  if (rreq.instructions !== undefined && rreq.instructions !== null) {
    let sys = "";
    if (typeof rreq.instructions === "string") sys = rreq.instructions;
    else if (Array.isArray(rreq.instructions)) {
      sys = rreq.instructions
        .filter((b) => !b.type || b.type === "text" || b.type === "input_text" || b.type === "output_text")
        .map((b) => String(b.text ?? ""))
        .join("\n");
    } else return { ok: false, error: "instructions must be a string or an array of content blocks" };
    if (sys) conv.oreq.messages.push({ role: "system", content: sys });
  }

  // tools：function + namespace；托管工具静默丢弃；其它类型 → 400
  const seenFunctions = new Set<string>();
  const oaiTools: Array<{ type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean } }> = [];
  if (Array.isArray(rreq.tools)) {
    for (const t of rreq.tools as RTool[]) {
      if (!t || typeof t !== "object") return { ok: false, error: "tools must be objects" };
      if (t.type === "function") {
        const f = t as { type: "function"; name?: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
        const name = f.name ?? (f as { function?: { name?: string } }).function?.name ?? "";
        if (!name) return { ok: false, error: "function tool requires a name" };
        if (seenFunctions.has(name)) return { ok: false, error: "duplicate function tool name: " + name };
        seenFunctions.add(name);
        oaiTools.push({
          type: "function",
          function: { name, description: f.description, parameters: f.parameters, strict: f.strict },
        });
      } else if (t.type === "namespace") {
        const ns = t as { type: "namespace"; name: string; tools?: Array<{ name?: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean }> };
        if (!ns.name) return { ok: false, error: "namespace tool requires a name" };
        for (const child of ns.tools ?? []) {
          if (!child.name) return { ok: false, error: "namespace tool child requires a name" };
          const flat = flattenToolName(ns.name, child.name);
          if (seenFunctions.has(flat)) return { ok: false, error: "duplicate function tool name: " + flat };
          seenFunctions.add(flat);
          conv.namespaceTools.set(flat, { namespace: ns.name, name: child.name });
          oaiTools.push({ type: "function", function: { name: flat, description: child.description, parameters: child.parameters, strict: child.strict } });
        }
      } else if (
        t.type === "web_search" ||
        t.type === "web_search_preview" ||
        t.type === "image_generation" ||
        t.type === "file_search" ||
        t.type === "computer" ||
        t.type === "code_interpreter"
      ) {
        // OpenAI 托管工具：静默丢弃（Codex 会自动附带）
        continue;
      } else {
        return { ok: false, error: "unsupported tool type: " + String(t.type) };
      }
    }
    if (oaiTools.length > 0) conv.oreq.tools = oaiTools;
  }

  // tool_choice
  if (rreq.tool_choice !== undefined) {
    if (typeof rreq.tool_choice === "string") {
      conv.oreq.tool_choice = rreq.tool_choice;
    } else if (rreq.tool_choice && typeof rreq.tool_choice === "object") {
      const tc = rreq.tool_choice as { type?: string; name?: string; function?: { name?: string } };
      if (tc.type === "function") {
        const name = tc.name ?? tc.function?.name;
        if (name) conv.oreq.tool_choice = { type: "function", function: { name } };
      } else {
        conv.oreq.tool_choice = rreq.tool_choice as ORequest["tool_choice"];
      }
    }
  }

  // input
  const pushUserContent = (content: string | Array<Record<string, unknown>>) => {
    conv.oreq.messages.push({ role: "user", content } as ORequest["messages"][number]);
  };
  if (typeof rreq.input === "string") {
    if (rreq.input) pushUserContent(rreq.input);
  } else if (Array.isArray(rreq.input)) {
    const items = rreq.input as RInputItem[];
    let pendingCalls: Array<{ id: string; name: string; args: string }> = [];
    const flushCalls = () => {
      if (pendingCalls.length === 0) return;
      conv.oreq.messages.push({
        role: "assistant",
        content: null,
        tool_calls: pendingCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.args },
        })),
      } as ORequest["messages"][number]);
      pendingCalls = [];
    };
    for (const item of items) {
      if (!item || typeof item !== "object") return { ok: false, error: "input items must be objects" };
      const type = item.type ?? "message";
      if (type === "reasoning") continue; // Codex 回放的推理项：静默跳过
      if (type === "function_call") {
        const name = String(item.name ?? "");
        if (!name) return { ok: false, error: "function_call item requires a name" };
        const callId = String(item.call_id ?? item.id ?? randomId("call_"));
        let args: string;
        if (item.arguments === undefined || item.arguments === null) args = "{}";
        else if (typeof item.arguments === "string") args = item.arguments;
        else args = JSON.stringify(item.arguments);
        pendingCalls.push({ id: callId, name, args });
        continue;
      }
      if (type === "function_call_output") {
        flushCalls();
        const callId = String(item.call_id ?? item.id ?? "");
        let output = item.output;
        if (output === undefined || output === null) output = "";
        else if (typeof output !== "string") output = JSON.stringify(output);
        conv.oreq.messages.push({ role: "tool", tool_call_id: callId, content: String(output) } as ORequest["messages"][number]);
        continue;
      }
      if (type === "message" || type === "") {
        flushCalls();
        const role = item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user";
        const c = item.content;
        if (typeof c === "string") {
          conv.oreq.messages.push({ role, content: c } as ORequest["messages"][number]);
        } else if (Array.isArray(c)) {
          const parts: Array<Record<string, unknown>> = [];
          for (const p of c) {
            const ptype = p.type ?? "text";
            if (ptype === "text" || ptype === "input_text" || ptype === "output_text") {
              parts.push({ type: "text", text: String(p.text ?? "") });
            } else if (ptype === "input_image") {
              const iu = p.image_url;
              const url = typeof iu === "string" ? iu : (iu as { url?: string } | undefined)?.url;
              if (url) {
                const detail = typeof iu === "object" && iu !== null ? (iu as { detail?: string }).detail : undefined;
                parts.push({ type: "image_url", image_url: detail ? { url, detail } : { url } });
              }
            }
            // 其它 part 类型忽略（与原项目一致）
          }
          conv.oreq.messages.push({ role, content: parts } as ORequest["messages"][number]);
        } else {
          return { ok: false, error: "message item content must be a string or an array of parts" };
        }
        continue;
      }
      return { ok: false, error: "unsupported input item type: " + String(type) };
    }
    flushCalls();
  } else if (rreq.input !== undefined) {
    return { ok: false, error: "input must be a string or an array of items" };
  }

  return { ok: true, conv };
}

// ---------- 输出信封 ----------

interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

function responsesUsage(g: GResponse | undefined): ResponsesUsage {
  const u = g?.usageMetadata ?? {};
  const prompt = u.promptTokenCount ?? 0;
  const completion = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  return {
    input_tokens: prompt,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: completion,
    output_tokens_details: { reasoning_tokens: u.thoughtsTokenCount ?? 0 },
    total_tokens: u.totalTokenCount ?? prompt + completion,
  };
}

function incompleteReasonFor(finishReason: string | undefined): string | undefined {
  switch (finishReason) {
    case "MAX_TOKENS":
    case "LENGTH":
      return "max_output_tokens";
    case "SAFETY":
    case "CONTENT_FILTER":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
    case "SPII":
      return "content_filter";
    default:
      return undefined;
  }
}

function echoEnvelope(rreq: RRequest, id: string, created: number): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: created,
    status: "in_progress",
    error: null,
    incomplete_details: null,
    instructions: rreq.instructions ?? null,
    max_output_tokens: rreq.max_output_tokens ?? null,
    metadata: rreq.metadata ?? {},
    model: rreq.model,
    parallel_tool_calls: rreq.parallel_tool_calls ?? true,
    previous_response_id: rreq.previous_response_id ?? null,
    reasoning: rreq.reasoning ?? { effort: null, summary: null },
    store: rreq.store ?? false,
    temperature: rreq.temperature ?? 1,
    text: rreq.text ?? { format: { type: "text" } },
    tool_choice: rreq.tool_choice ?? "auto",
    tools: rreq.tools ?? [],
    top_p: rreq.top_p ?? 1,
    truncation: rreq.truncation ?? "disabled",
    usage: null,
    user: null,
  };
}

function functionCallOutputItem(
  name: string,
  args: Record<string, unknown> | undefined,
  callId: string,
  namespaceTools: Map<string, { namespace: string; name: string }>,
): Record<string, unknown> {
  const ns = namespaceTools.get(name);
  const item: Record<string, unknown> = {
    id: randomId("fc_"),
    type: "function_call",
    status: "completed",
    arguments: JSON.stringify(args ?? {}),
    call_id: callId,
    name: ns ? ns.name : name,
    output: null,
  };
  if (ns) item.namespace = ns.namespace;
  return item;
}

/** 非流式：GResponse → 完整 Responses 信封 */
export function geminiToResponsesEnvelope(
  g: GResponse,
  rreq: RRequest,
  conv: ResponsesConversion,
  id: string,
  created: number,
  prefill: string,
): Record<string, unknown> {
  const cand = g.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  let text = "";
  const output: Array<Record<string, unknown>> = [];
  const toolItems: Array<Record<string, unknown>> = [];
  for (const p of parts) {
    const t = partText(p);
    if (t !== undefined) {
      if (isThoughtPart(p)) continue; // v1.7.0：思考摘要不混入 output_text（Responses 语义无对应块，丢弃）
      text += t;
      continue;
    }
    const fc = partFunctionCall(p);
    if (fc) {
      toolItems.push(functionCallOutputItem(fc.name, fc.args, randomId("call_"), conv.namespaceTools));
      continue;
    }
    const inline = partInlineData(p);
    if (inline) {
      text += "![image](data:" + (inline.mime_type || "image/png") + ";base64," + inline.data + ")\n";
    }
  }
  // 预填充回声剥离
  if (prefill) text = text.startsWith(prefill) ? text.slice(prefill.length) : text;
  if (text || toolItems.length === 0) {
    output.push({
      id: randomId("msg_"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
    });
  }
  output.push(...toolItems);

  const reason = incompleteReasonFor(cand?.finishReason);
  const envelope = echoEnvelope(rreq, id, created);
  envelope.status = reason ? "incomplete" : "completed";
  envelope.incomplete_details = reason ? { reason } : null;
  envelope.output = output;
  envelope.usage = responsesUsage(g);
  return envelope;
}

// ---------- 流式事件生成 ----------

function sseEvent(name: string, data: Record<string, unknown>): string {
  return "event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n";
}

/**
 * Gemini SSE chunk 流 → Responses SSE 事件流。
 * 与原项目一致：sequence_number 单调递增；文本块先开后写；工具调用强制先关文本块。
 */
export async function* geminiChunksToResponsesEvents(
  geminiChunks: AsyncIterable<GResponse>,
  rreq: RRequest,
  conv: ResponsesConversion,
  displayModel: string,
  id: string,
  created: number,
  prefill: string,
  onUsage?: (u: ResponsesUsage) => void,
): AsyncGenerator<string> {
  let seq = 0;
  const nextSeq = () => ++seq;
  const ev = (name: string, data: Record<string, unknown>): string =>
    sseEvent(name, { ...data, sequence_number: nextSeq(), type: name });

  const envelope = echoEnvelope(rreq, id, created);
  const createdFrame = { ...envelope, status: "in_progress" };
  yield ev("response.created", { response: createdFrame });
  yield ev("response.in_progress", { response: createdFrame });

  let outputIndex = -1; // 每个 output item 自增一次
  let textOpen = false;
  let textItemId = "";
  let textAccum = "";
  const filter = prefill ? new PrefillEchoFilter(prefill) : null;
  const toolItems: Array<Record<string, unknown>> = [];
  let usage: ResponsesUsage | null = null;
  let finishReason: string | undefined;
  let failed = false;

  const closeTextBlock = function* (): Generator<string> {
    if (!textOpen) return;
    textOpen = false;
    const finalText = filter ? textAccum : textAccum;
    yield ev("response.output_text.done", {
      item_id: textItemId,
      output_index: outputIndex,
      content_index: 0,
      text: finalText,
      logprobs: [],
    });
    yield ev("response.content_part.done", {
      item_id: textItemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: finalText, annotations: [], logprobs: [] },
    });
    yield ev("response.output_item.done", {
      output_index: outputIndex,
      item: {
        id: textItemId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: finalText, annotations: [], logprobs: [] }],
      },
    });
  };

  for await (const g of geminiChunks) {
    if (g.usageMetadata) {
      usage = responsesUsage(g);
      onUsage?.(usage);
    }
    const cand = g.candidates?.[0];
    if (cand?.finishReason) finishReason = cand.finishReason;
    const parts = cand?.content?.parts ?? [];
    for (const p of parts as GPart[]) {
      const t = partText(p);
      if (t !== undefined) {
        if (isThoughtPart(p)) continue; // v1.7.0：思考摘要不混入 output_text.delta
        const out = filter ? filter.feed(t) : t;
        if (!out) continue;
        if (!textOpen) {
          outputIndex++;
          textOpen = true;
          textAccum = "";
          textItemId = randomId("msg_");
          yield ev("response.output_item.added", {
            output_index: outputIndex,
            item: { id: textItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
          });
          yield ev("response.content_part.added", {
            item_id: textItemId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [], logprobs: [] },
          });
        }
        textAccum += out;
        yield ev("response.output_text.delta", {
          item_id: textItemId,
          output_index: outputIndex,
          content_index: 0,
          delta: out,
          logprobs: [],
        });
        continue;
      }
      const fc = partFunctionCall(p);
      if (fc) {
        // 工具调用强制关闭打开中的文本块
        yield* closeTextBlock();
        outputIndex++;
        const callId = randomId("call_");
        const ns = conv.namespaceTools.get(fc.name);
        const argsStr = JSON.stringify(fc.args ?? {});
        const item: Record<string, unknown> = {
          id: randomId("fc_"),
          type: "function_call",
          status: "in_progress",
          arguments: "",
          call_id: callId,
          name: ns ? ns.name : fc.name,
          output: null,
        };
        if (ns) item.namespace = ns.namespace;
        yield ev("response.output_item.added", { output_index: outputIndex, item });
        yield ev("response.function_call_arguments.delta", {
          item_id: item.id,
          output_index: outputIndex,
          delta: argsStr,
        });
        yield ev("response.function_call_arguments.done", {
          item_id: item.id,
          output_index: outputIndex,
          arguments: argsStr,
        });
        const doneItem = { ...item, status: "completed", arguments: argsStr };
        toolItems.push(doneItem);
        yield ev("response.output_item.done", { output_index: outputIndex, item: doneItem });
        continue;
      }
    }
  }

  // 冲刷预填充残余
  if (filter && textOpen) {
    const tail = filter.finish();
    if (tail) {
      textAccum += tail;
      yield ev("response.output_text.delta", {
        item_id: textItemId,
        output_index: outputIndex,
        content_index: 0,
        delta: tail,
        logprobs: [],
      });
    }
  }
  yield* closeTextBlock();

  if (failed) return;

  // 最终信封
  const finalOutput: Array<Record<string, unknown>> = [];
  if (textAccum || toolItems.length === 0) {
    finalOutput.push({
      id: textItemId || randomId("msg_"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: textAccum, annotations: [], logprobs: [] }],
    });
  }
  finalOutput.push(...toolItems);

  const reason = incompleteReasonFor(finishReason);
  const finalEnvelope = echoEnvelope(rreq, id, created);
  finalEnvelope.model = displayModel;
  finalEnvelope.status = reason ? "incomplete" : "completed";
  finalEnvelope.incomplete_details = reason ? { reason } : null;
  finalEnvelope.output = finalOutput;
  finalEnvelope.usage = usage ?? responsesUsage(undefined);

  yield ev(reason ? "response.incomplete" : "response.completed", { response: finalEnvelope });
}

// ---------- 处理器 ----------

export async function handleResponses(req: Request, ctx: HandlerCtx): Promise<Response> {
  let rreq: RRequest;
  try {
    rreq = (await req.json()) as RRequest;
  } catch {
    return errOpenAI(400, "Invalid JSON body");
  }
  if (!rreq || typeof rreq !== "object") return errOpenAI(400, "request body is required");
  if (!rreq.model) return errOpenAI(400, "model is required");

  const resolved = resolveModel(ctx.cfg, rreq.model, true);
  if (!resolved.ok) return errOpenAI(resolved.status ?? 400, resolved.message ?? "model error");

  const conv = responsesToChatRequest(rreq);
  if (!conv.ok) return errOpenAI(400, conv.error);

  const id = "resp_" + randomId("").replace(/[^a-z0-9]/gi, "").slice(0, 24);
  const created = Math.floor(Date.now() / 1000);

  let greq;
  try {
    greq = await openaiToGemini(conv.conv.oreq);
  } catch (e) {
    return errOpenAI(400, "convert request failed: " + (e instanceof Error ? e.message : String(e)));
  }
  greq.generationConfig = finalizeGenerationConfig(ctx.cfg, resolved.model, greq.generationConfig);
  // 预填充适配（Gemini 3.6+：末轮 model 纯文本时追加续写提示/JSON 指令）
  const adapted = adaptPrefill(resolved.model, greq.contents);
  greq.contents = adapted.payload.contents;

  // 假流式：fake- 前缀或 aggregate_stream → 非流式上游 + 合成事件序列
  const fake = resolved.fake || ctx.cfg.aggregate_stream;
  const wantStream = rreq.stream === true || fake;

  const action = wantStream && !fake ? "streamGenerateContent" : "generateContent";
  let upstream: Response;
  try {
    upstream = await callGemini(ctx, resolved.model, action, JSON.stringify(greq));
  } catch (e) {
    return errOpenAI(502, "upstream request failed: " + (e instanceof Error ? e.message : String(e)));
  }
  if (!upstream.ok) return await mapUpstreamError(upstream, "openai");

  // ---- 非流式 ----
  if (!wantStream) {
    let g: GResponse;
    try {
      g = (await upstream.json()) as GResponse;
    } catch (e) {
      return errOpenAI(502, "invalid upstream response: " + (e instanceof Error ? e.message : String(e)));
    }
    const envelope = geminiToResponsesEnvelope(g, rreq, conv.conv, id, created, adapted.prefill);
    const usage = envelope.usage as ResponsesUsage;
    recordUsage(ctx.clientKey, resolved.model, usage.input_tokens, usage.output_tokens);
    ctx.waitUntil(scheduleFlush(ctx.env));
    return json(envelope);
  }

  // ---- 流式（真流式或假流式） ----
  let chunks: AsyncIterable<GResponse>;
  if (fake) {
    let g: GResponse;
    try {
      g = (await upstream.json()) as GResponse;
    } catch (e) {
      return errOpenAI(502, "invalid upstream response: " + (e instanceof Error ? e.message : String(e)));
    }
    chunks = (async function* () {
      yield g;
    })();
  } else {
    if (!upstream.body) return errOpenAI(502, "empty upstream stream");
    chunks = geminiJsonChunks(upstream.body);
  }

  let lastUsage: ResponsesUsage | null = null;
  const events = geminiChunksToResponsesEvents(
    chunks,
    rreq,
    conv.conv,
    resolved.display ?? rreq.model,
    id,
    created,
    adapted.prefill,
    (u) => {
      lastUsage = u;
    },
  );
  // v1.7.0：统一走 sseResponseFromGenerator（补 10s ping 保活；旧手写流长思考请求会被空闲超时掐断）
  let usageRecorded = false;
  const recordStreamUsage = () => {
    if (usageRecorded) return;
    usageRecorded = true;
    recordUsage(ctx.clientKey, resolved.model, lastUsage?.input_tokens ?? 0, lastUsage?.output_tokens ?? 0);
    ctx.waitUntil(scheduleFlush(ctx.env));
  };
  return sseResponseFromGenerator(events, upstream, recordStreamUsage);
}
