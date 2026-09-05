// 动态模型表（官方 ListModels 拉取方式）：
//   - 内置表（src/models_data.ts）由部署时一次官方拉取生成；
//   - 运行时可通过 POST /admin/models/refresh 用当前上游 Key 重新调官方
//     GET {base}/v1beta/models?pageSize=1000（x-goog-api-key 鉴权）拉取最新模型列表，
//     结果存 KV "models:dynamic"，所有模型校验/列表端点即刻生效；
//   - POST /admin/models/reset 可删除动态表、回退内置表；
//   - 读取走 isolate 内存缓存（60s），避免每个请求都读 KV。
import { builtinModelMeta, BUILTIN_FETCH_DATE, type BuiltinModelMeta } from "./models.ts";

export type { BuiltinModelMeta };

/** 统一模型元数据（内置表与官方动态拉取共用） */
export interface GModelMeta {
  name: string;
  display_name?: string;
  description?: string;
  version?: string;
  input_token_limit?: number;
  output_token_limit?: number;
  methods: string[];
  thinking?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

export interface ModelClassification {
  chat: GModelMeta[];
  native_only: GModelMeta[];
  excluded: GModelMeta[];
}

export interface ActiveModelTable {
  source: "builtin" | "official";
  fetched_at?: string;
  chat: string[];
  native_only: string[];
  excluded: string[];
  known: Set<string>;
  meta: Map<string, GModelMeta>;
}

export const MODELS_KV_KEY = "models:dynamic";

const CACHE_TTL_MS = 60_000;

interface StoredDynamic {
  fetched_at: string;
  models: GModelMeta[];
}

let active: ActiveModelTable | null = null;
let kvCache: { at: number } | null = null;

// ---------- 分类 ----------

/** 按官方 supportedGenerationMethods 分类（模型校验与列表端点共用的唯一规则） */
export function classifyModels(models: GModelMeta[]): ModelClassification {
  const chat: GModelMeta[] = [];
  const native_only: GModelMeta[] = [];
  const excluded: GModelMeta[] = [];
  for (const m of models) {
    if (!m || typeof m.name !== "string" || !m.name) continue;
    const methods = Array.isArray(m.methods) ? m.methods.filter((x) => typeof x === "string") : [];
    if (methods.includes("generateContent")) chat.push(m);
    else if (methods.includes("predict") || methods.includes("predictLongRunning")) native_only.push(m);
    else excluded.push(m);
  }
  return { chat, native_only, excluded };
}

export function buildTable(source: "builtin" | "official", fetchedAt: string | undefined, models: GModelMeta[]): ActiveModelTable {
  const cls = classifyModels(models);
  const meta = new Map<string, GModelMeta>();
  for (const m of [...cls.chat, ...cls.native_only]) meta.set(m.name, m);
  return {
    source,
    fetched_at: fetchedAt,
    chat: cls.chat.map((m) => m.name),
    native_only: cls.native_only.map((m) => m.name),
    excluded: cls.excluded.map((m) => m.name),
    known: new Set([...cls.chat, ...cls.native_only].map((m) => m.name)),
    meta,
  };
}

let builtinTableCache: ActiveModelTable | null = null;

export function builtinTable(): ActiveModelTable {
  if (!builtinTableCache) builtinTableCache = buildTable("builtin", BUILTIN_FETCH_DATE, builtinModelMeta() as GModelMeta[]);
  return builtinTableCache;
}

// ---------- 激活表（同步查询入口） ----------

/** 当前生效表：loadActiveModels 之后为内置或官方动态表；此前为内置表 */
export function activeTable(): ActiveModelTable {
  return active ?? builtinTable();
}

export function setActiveTable(t: ActiveModelTable): void {
  active = t;
}

export function listChatModels(): string[] {
  return activeTable().chat;
}

export function listNativeOnlyModels(): string[] {
  return activeTable().native_only;
}

export function listExcludedModels(): string[] {
  return activeTable().excluded;
}

export function isChatModelActive(name: string): boolean {
  return activeTable().chat.includes(name);
}

export function isKnownModelActive(name: string): boolean {
  return activeTable().known.has(name);
}

export function modelMeta(name: string): GModelMeta | undefined {
  return activeTable().meta.get(name);
}

export function activeSourceInfo(): { source: "builtin" | "official"; fetched_at?: string; total: number; excluded: number } {
  const t = activeTable();
  return { source: t.source, fetched_at: t.fetched_at, total: t.chat.length + t.native_only.length, excluded: t.excluded.length };
}

// ---------- KV 持久化 ----------

function dynamicToTable(d: StoredDynamic): ActiveModelTable | null {
  if (!d || !Array.isArray(d.models)) return null;
  const cleaned = d.models.filter((m) => m && typeof m.name === "string" && m.name && Array.isArray(m.methods));
  if (cleaned.length === 0) return null;
  return buildTable("official", typeof d.fetched_at === "string" ? d.fetched_at : undefined, cleaned);
}

/**
 * 每请求路径调用（60s 内存缓存）：KV 有动态表则激活官方表，否则激活内置表。
 * KV 读失败静默回退内置表，不影响服务。
 */
export async function loadActiveModels(env: { VPROXY_KV: KVNamespace }, force = false): Promise<void> {
  if (!force && kvCache && Date.now() - kvCache.at < CACHE_TTL_MS) return;
  kvCache = { at: Date.now() };
  let raw: unknown = null;
  try {
    raw = await env.VPROXY_KV.get(MODELS_KV_KEY, "json");
  } catch {
    raw = null;
  }
  const t = raw ? dynamicToTable(raw as StoredDynamic) : null;
  setActiveTable(t ?? builtinTable());
}

export async function storeDynamicModels(env: { VPROXY_KV: KVNamespace }, models: GModelMeta[], fetchedAt: string): Promise<void> {
  const stored: StoredDynamic = { fetched_at: fetchedAt, models };
  await env.VPROXY_KV.put(MODELS_KV_KEY, JSON.stringify(stored));
  setActiveTable(buildTable("official", fetchedAt, models));
  kvCache = { at: Date.now() };
}

export async function clearDynamicModels(env: { VPROXY_KV: KVNamespace }): Promise<void> {
  await env.VPROXY_KV.delete(MODELS_KV_KEY).catch(() => {});
  setActiveTable(builtinTable());
  kvCache = { at: Date.now() };
}

// ---------- 官方拉取（网络编排见 src/proxy/modelfetch.ts，此处仅定义结果类型与响应解析） ----------

export interface OfficialFetchResult {
  models: GModelMeta[];
  via: string;
  fetched_at: string;
  pages: number;
}

/** 解析 ListModels 单页响应（纯函数，便于单测） */
export function parseOfficialModelsResponse(data: unknown): { models: GModelMeta[]; nextPageToken?: string } {
  if (!data || typeof data !== "object") return { models: [] };
  const obj = data as { models?: unknown; nextPageToken?: unknown };
  if (!Array.isArray(obj.models)) return { models: [] };
  const models: GModelMeta[] = [];
  for (const item of obj.models) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    let name = typeof it.name === "string" ? it.name : "";
    if (name.startsWith("models/")) name = name.slice(7);
    if (!name) continue;
    const methods = Array.isArray(it.supportedGenerationMethods)
      ? (it.supportedGenerationMethods as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const meta: GModelMeta = { name, methods };
    if (typeof it.displayName === "string") meta.display_name = it.displayName;
    if (typeof it.description === "string") meta.description = it.description;
    if (typeof it.version === "string") meta.version = it.version;
    if (typeof it.inputTokenLimit === "number") meta.input_token_limit = it.inputTokenLimit;
    if (typeof it.outputTokenLimit === "number") meta.output_token_limit = it.outputTokenLimit;
    if (typeof it.thinking === "boolean") meta.thinking = it.thinking;
    if (typeof it.temperature === "number") meta.temperature = it.temperature;
    if (typeof it.topP === "number") meta.top_p = it.topP;
    if (typeof it.topK === "number") meta.top_k = it.topK;
    models.push(meta);
  }
  return { models, nextPageToken: typeof obj.nextPageToken === "string" ? obj.nextPageToken : undefined };
}

