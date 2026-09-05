// 假流式（Fake Streaming）—— 移植自 vertex-master internal/api/fakestream.go
//
// 模型名前缀 `fake-` / `假流式-`（对别名解析后的目标名同样生效）会把非流式上游调用
// 伪装成流式输出：完整拿到响应后，把文本按 rune 边界切成 ≤8 块连续吐出（无人为间隔）。
// 配置 aggregate_stream=true 时所有端点不加深缀同样聚合。
//
// ⚠️ 纯逻辑文件：不 import 任何运行时 API，可在 Node 单测中直接运行。

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
