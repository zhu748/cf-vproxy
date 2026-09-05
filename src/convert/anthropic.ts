// Anthropic Messages ⇄ Gemini 官方 API 转换
// 请求：system/messages/content blocks(文本/图片/PDF/工具) → contents
// 响应：candidates → content blocks；流式：Gemini SSE → Anthropic SSE 事件序列
import type {
  AContentBlock,
  AMessage,
  ARequest,
  GContent,
  GPart,
  GRequest,
  GResponse,
} from "../types.ts";
import { imageToInlineData, partFunctionCall, partInlineData, partText, randomId, textPart } from "./common.ts";
import { anthropicThinkingToConfig } from "../thinking.ts";
import { applyClaudePromptPolicy, type ClaudePromptPolicy } from "../promptpolicy.ts";

// ===== 请求转换 =====

export interface AnthropicConvertOpts {
  /** Claude 提示词策略（推广剥离/安全前言替换/自定义替换/注入，含诊断记录）；不传则跳过 */
  policy?: ClaudePromptPolicy;
  /** 诊断端点标签（"generate" | "count_tokens"） */
  endpoint?: string;
  /** 客户端请求的模型名（规则过滤用） */
  clientModel?: string;
  /** 别名解析后的真实模型名（规则过滤用） */
  resolvedModel?: string;
}

export async function anthropicToGemini(req: ARequest, opts?: AnthropicConvertOpts): Promise<GRequest> {
  const g: GRequest = { contents: [] };
  const sysParts: GPart[] = [];

  if (req.system) {
    let texts =
      typeof req.system === "string"
        ? [req.system]
        : (req.system ?? []).filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
    texts = texts.filter((x) => x);
    // Claude 提示词策略（原项目 claude_prompt.go）：推广剥离 → 安全前言替换 → 自定义规则 → 注入；
    // 诊断按 endpoint（generate / count_tokens）分开记录
    if (opts?.policy && texts.length > 0) {
      const applied = await applyClaudePromptPolicy(
        opts.policy,
        texts,
        opts.clientModel ?? req.model,
        opts.resolvedModel ?? req.model,
        opts.endpoint ?? "generate",
      );
      texts = applied.segments;
    }
    const t = texts.filter((x) => x && x.trim()).join("\n\n");
    if (t) sysParts.push(textPart(t));
  }

  // tool_use_id → name 映射（tool_result 需要函数名）
  const idToName = new Map<string, string>();
  for (const m of req.messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_use") idToName.set((b as { id: string }).id, (b as { name: string }).name);
      }
    }
  }

  const emitBlocks = async (role: "user" | "assistant", blocks: AContentBlock[]): Promise<GContent | null> => {
    const parts: GPart[] = [];
    for (const b of blocks) {
      if (b.type === "text") {
        const t = (b as { text: string }).text;
        if (t) parts.push(textPart(t));
      } else if (b.type === "image") {
        const source = (b as { source: { type: string; url?: string; media_type?: string; data?: string } }).source;
        if (source.type === "base64" && source.data) {
          parts.push({ inlineData: { mime_type: source.media_type ?? "image/png", data: source.data } } as GPart);
        } else if (source.type === "url" && source.url) {
          const inline = await imageToInlineData(source.url);
          if (inline) parts.push({ inlineData: inline } as GPart);
        }
      } else if (b.type === "document") {
        const source = (b as { source: { media_type?: string; data?: string } }).source;
        if (source?.data) {
          parts.push({ inlineData: { mime_type: source.media_type ?? "application/pdf", data: source.data } } as GPart);
        }
      } else if (b.type === "tool_use") {
        const tu = b as { name: string; input: Record<string, unknown> };
        parts.push({ functionCall: { name: tu.name, args: tu.input ?? {} } } as GPart);
      } else if (b.type === "tool_result") {
        const tr = b as { tool_use_id: string; content?: string | AContentBlock[]; is_error?: boolean };
        const name = idToName.get(tr.tool_use_id) ?? tr.tool_use_id;
        let inner = "";
        if (typeof tr.content === "string") inner = tr.content;
        else if (Array.isArray(tr.content)) {
          inner = tr.content
            .filter((x) => x.type === "text")
            .map((x) => (x as { text: string }).text)
            .join("\n");
        }
        let response: Record<string, unknown>;
        try {
          response = { result: JSON.parse(inner) };
        } catch {
          response = { result: inner || "ok" };
        }
        if (tr.is_error) response.is_error = true;
        parts.push({ functionResponse: { name, response } } as GPart);
      }
      // thinking / 其他块忽略
    }
    if (parts.length === 0) return null;
    return { role: role === "assistant" ? "model" : "user", parts };
  };

  for (const m of req.messages as AMessage[]) {
    // Claude Code 排队消息可能把 system turn 塞进 messages[] 中途（Gemini 只支持请求级
    // systemInstruction）：按原项目 lowerAnthropicMidConversationSystemTurns 语义降为 user
    if (m.role === "system") {
      const blocks: AContentBlock[] =
        typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
      const c = await emitBlocks("user", blocks);
      if (c) g.contents.push(c);
      continue;
    }
    const blocks: AContentBlock[] =
      typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    const c = await emitBlocks(m.role === "assistant" ? "assistant" : "user", blocks);
    if (c) g.contents.push(c);
  }

  if (sysParts.length > 0) g.systemInstruction = { parts: sysParts };

  if (req.tools && req.tools.length > 0) {
    g.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          parameters: t.input_schema as Record<string, unknown>,
        })),
      },
    ];
  }

  if (req.tool_choice) {
    const mode = req.tool_choice.type;
    g.toolConfig = {
      functionCallingConfig:
        mode === "auto"
          ? { mode: "AUTO" }
          : mode === "any"
            ? { mode: "ANY" }
            : { mode: "ANY", allowedFunctionNames: [req.tool_choice.name ?? ""] },
    };
  }

  const gc: GRequest["generationConfig"] = {};
  if (req.max_tokens) gc.maxOutputTokens = req.max_tokens;
  if (req.temperature !== undefined) gc.temperature = req.temperature;
  if (req.top_p !== undefined) gc.topP = req.top_p;
  if (req.top_k !== undefined) gc.topK = req.top_k;
  if (req.stop_sequences?.length) gc.stopSequences = req.stop_sequences;
  // 思考强度：thinking.budget_tokens（Claude Code）/ output_config.effort（新 API）
  const effort =
    req.output_config && typeof req.output_config === "object" ? (req.output_config as { effort?: string }).effort : undefined;
  if (req.thinking) {
    const tc = anthropicThinkingToConfig(req.thinking, (req.thinking as { display?: unknown }).display);
    if (tc) gc.thinkingConfig = tc;
  } else if (typeof effort === "string" && effort && !["auto", "default"].includes(effort.toLowerCase())) {
    const lvl = effort.trim().toUpperCase();
    const level = lvl === "XHIGH" || lvl === "MAX" ? "HIGH" : (lvl as "LOW" | "MEDIUM" | "HIGH");
    if (["LOW", "MEDIUM", "HIGH"].includes(level)) gc.thinkingConfig = { thinkingLevel: level };
  }
  if (Object.keys(gc).length > 0) g.generationConfig = gc;

  return g;
}

// ===== 响应转换（非流式） =====

function mapStopReason(finishReason: string | undefined, hasToolUse: boolean): string {
  if (hasToolUse) return "tool_use";
  switch (finishReason) {
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
    case "SPII":
    case "RECITATION":
      return "refusal";
    default:
      return "end_turn";
  }
}

export function geminiToAnthropic(g: GResponse, model: string, id: string): Record<string, unknown> {
  const cand = g.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const content: Array<Record<string, unknown>> = [];
  for (const p of parts) {
    const t = partText(p);
    if (t) {
      content.push({ type: "text", text: t });
      continue;
    }
    const fc = partFunctionCall(p);
    if (fc) {
      content.push({ type: "tool_use", id: randomId("toolu_"), name: fc.name, input: fc.args ?? {} });
      continue;
    }
    // 图像模型输出 → markdown data URI 文本块（Anthropic 无图像输出块类型）
    const inline = partInlineData(p);
    if (inline) {
      content.push({
        type: "text",
        text: "![image](data:" + (inline.mime_type || "image/png") + ";base64," + inline.data + ")",
      });
    }
  }
  const hasToolUse = content.some((c) => c.type === "tool_use");
  const u = g.usageMetadata ?? {};
  const output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReason(cand?.finishReason, hasToolUse),
    stop_sequence: null,
    usage: { input_tokens: u.promptTokenCount ?? 0, output_tokens: output },
  };
}

// ===== 流式转换 =====

/**
 * Gemini SSE chunk 流 → Anthropic SSE 事件流。
 * 事件序列：message_start → (text / tool_use 块 start+delta+stop)* → message_delta → message_stop
 */
export async function* geminiSseToAnthropicEvents(
  geminiChunks: AsyncIterable<GResponse>,
  model: string,
  id: string,
  onUsage?: (inputTokens: number, outputTokens: number) => void,
): AsyncGenerator<string> {
  let blockIndex = -1;
  let textOpen = false;
  let lastOutputTokens = 0;
  let inputTokens = 0;
  let stopReason: string | null = null;
  let sawToolUse = false;

  const ev = (name: string, data: unknown): string => "event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n";

  yield ev("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const openTextBlock = () => {
    blockIndex += 1;
    textOpen = true;
    return ev("content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "" },
    });
  };

  for await (const g of geminiChunks) {
    if (g.usageMetadata) {
      if (g.usageMetadata.promptTokenCount !== undefined) inputTokens = g.usageMetadata.promptTokenCount;
      lastOutputTokens = (g.usageMetadata.candidatesTokenCount ?? 0) + (g.usageMetadata.thoughtsTokenCount ?? 0);
      onUsage?.(inputTokens, lastOutputTokens);
    }
    const cand = g.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    for (const p of parts) {
      const t = partText(p);
      const fc = partFunctionCall(p);
      if (t) {
        if (!textOpen) yield openTextBlock();
        yield ev("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: t },
        });
      } else if (fc) {
        if (textOpen) {
          yield ev("content_block_stop", { type: "content_block_stop", index: blockIndex });
          textOpen = false;
        }
        sawToolUse = true;
        blockIndex += 1;
        yield ev("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id: randomId("toolu_"), name: fc.name, input: {} },
        });
        yield ev("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(fc.args ?? {}) },
        });
        yield ev("content_block_stop", { type: "content_block_stop", index: blockIndex });
      }
    }
    if (cand?.finishReason) stopReason = mapStopReason(cand.finishReason, sawToolUse);
  }

  if (textOpen) {
    yield ev("content_block_stop", { type: "content_block_stop", index: blockIndex });
  }
  yield ev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason ?? (sawToolUse ? "tool_use" : "end_turn"), stop_sequence: null },
    usage: { output_tokens: lastOutputTokens, input_tokens: inputTokens },
  });
  yield ev("message_stop", { type: "message_stop" });
}
