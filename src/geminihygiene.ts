// Gemini 原生响应规范化 —— 移植自 vertex-master internal/api/gemini_handler.go /
// gemini_stream_writer.go 的响应后处理（Workers 版）。
//
// 非流式：
//   - 删除 finishReason: "FINISH_REASON_UNSPECIFIED"（protobuf 默认占位）；
//   - 删除 promptFeedback.blockReason 的空占位（BLOCKED_REASON_UNSPECIFIED 等），
//     promptFeedback 清空后整体移除；
//   - usageMetadata 缺失的 canonical 字段从 totalTokenCount 反推。
// 流式（逐帧规范化后重序列化为 data: {JSON}）：
//   - 同上的占位清理；
//   - 仅带 usageMetadata 的帧（无 candidates）注入合成空候选（RikkaHub 兼容），
//     并把此前帧的 tokenCount 兜底带出；
//   - 帧间携带 usage（上游最后帧才有 usage 时，最终帧补挂）；
//   - 流结束仍无 finishReason → 追加合成 STOP 帧；
//   - 上游空流 → 输出错误帧 {code:500, INTERNAL, "Upstream returned empty response"}。
//
// ⚠️ 纯逻辑文件：可在 Node 单测中直接运行。
import type { GResponse } from "./types.ts";

const BLOCK_PLACEHOLDERS = new Set(["BLOCKED_REASON_UNSPECIFIED", "BLOCK_REASON_UNSPECIFIED", ""]);

/** 非流式响应规范化（返回新对象；无变化时内容等价） */
export function normalizeGeminiResponse(g: GResponse): GResponse {
  const out: GResponse = { ...g };
  if (Array.isArray(out.candidates)) {
    out.candidates = out.candidates.map((c) => {
      if (c && c.finishReason === "FINISH_REASON_UNSPECIFIED") {
        const { finishReason: _drop, ...rest } = c;
        void _drop;
        return rest;
      }
      return c;
    });
  }
  const pf = out.promptFeedback as { blockReason?: string; safetyRatings?: unknown[] } | undefined;
  if (pf && typeof pf === "object") {
    const block = typeof pf.blockReason === "string" ? pf.blockReason : undefined;
    const hasRatings = Array.isArray(pf.safetyRatings) && pf.safetyRatings.length > 0;
    if (block !== undefined && (BLOCK_PLACEHOLDERS.has(block) || block === "FINISH_REASON_UNSPECIFIED")) {
      if (hasRatings) delete (out.promptFeedback as { blockReason?: string }).blockReason;
      else delete out.promptFeedback;
    } else if (!block && !hasRatings) {
      delete out.promptFeedback;
    }
  }
  return out;
}

/** 从 usageMetadata 的 modality details 反推 canonical 计数（缓存思想 tokens） */
export function canonicalUsage(u: GResponse["usageMetadata"]): GResponse["usageMetadata"] | undefined {
  if (!u || typeof u !== "object") return undefined;
  const out = { ...u };
  const total =
    u.totalTokenCount ??
    (u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  if (out.totalTokenCount === undefined) out.totalTokenCount = total;
  return out;
}

export interface NativeStreamOptions {
  /** 非文本部分原样保留；true 时在每个候选注入合成空候选后的 usage-only 帧 */
  syntheticCandidate?: boolean;
}

/**
 * 流式帧规范化生成器：输入解析后的 GResponse 序列，输出规范化后的序列。
 * 调用方负责把结果重序列化为 SSE（data: {...}\n\n）。
 */
export async function* normalizeNativeStreamFrames(
  frames: AsyncIterable<GResponse>,
  _opts: NativeStreamOptions = {},
): AsyncGenerator<GResponse> {
  let emitted = 0;
  let lastTokenCount = 0;
  let usage: GResponse["usageMetadata"] | undefined;
  let sawFinish = false;

  for await (const raw of frames) {
    const frame: GResponse = normalizeGeminiResponse(raw);

    // 记录 token 兜底（usage-only 帧或任意帧都可能是 tokenCount 形态）
    const u = frame.usageMetadata;
    if (u) {
      usage = canonicalUsage(u);
      frame.usageMetadata = usage;
      if (typeof (u as { totalTokenCount?: number }).totalTokenCount === "number") {
        lastTokenCount = (u as { totalTokenCount?: number }).totalTokenCount!;
      }
    }

    if (Array.isArray(frame.candidates)) {
      for (const c of frame.candidates) {
        if (c?.finishReason) sawFinish = true;
      }
    }

    if (usage && !frame.candidates) {
      // usage-only 帧：注入合成空候选（RikkaHub 兼容）
      frame.candidates = [{ content: { role: "model", parts: [] }, index: 0 }];
    }

    emitted++;
    yield frame;
  }

  if (emitted === 0) {
    // 上游空流 → 错误帧
    yield {
      error: { code: 500, message: "Upstream returned empty response (no content)", status: "INTERNAL" },
    } as unknown as GResponse;
    return;
  }

  if (!sawFinish) {
    // 补合成 STOP 帧（带 usage）
    const finalFrame: GResponse = {
      candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
    };
    finalFrame.usageMetadata = usage ?? (lastTokenCount ? ({ totalTokenCount: lastTokenCount } as GResponse["usageMetadata"]) : undefined);
    yield finalFrame;
  }
}

/** GResponse → SSE 帧（Gemini 原生 alt=sse 只有 data 行） */
export function geminiFrameToSse(frame: GResponse): string {
  return "data: " + JSON.stringify(frame) + "\n\n";
}
