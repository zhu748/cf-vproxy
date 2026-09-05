// 内置模型表 —— 数据来自官方 ListModels API 一次性拉取（src/models_data.ts，可由
// scripts/gen-models.mjs 重新生成），运行时另可在面板「从官方重新拉取」获得动态表。
// 分类规则（见 src/modellist.ts classifyModels）：
//   - methods 含 generateContent            → chat（OpenAI / Anthropic / Gemini 三入口可用）；
//   - 仅 predict / predictLongRunning       → native_only（Gemini 原生透传入口）；
//   - 仅 embedContent/generateAnswer/bidi…  → 排除（本代理不透传这类端点）。
import { BUILTIN_MODEL_META, BUILTIN_FETCHED_AT, type BuiltinModelMeta } from "./models_data.ts";

export type { BuiltinModelMeta };

/** chat 模型名（官方 methods 含 generateContent） */
export const GEMINI_CHAT_MODELS: string[] = BUILTIN_MODEL_META.filter((m) => m.methods.includes("generateContent")).map((m) => m.name);

/** 仅 Gemini 原生透传（:predict / :predictLongRunning） */
export const GEMINI_NATIVE_ONLY_MODELS: string[] = BUILTIN_MODEL_META.filter(
  (m) => !m.methods.includes("generateContent") && (m.methods.includes("predict") || m.methods.includes("predictLongRunning")),
).map((m) => m.name);

export const ALL_MODELS: string[] = [...GEMINI_CHAT_MODELS, ...GEMINI_NATIVE_ONLY_MODELS];

export const BUILTIN_FETCH_DATE = BUILTIN_FETCHED_AT;

/** 内置表完整元数据（含被排除的模型，供面板/调试展示） */
export function builtinModelMeta(): BuiltinModelMeta[] {
  return BUILTIN_MODEL_META;
}

export function isChatModel(name: string): boolean {
  return GEMINI_CHAT_MODELS.includes(name);
}

export function isKnownModel(name: string): boolean {
  return ALL_MODELS.includes(name);
}
