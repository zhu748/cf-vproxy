// OpenAI Images API —— 移植自 vertex-master internal/api/image_handler.go + transform/image.go
//   POST /v1/images/generations   JSON {model, prompt, size, response_format, n}
//   POST /v1/images/edits         multipart（image 多文件、mask、prompt、negative_prompt、n…）
//   POST /v1/images/variations    同 edits，无 mask
// 出站统一走 Gemini 图像模型 generateContent（responseModalities=TEXT+IMAGE），
// 默认模型 gemini-3.1-flash-image；n>1 循环请求凑满（Gemini 无服务端 n）。
import { bytesToBase64, errOpenAI, json, partInlineData, partText } from "../convert/common.ts";
import type { GPart, GResponse } from "../types.ts";
import { callGemini, mapUpstreamError, resolveModel, type HandlerCtx } from "../upstream.ts";
import { recordUsage, scheduleFlush } from "../usage.ts";

export const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";
export const MAX_IMAGE_N = 8;

const ASPECT_PRESETS: Record<string, string> = {
  "1024x1024": "1:1",
  "1536x1536": "1:1",
  "1536x1024": "3:2",
  "1792x1024": "16:9",
  "1024x1536": "2:3",
  "1024x1792": "9:16",
};

const ALLOWED_RATIOS = new Set(["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"]);

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** size（"1024x1024" 像素或 512/1K/2K/4K 档）→ imageConfig（aspectRatio + imageSize，仅 3.x 生效） */
export function imageConfigForSize(model: string, size?: string): Record<string, unknown> | undefined {
  let w = 0;
  let h = 0;
  let tier = "";
  if (size) {
    const m = /^(\d+)x(\d+)$/.exec(size.trim().toLowerCase());
    if (m) {
      w = Number(m[1]);
      h = Number(m[2]);
    } else {
      tier = size.trim().toLowerCase();
    }
  }
  const cfg: Record<string, unknown> = {};
  if (w > 0 && h > 0) {
    const preset = ASPECT_PRESETS[w + "x" + h];
    if (preset) {
      cfg.aspectRatio = preset;
    } else {
      const g = gcd(w, h);
      const ratio = w / g + ":" + h / g;
      if (ALLOWED_RATIOS.has(ratio)) cfg.aspectRatio = ratio;
    }
  } else if (tier === "512" || tier === "1k") {
    cfg.aspectRatio = "1:1";
  }
  // imageSize 仅 gemini-3* 模型支持
  if (/^gemini-3/.test(model)) {
    const maxSide = Math.max(w, h);
    if (tier === "4k" || maxSide >= 3000) cfg.imageSize = "4K";
    else if (tier === "2k" || maxSide >= 1500) cfg.imageSize = "2K";
    else cfg.imageSize = "1K";
  }
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

/** 约束行 + 图片 → Gemini 请求体（BuildImagePayload 移植） */
export function buildImagePayload(opts: {
  prompt: string;
  images: Array<{ mime_type: string; data: string }>;
  mode: "generate" | "edit" | "variation";
  model: string;
  mask?: { mime_type: string; data: string } | null;
  negativePrompt?: string;
  size?: string;
  quality?: string;
  style?: string;
  background?: string;
  maxOutputTokens?: number;
}): Record<string, unknown> {
  const lines: string[] = [];
  if (opts.mode === "edit") lines.push("Edit the provided image according to the prompt while preserving unaffected details.");
  if (opts.mode === "variation") lines.push("Create a variation of the provided image.");
  if (opts.mask) lines.push("Respect the provided mask as the editable region.");
  const extra: Array<[string, string | undefined]> = [
    ["size", opts.size],
    ["quality", opts.quality],
    ["style", opts.style],
    ["background", opts.background],
  ];
  for (const [label, v] of extra) {
    if (v && v !== "auto") lines.push(label.charAt(0).toUpperCase() + label.slice(1) + ": " + v + ".");
  }
  let prompt = opts.prompt;
  if (opts.negativePrompt) prompt += "\n\nAvoid: " + opts.negativePrompt;
  const parts: GPart[] = [{ text: lines.join(" ") + (lines.length ? "\n\n" : "") + prompt } as GPart];
  for (const img of opts.images) parts.push({ inlineData: { mime_type: img.mime_type, data: img.data } } as GPart);
  if (opts.mask) parts.push({ inlineData: { mime_type: opts.mask.mime_type, data: opts.mask.data } } as GPart);
  const gc: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
  const ic = imageConfigForSize(opts.model, opts.size);
  if (ic) gc.imageConfig = ic;
  if (opts.maxOutputTokens) gc.maxOutputTokens = opts.maxOutputTokens;
  return { contents: [{ role: "user", parts }], generationConfig: gc };
}

/** 从 GResponse 提取图像（inlineData 优先，回退文本中的 data URI markdown） */
export function extractImagesFromResponse(g: GResponse): Array<{ mime_type: string; data: string }> {
  const out: Array<{ mime_type: string; data: string }> = [];
  const cand = g.candidates?.[0];
  for (const p of (cand?.content?.parts ?? []) as GPart[]) {
    const inline = partInlineData(p);
    if (inline?.data) {
      out.push({ mime_type: inline.mime_type || "image/png", data: inline.data });
      continue;
    }
    const t = partText(p);
    if (t) {
      const re = /data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(t))) out.push({ mime_type: m[1], data: m[2] });
    }
  }
  return out;
}

function resolveImageModel(ctx: HandlerCtx, model: string | undefined): { ok: boolean; model: string; display?: string; error?: Response } {
  const requested = (model ?? "").trim();
  if (!requested || requested === "gpt-image-1" || requested === "dall-e-2" || requested === "dall-e-3") {
    return { ok: true, model: DEFAULT_IMAGE_MODEL, display: requested || DEFAULT_IMAGE_MODEL };
  }
  const resolved = resolveModel(ctx.cfg, requested, false);
  if (!resolved.ok) {
    return { ok: false, model: requested, error: errOpenAI(resolved.status ?? 404, resolved.message ?? "model error") };
  }
  return { ok: true, model: resolved.model, display: resolved.display };
}

async function callImageOnce(
  ctx: HandlerCtx,
  model: string,
  payload: Record<string, unknown>,
): Promise<{ image?: { mime_type: string; data: string }; error?: Response }> {
  let upstream: Response;
  try {
    upstream = await callGemini(ctx, model, "generateContent", JSON.stringify(payload));
  } catch (e) {
    return { error: errOpenAI(502, "upstream request failed: " + (e instanceof Error ? e.message : String(e))) };
  }
  if (!upstream.ok) return { error: await mapUpstreamError(upstream, "openai") };
  let g: GResponse;
  try {
    g = (await upstream.json()) as GResponse;
  } catch {
    return { error: errOpenAI(502, "invalid upstream response") };
  }
  const images = extractImagesFromResponse(g);
  const usage = g.usageMetadata;
  recordUsage(ctx.clientKey, model, usage?.promptTokenCount ?? 0, (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0));
  if (images.length === 0) return { error: errOpenAI(502, "上游未返回图像（模型 " + model + " 无 inlineData 输出）", "server_error") };
  return { image: images[0] };
}

function imagesToResponse(images: Array<{ mime_type: string; data: string }>, responseFormat: string): Response {
  return json({
    created: Math.floor(Date.now() / 1000),
    data: images.map((img) =>
      responseFormat === "url"
        ? { url: "data:" + img.mime_type + ";base64," + img.data }
        : { b64_json: img.data },
    ),
  });
}

/** POST /v1/images/generations */
export async function handleImagesGenerations(req: Request, ctx: HandlerCtx): Promise<Response> {
  let body: { model?: string; prompt?: string; size?: string; response_format?: string; n?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errOpenAI(400, "Invalid JSON body");
  }
  if (!body.prompt) return errOpenAI(400, "prompt is required");
  const resolved = resolveImageModel(ctx, body.model);
  if (!resolved.ok) return resolved.error!;
  const n = Math.min(Math.max(1, Math.floor(Number(body.n) || 1)), MAX_IMAGE_N);
  const responseFormat = body.response_format === "url" ? "url" : "b64_json";
  const payload = buildImagePayload({
    prompt: body.prompt,
    images: [],
    mode: "generate",
    model: resolved.model,
    size: body.size,
  });
  const images: Array<{ mime_type: string; data: string }> = [];
  for (let i = 0; i < n; i++) {
    const r = await callImageOnce(ctx, resolved.model, payload);
    if (r.error) return r.error;
    if (r.image) images.push(r.image);
  }
  ctx.waitUntil(scheduleFlush(ctx.env));
  return imagesToResponse(images, responseFormat);
}

async function fileToInline(file: unknown): Promise<{ mime_type: string; data: string } | null> {
  if (!file || typeof file === "string") return null;
  const f = file as File;
  if (typeof f.arrayBuffer !== "function") return null;
  const buf = new Uint8Array(await f.arrayBuffer());
  return { mime_type: f.type || "image/png", data: bytesToBase64(buf) };
}

async function collectImages(fd: FormData): Promise<Array<{ mime_type: string; data: string }>> {
  const keys = ["image", "image[]", "mask[]"];
  const out: Array<{ mime_type: string; data: string }> = [];
  // 兼容 image、image[]、image[0..N] 三种字段名
  for (const key of new Set([...fd.keys()])) {
    if (key === "image" || key === "image[]" || /^image\[\d+\]$/.test(key)) {
      const values = fd.getAll(key);
      for (const v of values) {
        const inline = await fileToInline(v);
        if (inline) out.push(inline);
      }
    }
  }
  void keys;
  return out;
}

/** POST /v1/images/edits 与 /v1/images/variations */
export async function handleImagesEdits(req: Request, ctx: HandlerCtx, variation: boolean): Promise<Response> {
  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return errOpenAI(400, "multipart/form-data body is required");
  }
  const images = await collectImages(fd);
  if (images.length === 0) return errOpenAI(400, "image field is required");
  const mask = variation ? null : await fileToInline(fd.get("mask"));
  const modelRaw = String(fd.get("model") ?? "").trim();
  const resolved = resolveImageModel(ctx, modelRaw || undefined);
  if (!resolved.ok) return resolved.error!;
  const prompt = String(fd.get("prompt") ?? "") || (variation ? "Create a variation of the provided image." : "Edit the provided image.");
  const negativePrompt = String(fd.get("negative_prompt") ?? "").trim() || undefined;
  const n = Math.min(Math.max(1, Math.floor(Number(fd.get("n")) || 1)), MAX_IMAGE_N);
  const responseFormat = String(fd.get("response_format") ?? "b64_json") === "url" ? "url" : "b64_json";
  const size = String(fd.get("size") ?? "").trim() || undefined;
  const quality = String(fd.get("quality") ?? "").trim() || undefined;
  const style = String(fd.get("style") ?? "").trim() || undefined;
  const background = String(fd.get("background") ?? "").trim() || undefined;

  const payload = buildImagePayload({
    prompt,
    images,
    mode: variation ? "variation" : "edit",
    model: resolved.model,
    mask,
    negativePrompt,
    size,
    quality,
    style,
    background,
  });
  const out: Array<{ mime_type: string; data: string }> = [];
  for (let i = 0; i < n; i++) {
    const r = await callImageOnce(ctx, resolved.model, payload);
    if (r.error) return r.error;
    if (r.image) out.push(r.image);
  }
  ctx.waitUntil(scheduleFlush(ctx.env));
  return imagesToResponse(out, responseFormat);
}
