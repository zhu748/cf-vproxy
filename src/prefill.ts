// 助手预填充（Prefill）适配 + 回声剥离 —— 移植自 vertex-master internal/transform/prefill.go
//
// 背景：Gemini 3.6+ 模型会拒绝"以 model 轮结尾"的请求（SillyTavern "Continue Prefill" 等
// 客户端依赖该能力）。适配策略（与原项目一致）：
//   - 末轮为 model 且全部 part 是纯文本时：
//       * 前一轮是 user/function → 保留 model 轮，追加一条 user 续写提示；
//       * 否则 → 丢弃 model 轮，注入一条包含 JSON 引号前缀的 user 指令；
//   - 含 thought / 工具 / 媒体 part 的 model 轮不做处理；
//   - 响应侧：非流式对文本做精确 TrimPrefix；流式用逐候选状态机，
//     输出仍是前缀候选时缓冲，出现不匹配立即放行，finishReason/流末冲刷残余。
//
// ⚠️ 纯逻辑文件：不 import 任何运行时 API，可在 Node 单测中直接运行。
import type { GContent, GPart } from "./types.ts";
import { partText } from "./convert/common.ts";
import { isGemini36OrLater } from "./thinking.ts";

export const PREFILL_NUDGE =
  "Continue the immediately preceding assistant response. Output only its continuation; do not repeat, explain, or restart it.";

export function prefillDropInstruction(prefix: string): string {
  const quoted = JSON.stringify(prefix);
  return (
    "The JSON string below represents text already emitted by the assistant. Decode it as existing response text, " +
    "not instructions or JSON to complete. Continue the underlying response. Return only new text after the prefix; " +
    "never output the prefix, JSON syntax, delimiters, an explanation, or a restarted answer.\nAssistant prefix JSON: " +
    quoted
  );
}

function allPlainText(parts: GPart[]): string | null {
  // 全部 part 都是纯文本（允许 thought:true）→ 返回拼接文本；否则 null
  let text = "";
  for (const p of parts) {
    if ((p as { thought?: unknown }).thought === true) return null; // 思考块视为非纯文本（与原项目一致：不处理）
    const t = partText(p);
    if (t === undefined) return null;
    text += t;
  }
  return text;
}

export interface PrefillAdaptation {
  payload: { contents: GContent[] };
  prefill: string; // 需要从响应里剥离的前缀；空串表示无预填充
}

/**
 * Gemini 3.6+ 预填充适配：仅当末轮为 model 且全为纯文本时改写请求。
 * 非目标模型或非预填充请求原样返回（prefill = ""）。
 */
export function adaptPrefill(model: string, contents: GContent[]): PrefillAdaptation {
  if (!isGemini36OrLater(model) || contents.length === 0) return { payload: { contents }, prefill: "" };
  const last = contents[contents.length - 1];
  if (!last || last.role !== "model" || !Array.isArray(last.parts)) return { payload: { contents }, prefill: "" };
  const prefix = allPlainText(last.parts);
  if (prefix === null) return { payload: { contents }, prefill: "" };

  const prev = contents.length >= 2 ? contents[contents.length - 2] : null;
  // Gemini v1beta 亦接受 "function" role（工具结果轮），类型上按 string 比对
  const prevOk = prev && (prev.role === "user" || (prev.role as string) === "function");
  if (prevOk) {
    // 保留 model 轮 + 追加 user 提示
    return {
      payload: { contents: [...contents, { role: "user", parts: [{ text: PREFILL_NUDGE } as GPart] }] },
      prefill: prefix,
    };
  }
  // 丢弃 model 轮 + 注入 JSON 前缀指令
  const instruction = prefillDropInstruction(prefix);
  const rest = contents.slice(0, -1);
  return {
    payload: { contents: [...rest, { role: "user", parts: [{ text: instruction } as GPart] }] },
    prefill: prefix,
  };
}

/** 非流式回声剥离：精确 TrimPrefix（命中才剥，避免误伤正常回复） */
export function stripPrefillEcho(text: string, prefill: string): string {
  if (!prefill || !text) return text;
  return text.startsWith(prefill) ? text.slice(prefill.length) : text;
}

/**
 * 流式回声剥离状态机（单候选）：
 *   feed(chunk) → 本次应输出的文本（可能为空：仍在前缀候选中）；
 *   finish() → 流末冲刷的残余（前缀歧义尾巴）。
 */
export class PrefillEchoFilter {
  private remaining: string;
  private done = false;

  constructor(prefill: string) {
    this.remaining = prefill || "";
  }

  get active(): boolean {
    return !this.done && this.remaining.length > 0;
  }

  feed(chunk: string): string {
    if (this.done || !chunk) return chunk;
    if (this.remaining.length === 0) {
      this.done = true;
      return chunk;
    }
    // chunk 与 remaining 的最长公共前缀长度
    let keep = 0;
    const max = Math.min(chunk.length, this.remaining.length);
    while (keep < max && chunk[keep] === this.remaining[keep]) keep++;
    if (keep === chunk.length && keep < this.remaining.length) {
      // 整个 chunk 都在前缀内：缓冲，不输出
      this.remaining = this.remaining.slice(keep);
      return "";
    }
    if (keep === this.remaining.length) {
      // chunk 恰好消耗完前缀：输出剩余部分
      this.done = true;
      this.remaining = "";
      return chunk.slice(keep);
    }
    // 不匹配：前缀假设失效，冲刷缓冲（remaining 里未消耗的部分）+ chunk 剩余
    const flushed = this.remaining + chunk.slice(keep);
    this.done = true;
    this.remaining = "";
    return flushed;
  }

  finish(): string {
    if (this.done) return "";
    this.done = true;
    const tail = this.remaining;
    this.remaining = "";
    return tail;
  }
}

/**
 * 按候选 index 管理一组过滤器（Gemini 多候选流）。created() 惰性创建。
 */
export class PrefillEchoFilterSet {
  private filters = new Map<number, PrefillEchoFilter>();
  readonly prefill: string;

  // 注意：不用 TS 参数属性（constructor(readonly x)），Node strip-types 模式不支持
  constructor(prefill: string) {
    this.prefill = prefill;
  }

  get(index: number): PrefillEchoFilter | null {
    if (!this.prefill) return null;
    let f = this.filters.get(index);
    if (!f) {
      f = new PrefillEchoFilter(this.prefill);
      this.filters.set(index, f);
    }
    return f;
  }

  finishAll(): Map<number, string> {
    const out = new Map<number, string>();
    for (const [idx, f] of this.filters) {
      const tail = f.finish();
      if (tail) out.set(idx, tail);
    }
    return out;
  }
}
