// SSE 解析/生成与 Gemini 工具函数 —— 无平台依赖，可单测。
import type { GPart } from "../types.ts";

/** 解析 SSE 字节流 → data 事件序列（Gemini 官方 SSE 每帧 data: {JSON}，event 行可忽略） */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event?: string; data: string }> {
  const decoder = new TextDecoder();
  let buf = "";
  const reader = body.getReader();
  let event: string | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        yield { event, data: line.slice(5).trim() };
        event = undefined;
      } else if (line === "") {
        event = undefined;
      }
    }
  }
  const rest = buf.trim();
  if (rest.startsWith("data:")) yield { data: rest.slice(5).trim() };
}

/** 二进制安全的 base64 编码（btoa 分块处理 UTF-8/二进制） */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** data: URI → inlineData；http(s) URL → 拉取后转 inlineData */
export async function imageToInlineData(
  url: string,
): Promise<{ mime_type: string; data: string } | null> {
  if (url.startsWith("data:")) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
    if (!m) return null;
    const mime = m[1] || "image/png";
    if (m[2]) return { mime_type: mime, data: m[3] };
    // 非标准 data URI（URL 编码文本）——按 utf-8 转 base64
    return { mime_type: mime, data: bytesToBase64(new TextEncoder().encode(decodeURIComponent(m[3]))) };
  }
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) throw new Error("fetch image failed: " + url + " HTTP " + resp.status);
  const mime = resp.headers.get("content-type")?.split(";")[0] || "image/png";
  const buf = new Uint8Array(await resp.arrayBuffer());
  return { mime_type: mime, data: bytesToBase64(buf) };
}

export function textPart(text: string): GPart {
  return { text } as GPart;
}

export function randomId(prefix: string): string {
  const rnd = crypto.getRandomValues(new Uint8Array(9));
  let s = "";
  for (const b of rnd) s += b.toString(36).padStart(2, "0");
  return prefix + s.slice(0, 12);
}

/** 从 OpenAI JSON Schema 中剥除 Gemini 不支持的关键字（保守清理，避免 400） */
export function cleanJsonSchema(schema: unknown, depth = 0): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return {};
  if (Array.isArray(schema)) return { items: schema.length ? cleanJsonSchema(schema[0], depth + 1) : {} };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (["$schema", "$id", "additionalProperties", "propertyNames", "$defs", "definitions"].includes(k)) continue;
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = cleanJsonSchema(pv, depth + 1);
      }
      out.properties = props;
      continue;
    }
    if (k === "items" && v && typeof v === "object" && !Array.isArray(v)) {
      out.items = cleanJsonSchema(v, depth + 1);
      continue;
    }
    if ((k === "items" || k === "prefixItems" || k === "anyOf" || k === "oneOf") && Array.isArray(v)) {
      out[k] = v.map((x) => cleanJsonSchema(x, depth + 1));
      continue;
    }
    if ((k === "anyOf" || k === "oneOf") && !Array.isArray(v)) {
      out[k] = cleanJsonSchema(v, depth + 1);
      continue;
    }
    out[k] = v;
  }
  return out;
}

// ===== 协议错误响应 =====

/**
 * 解析 OpenAI n 参数（原项目 resolveN 语义）：缺省 1、必须正整数、上限 maxN（默认 8）。
 * 放在纯逻辑层，便于单测直跑（不拉起 handlers 依赖链）。
 */
export function resolveN(raw: unknown, maxN: number): { n: number; error?: string } {
  const cap = maxN > 0 ? Math.floor(maxN) : 8;
  if (raw === undefined || raw === null) return { n: 1 };
  const v = typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(v) || !Number.isInteger(v)) return { n: 0, error: "请求参数有误: n 必须是整数 (n must be an integer)" };
  if (v < 1) return { n: 0, error: "请求参数有误: n 必须 >= 1 (n must be >= 1)" };
  if (v > cap) return { n: 0, error: "请求参数有误: n 超过上限 " + cap + " (n exceeds maximum " + cap + ")" };
  return { n: v };
}

export function errOpenAI(status: number, message: string, code?: string): Response {
  return json({ error: { message, type: status === 401 ? "invalid_request_error" : "api_error", code: code ?? null } }, status);
}

export function errAnthropic(status: number, type: string, message: string): Response {
  return json({ type: "error", error: { type, message } }, status);
}

export function errGemini(status: number, message: string, status_?: string): Response {
  return json({ error: { code: status, message, status: status_ ?? "INVALID_ARGUMENT" } }, status);
}

export function json(obj: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

// ===== GPart 安全访问助手（Gemini parts 是异构 JSON） =====

export function partText(p: GPart): string | undefined {
  const v = (p as { text?: unknown }).text;
  return typeof v === "string" ? v : undefined;
}

export function partFunctionCall(p: GPart): { name: string; args?: Record<string, unknown> } | null {
  const v = (p as { functionCall?: unknown }).functionCall;
  if (v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string") {
    return v as { name: string; args?: Record<string, unknown> };
  }
  return null;
}

/** inlineData part（图像模型输出）安全访问 */
export function partInlineData(p: GPart): { mime_type?: string; data?: string } | null {
  const v = (p as { inlineData?: unknown }).inlineData;
  if (v && typeof v === "object") {
    const d = v as { mime_type?: unknown; mimeType?: unknown; data?: unknown };
    if (typeof d.data === "string" && d.data) {
      const mime = typeof d.mime_type === "string" ? d.mime_type : typeof d.mimeType === "string" ? d.mimeType : undefined;
      return { mime_type: mime, data: d.data };
    }
  }
  return null;
}
