// OpenAI Chat Completions ⇄ Gemini 官方 API 转换
// 请求：messages(文本/图片/工具) → contents；tools → functionDeclarations
// 响应：candidates → choices；流式：Gemini SSE → OpenAI chat.completion.chunk
import type {
  GContent,
  GPart,
  GRequest,
  GResponse,
  GTool,
  GToolConfig,
  OContentPart,
  OMessage,
  ORequest,
} from "../types.ts";
import { bytesToBase64, cleanJsonSchema, imageToInlineData, isThoughtPart, partFunctionCall, partInlineData, partText, randomId, textPart } from "./common.ts";
import { reasoningEffortToLevel } from "../thinking.ts";
import { PrefillEchoFilter } from "../prefill.ts";

// ===== 请求转换 =====

function contentText(content: OMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

async function userParts(content: OMessage["content"]): Promise<GPart[]> {
  if (typeof content === "string") return content ? [textPart(content)] : [];
  const parts: GPart[] = [];
  for (const p of (content ?? []) as OContentPart[]) {
    if (p.type === "text") {
      parts.push(textPart(String((p as { text: string }).text ?? "")));
    } else if (p.type === "image_url") {
      const url = (p as { image_url?: { url?: string } }).image_url?.url;
      if (!url) continue;
      const inline = await imageToInlineData(url);
      if (inline) parts.push({ inlineData: inline } as GPart);
    }
  }
  return parts;
}

export async function openaiToGemini(req: ORequest): Promise<GRequest> {
  const g: GRequest = { contents: [] };
  const sysParts: GPart[] = [];

  // 先建立 tool_call_id → function name 映射（tool 角色消息要用）
  const idToName = new Map<string, string>();
  for (const m of req.messages) {
    for (const tc of m.tool_calls ?? []) idToName.set(tc.id, tc.function.name);
  }

  for (const m of req.messages) {
    if (m.role === "system" || m.role === "developer") {
      const t = contentText(m.content);
      if (t) sysParts.push(textPart(t));
      continue;
    }
    if (m.role === "assistant") {
      const parts: GPart[] = [];
      const t = contentText(m.content);
      if (t) parts.push(textPart(t));
      for (const tc of m.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: tc.function.name, args } } as GPart);
      }
      if (parts.length > 0) g.contents.push({ role: "model", parts });
      continue;
    }
    if (m.role === "tool") {
      const name = idToName.get(m.tool_call_id ?? "") ?? m.tool_call_id ?? "function";
      const resultText = contentText(m.content) || "ok";
      let response: Record<string, unknown>;
      try {
        response = { result: JSON.parse(resultText) };
      } catch {
        response = { result: resultText };
      }
      g.contents.push({ role: "user", parts: [{ functionResponse: { name, response } } as GPart] });
      continue;
    }
    // user
    const parts = await userParts(m.content);
    g.contents.push({ role: "user", parts: parts.length ? parts : [textPart("")] });
  }

  if (sysParts.length > 0) g.systemInstruction = { parts: sysParts };

  // tools
  if (req.tools && req.tools.length > 0) {
    const decls = req.tools
      .filter((t) => t.type === "function" && t.function)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description ?? "",
        parameters: t.function.parameters ? cleanJsonSchema(t.function.parameters) : { type: "object", properties: {} },
      }));
    if (decls.length > 0) {
      const tool: GTool = { functionDeclarations: decls };
      g.tools = [tool];
    }
  }

  // tool_choice
  if (req.tool_choice !== undefined && g.tools) {
    const tc: GToolConfig = { functionCallingConfig: { mode: "AUTO" } };
    if (req.tool_choice === "none") tc.functionCallingConfig = { mode: "NONE" };
    else if (req.tool_choice === "required") tc.functionCallingConfig = { mode: "ANY" };
    else if (typeof req.tool_choice === "object" && req.tool_choice?.function?.name) {
      tc.functionCallingConfig = { mode: "ANY", allowedFunctionNames: [req.tool_choice.function.name] };
    }
    g.toolConfig = tc;
  }

  // generationConfig
  const gc: GRequest["generationConfig"] = {};
  if (req.temperature !== undefined) gc.temperature = req.temperature;
  if (req.top_p !== undefined) gc.topP = req.top_p;
  if (req.seed !== undefined) gc.seed = req.seed;
  if (req.frequency_penalty !== undefined) gc.frequencyPenalty = req.frequency_penalty;
  if (req.presence_penalty !== undefined) gc.presencePenalty = req.presence_penalty;
  const maxTokens = req.max_completion_tokens ?? req.max_tokens;
  if (maxTokens !== undefined) gc.maxOutputTokens = maxTokens;
  if (req.stop !== undefined) gc.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.response_format?.type === "json_object") gc.responseMimeType = "application/json";
  if (req.response_format?.type === "json_schema") {
    gc.responseMimeType = "application/json";
    const schema = (req.response_format as { json_schema?: { schema?: unknown } }).json_schema?.schema;
    if (schema) gc.responseJsonSchema = cleanJsonSchema(schema);
  }
  // 思考强度：reasoning_effort（auto/default 不设置，让模型用默认行为）
  const effortLevel = reasoningEffortToLevel(req.reasoning_effort);
  if (effortLevel) gc.thinkingConfig = { thinkingLevel: effortLevel };
  if (Object.keys(gc).length > 0) g.generationConfig = gc;

  return g;
}

// ===== 响应转换（非流式） =====

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export function geminiUsageToOpenAI(g: GResponse | undefined): OpenAIUsage {
  const u = g?.usageMetadata ?? {};
  const completion = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  return {
    prompt_tokens: u.promptTokenCount ?? 0,
    completion_tokens: completion,
    total_tokens: u.totalTokenCount ?? (u.promptTokenCount ?? 0) + completion,
  };
}

function mapFinishReason(fr: string | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_calls";
  switch (fr) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
    case "SPII":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
      return "stop";
    case "RECITATION":
      return "content_filter";
    default:
      return "stop";
  }
}

export function geminiToOpenAI(g: GResponse, model: string, id: string, created: number): Record<string, unknown> {
  const cand = g.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  let text = "";
  let reasoning = ""; // 思考摘要聚合 → reasoning_content（DeepSeek R1 事实标准字段；无 thought 时不输出该字段）
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  for (const p of parts) {
    const t = partText(p);
    if (t !== undefined) {
      if (isThoughtPart(p)) reasoning += t;
      else text += t;
      continue;
    }
    const fc = partFunctionCall(p);
    if (fc) {
      toolCalls.push({
        id: randomId("call_"),
        type: "function",
        function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
      });
      continue;
    }
    // 图像模型（如 gemini-3.1-flash-image）返回的 inlineData → markdown data URI，聊天客户端可直接渲染
    const inline = partInlineData(p);
    if (inline) {
      text += "![image](data:" + (inline.mime_type || "image/png") + ";base64," + inline.data + ")\n";
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const finish = mapFinishReason(cand?.finishReason, toolCalls.length > 0);
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
    usage: geminiUsageToOpenAI(g),
    system_fingerprint: null,
  };
}

// ===== 流式转换 =====

/** Gemini SSE chunk → OpenAI chunk 序列生成器（工具调用按 index 累积）。
 *  v1.7.0：thought 思考摘要 → delta.reasoning_content（不再混入 content）；
 *  prefill 非空时对 content 增量做回声剥离状态机过滤（流末冲刷残余）。 */
export async function* geminiSseToOpenaiChunks(
  geminiChunks: AsyncIterable<GResponse>,
  model: string,
  id: string,
  created: number,
  includeUsage: boolean,
  onUsage?: (u: OpenAIUsage) => void,
  prefill?: string,
): AsyncGenerator<string> {
  let toolIndex = 0;
  let usage: OpenAIUsage | null = null;
  let finishSent = false;
  let sawToolCall = false;
  const filter = prefill ? new PrefillEchoFilter(prefill) : null;

  const chunkHeader = () => ({ id, object: "chat.completion.chunk", created, model });
  const emit = (chunk: Record<string, unknown>): string => "data: " + JSON.stringify(chunk) + "\n\n";
  const emitContent = (t: string, withLogprobs = true): string =>
    emit({
      ...chunkHeader(),
      choices: [{ index: 0, delta: { content: t }, finish_reason: null, ...(withLogprobs ? { logprobs: null } : {}) }],
    });

  // 首块：role
  yield emit({ ...chunkHeader(), choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });

  for await (const g of geminiChunks) {
    if (g.usageMetadata) {
      usage = geminiUsageToOpenAI(g);
      onUsage?.(usage);
    }
    const cand = g.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    for (const p of parts) {
      const t = partText(p);
      const fc = partFunctionCall(p);
      if (t) {
        if (isThoughtPart(p)) {
          // 思考摘要 → reasoning_content 增量（DeepSeek R1 风格）
          yield emit({
            ...chunkHeader(),
            choices: [{ index: 0, delta: { reasoning_content: t }, finish_reason: null }],
          });
        } else {
          const out = filter ? filter.feed(t) : t;
          if (out) yield emitContent(out);
        }
      } else if (fc) {
        sawToolCall = true;
        const tc = {
          index: toolIndex++,
          id: randomId("call_"),
          type: "function",
          function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
        };
        yield emit({
          ...chunkHeader(),
          choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }],
        });
      } else {
        const inline = partInlineData(p);
        if (inline) {
          yield emitContent("![image](data:" + (inline.mime_type || "image/png") + ";base64," + inline.data + ")\n");
        }
      }
    }
    if (cand?.finishReason && !finishSent) {
      finishSent = true;
      yield emit({
        ...chunkHeader(),
        choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(cand.finishReason, sawToolCall) }],
      });
    }
  }
  // 流末冲刷预填充过滤器残余（前缀歧义尾巴）
  if (filter) {
    const tail = filter.finish();
    if (tail) yield emitContent(tail);
  }
  if (!finishSent) {
    yield emit({
      ...chunkHeader(),
      choices: [{ index: 0, delta: {}, finish_reason: sawToolCall ? "tool_calls" : "stop" }],
    });
  }
  if (includeUsage && usage) {
    yield emit({ ...chunkHeader(), choices: [], usage });
  }
  yield "data: [DONE]\n\n";
}
