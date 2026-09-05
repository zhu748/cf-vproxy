// OpenAI Audio API（TTS）—— 移植自 vertex-master internal/api/audio_handler.go
//   POST /v1/audio/speech  JSON {model, input, voice, response_format, speed}
// 出站：Gemini generateContent（responseModalities=AUDIO + speechConfig）；
// 响应：audioData part 的原始字节。无真实转码 —— mp3/wav/opus/aac/flac 统一加 44 字节
// WAV 头（16bit 单声道，采样率取上游 mime 的 rate= 参数，默认 24000），pcm 返回裸 L16。
import { errOpenAI } from "../convert/common.ts";
import type { GPart } from "../types.ts";
import { callGemini, mapUpstreamError, resolveModel, type HandlerCtx } from "../upstream.ts";
import { recordUsage, scheduleFlush } from "../usage.ts";

export const DEFAULT_TTS_MODEL = "gemini-3.1-flash-tts-preview";
export const DEFAULT_TTS_VOICE = "Kore";

/** 30 个 Gemini 预置音色 */
export const GEMINI_VOICES: string[] = [
  "Kore", "Puck", "Charon", "Aoede", "Fenrir", "Leda", "Orus", "Zephyr", "Autonoe", "Enceladus",
  "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia",
  "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];

/** OpenAI 音色名 → Gemini 音色 */
export const OPENAI_VOICE_MAP: Record<string, string> = {
  alloy: "Kore",
  echo: "Puck",
  fable: "Charon",
  onyx: "Fenrir",
  nova: "Aoede",
  shimmer: "Leda",
  ash: "Orus",
  ballad: "Zephyr",
  coral: "Aoede",
  sage: "Charon",
  verse: "Puck",
};

export function resolveVoice(voice: string | undefined): string {
  if (!voice) return DEFAULT_TTS_VOICE;
  if (GEMINI_VOICES.includes(voice)) return voice;
  const mapped = OPENAI_VOICE_MAP[voice.toLowerCase()];
  return mapped ?? DEFAULT_TTS_VOICE;
}

/** speed ≠ 1 → 提示词前缀（无真实变速） */
export function speedPromptPrefix(speed: number | undefined): string {
  if (!speed || speed === 1 || !Number.isFinite(speed)) return "";
  return speed > 1 ? "Say the following faster: " : "Say the following more slowly: ";
}

/** 44 字节 WAV 头（PCM 16bit 单声道） */
export function wavHeader(sampleRate: number, numSamples: number): Uint8Array {
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buf);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 从 mime（如 audio/L16;codec=pcm;rate=24000）解析采样率 */
export function sampleRateFromMime(mime: string): number {
  const m = /rate=(\d+)/.exec(mime);
  return m ? Number(m[1]) : 24000;
}

export async function handleAudioSpeech(req: Request, ctx: HandlerCtx): Promise<Response> {
  let body: { model?: string; input?: string; voice?: string; response_format?: string; speed?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errOpenAI(400, "Invalid JSON body");
  }
  if (!body.input) return errOpenAI(400, "input is required");

  // 模型：空或非 gemini* → 默认 TTS 模型；gemini* 走别名解析
  let model = DEFAULT_TTS_MODEL;
  const requested = (body.model ?? "").trim();
  if (requested.startsWith("gemini")) {
    const resolved = resolveModel(ctx.cfg, requested, false);
    if (!resolved.ok) return errOpenAI(resolved.status ?? 404, resolved.message ?? "model error");
    model = resolved.model;
  } else if (requested && !requested.startsWith("tts-1")) {
    // gpt-4o-mini-tts 等非 gemini 名称同样走默认；tts-1/tts-1-hd 也是默认
    model = DEFAULT_TTS_MODEL;
  }

  const voice = resolveVoice(body.voice);
  const format = (body.response_format ?? "mp3").toLowerCase();
  const text = speedPromptPrefix(Number(body.speed)) + body.input;

  const payload = {
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };

  let upstream: Response;
  try {
    upstream = await callGemini(ctx, model, "generateContent", JSON.stringify(payload));
  } catch (e) {
    return errOpenAI(502, "upstream request failed: " + (e instanceof Error ? e.message : String(e)));
  }
  if (!upstream.ok) {
    // v1.8.0：改用 mapUpstreamError —— 旧实现丢弃上游错误体（只剩 "upstream error HTTP 500"），
    // 音色/模型类 400 的真实原因与 429 的 Retry-After 头全部丢失，与 images 端点行为不一致
    return await mapUpstreamError(upstream, "openai");
  }
  let g: { candidates?: Array<{ content?: { parts?: GPart[] } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } };
  try {
    g = (await upstream.json()) as typeof g;
  } catch {
    return errOpenAI(502, "invalid upstream response", "server_error");
  }
  const usage = g.usageMetadata;
  recordUsage(ctx.clientKey, model, usage?.promptTokenCount ?? 0, (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0));
  ctx.waitUntil(scheduleFlush(ctx.env));

  // 收集 audioData part
  const chunks: Uint8Array[] = [];
  let sampleRate = 24000;
  for (const p of g.candidates?.[0]?.content?.parts ?? []) {
    const inline = (p as { inlineData?: { mimeType?: string; mime_type?: string; data?: string } }).inlineData;
    if (inline?.data) {
      const mime = inline.mimeType ?? inline.mime_type ?? "audio/L16;rate=24000";
      sampleRate = sampleRateFromMime(mime);
      chunks.push(base64ToBytes(inline.data));
    }
  }
  if (chunks.length === 0) {
    return errOpenAI(502, "上游未返回音频（模型 " + model + " 无 audioData 输出）", "server_error");
  }
  const totalLen = chunks.reduce((n, c) => n + c.length, 0);
  const audio = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    audio.set(c, offset);
    offset += c.length;
  }

  if (format === "pcm") {
    return new Response(audio, {
      status: 200,
      headers: { "content-type": "audio/L16; rate=" + sampleRate },
    });
  }
  // mp3/wav/opus/aac/flac → 统一 44 字节 WAV 头（16bit 单声道）
  const numSamples = Math.floor(totalLen / 2);
  const header = wavHeader(sampleRate, numSamples);
  const out = new Uint8Array(header.length + totalLen);
  out.set(header, 0);
  out.set(audio, header.length);
  return new Response(out, {
    status: 200,
    headers: { "content-type": "audio/wav" },
  });
}
