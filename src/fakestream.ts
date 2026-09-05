// 假流式（Fake Streaming）—— 移植自 vertex-master internal/api/fakestream.go
//                          + internal/api/gemini_handler.go geminiFakeStreamFrames
//
// 模型名前缀 `fake-` / `假流式-`（对别名解析后的目标名同样生效）会把非流式上游调用
// 伪装成流式输出：完整拿到响应后，把文本按 rune 边界切成 ≤8 块连续吐出（无人为间隔）。
// 配置 aggregate_stream=true 时 OpenAI / Anthropic / Responses 端点不加深缀同样聚合
// （与原项目一致：Gemini 原生端点仅认前缀，不认 aggregate_stream）。
//
// ⚠️ 纯逻辑文件：不 import 任何运行时 API（types 仅为 type-only import，运行时擦除），
//    可在 Node 单测中直接运行。
import type { GResponse, GCandidate, GPart } from "./types.ts";

export const FAKE_PREFIXES = ["fake-", "假流式-"] as const;
export const FAKE_STREAM_TARGET_CHUNKS = 8;

/** 是否携带假流式前缀 */
export function hasFakePrefix(model: string): boolean {
  return FAKE_PREFIXES.some((p) => model.startsWith(p));
}

/** 剥一层假流式前缀（resolveRequestedModel 会反复剥） */
export function stripOneFakePrefix(model: string): string {
  for (const p of FAKE_PREFIXES) {
    if (model.startsWith(p)) return model.slice(p.length);
  }
  return model;
}

/**
 * 按 rune（码点）边界把文本切成 ≤ maxChunks 块（绝不切断代理对/组合字符，避免 U+FFFD 乱码）。
 * 空文本返回 []。原项目：优先均匀切分；整除不尽时后面的块多拿一个码点。
 */
export function splitFakeChunks(text: string, maxChunks = FAKE_STREAM_TARGET_CHUNKS): string[] {
  if (!text) return [];
  const cps = Array.from(text); // 码点数组
  if (cps.length <= maxChunks) return cps.map((c) => c);
  const base = Math.floor(cps.length / maxChunks);
  const extra = cps.length % maxChunks;
  const out: string[] = [];
  let cursor = 0;
  for (let i = 0; i < maxChunks; i++) {
    const take = base + (i < extra ? 1 : 0);
    if (take <= 0) continue;
    out.push(cps.slice(cursor, cursor + take).join(""));
    cursor += take;
  }
  return out;
}

/** SSE 保活注释帧 */
export function ssePingFrame(): string {
  return ": ping\n\n";
}

// ===== Gemini 原生端点假流式（移植自 gemini_handler.go geminiFakeStreamFrames）=====

/** 单候选单 part 的 Gemini 流式帧 */
function geminiFakePartFrame(candidateIndex: number, role: string, part: GPart): GResponse {
  return {
    candidates: [{ index: candidateIndex, content: { role: role as "model" | "user", parts: [part] } }],
  };
}

/**
 * 完整 GResponse → Gemini SSE 帧数组（含末尾 usage 帧，对齐 geminiFakeStream 主体行为）：
 *   - 每个 part 一帧；文本 part 按码点切成 ≤8 帧连吐（保留 part 其余字段）；
 *   - 每个候选的最后一帧附带 finishReason / safetyRatings 等非 content 字段；
 *   - 空候选输出一帧空 parts（保证每个候选至少一帧）；
 *   - 顶层元数据（createTime / modelVersion / responseId / promptFeedback / modelStatus）
 *     合并进最后一帧；
 *   - usageMetadata 存在时追加一帧仅含 usage 的空内容帧（对齐原项目 applyGeminiUsage 收尾）。
 */
export function geminiFakeStreamFrames(resp: GResponse): GResponse[] {
  const frames: GResponse[] = [];
  const candidates = resp.candidates ?? [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const candidate = candidates[candidateIndex];
    const content = candidate.content;
    const role = content?.role ?? "model";
    const start = frames.length;
    const parts = content?.parts ?? [];
    for (const part of parts) {
      const text = (part as { text?: unknown }).text;
      const chunks = typeof text === "string" ? splitFakeChunks(text) : [];
      if (chunks.length === 0) {
        // 非文本 part（functionCall / inlineData / …）原样单帧
        frames.push(geminiFakePartFrame(candidateIndex, role, part));
        continue;
      }
      for (const piece of chunks) {
        frames.push(geminiFakePartFrame(candidateIndex, role, { ...part, text: piece }));
      }
    }
    if (frames.length === start) {
      frames.push({
        candidates: [{ index: candidateIndex, content: { role: role as "model" | "user", parts: [] } }],
      });
    }
    // 最后一帧附带候选级与 content 级的非核心字段（finishReason 等）
    const lastCand = frames[frames.length - 1]?.candidates?.[0] as GCandidate | undefined;
    if (lastCand) {
      for (const [k, v] of Object.entries(candidate)) {
        if (k !== "content" && k !== "index") (lastCand as Record<string, unknown>)[k] = v;
      }
      if (candidate.index !== undefined) lastCand.index = candidate.index;
      if (content) {
        if (!lastCand.content) lastCand.content = { role: role as "model" | "user", parts: [] };
        const lastContent = lastCand.content as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(content)) {
          if (k !== "parts" && k !== "role") lastContent[k] = v;
        }
      }
    }
  }
  // 顶层元数据合并进最后一帧
  const top: Record<string, unknown> = {};
  for (const key of ["createTime", "modelVersion", "responseId", "promptFeedback", "modelStatus"] as const) {
    if ((resp as Record<string, unknown>)[key] !== undefined) top[key] = (resp as Record<string, unknown>)[key];
  }
  if (Object.keys(top).length > 0) {
    if (frames.length === 0) frames.push(top as GResponse);
    else Object.assign(frames[frames.length - 1], top);
  }
  // usage 收尾帧
  const u = resp.usageMetadata;
  if (u) {
    frames.push({
      candidates: [{ index: 0, content: { role: "model", parts: [] } }],
      usageMetadata: u,
    });
  }
  return frames;
}

/** GResponse[] → alt=sse 响应体文本（"data: {...}\n\n" 逐帧拼接） */
export function geminiFakeStreamSseBody(resp: GResponse): string {
  return geminiFakeStreamFrames(resp)
    .map((f) => "data: " + JSON.stringify(f) + "\n\n")
    .join("");
}

// ===== 模型列表假流式变体（移植自 config/models.go ModelsWithFakeVariants）=====

/**
 * 每个基础模型展开为三个条目：m、假流式-m、fake-m（与原项目顺序一致）。
 * 用于 /v1/models 与 /v1beta/models 列表端点暴露假流式变体，方便客户端自动发现。
 */
export function withFakeVariants(models: string[]): string[] {
  const out: string[] = [];
  for (const m of models) {
    out.push(m, FAKE_PREFIXES[1] + m, FAKE_PREFIXES[0] + m);
  }
  return out;
}
