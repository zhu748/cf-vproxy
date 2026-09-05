// 内置模型表 —— 对齐 vertex-master 原项目 config/models.json
// 规则：
//   - gemini-* 前缀模型可用于 OpenAI / Anthropic / Gemini 三类入口；
//   - imagen / veo / lyria 等非文本模型仅在 Gemini 原生透传入口放行（chat 协议转换对其无意义）。
export const GEMINI_CHAT_MODELS: string[] = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-image",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3-pro-image",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-image",
  "gemini-3.1-flash-image",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
];

// 仅 Gemini 原生透传入口可用
export const GEMINI_NATIVE_ONLY_MODELS: string[] = [
  "imagen-3.0-capability",
  "imagen-4.0-generate-001",
  "imagen-4.0-ultra-generate-001",
  "imagen-4.0-fast-generate-001",
  "virtual-try-on-001",
  "lyria-002",
  "veo-2-generate-001",
  "veo-3-generate-001",
  "veo-3-fast-generate-001",
];

export const ALL_MODELS: string[] = [...GEMINI_CHAT_MODELS, ...GEMINI_NATIVE_ONLY_MODELS];

export function isChatModel(name: string): boolean {
  return GEMINI_CHAT_MODELS.includes(name);
}

export function isKnownModel(name: string): boolean {
  return ALL_MODELS.includes(name);
}
