// KV 配置管理：
//   - 配置持久化在 KV 的 "config" 键上，可通过 /admin/config 或 Web 面板热更新，无需重新部署；
//   - 首次访问时若 KV 无配置，则用环境变量兜底初始化；
//   - isolate 内存缓存 60 秒，避免每个请求都读 KV（KV 免费额度：10 万读/天）；
//   - 上游 Gemini Key 为单个（对齐原项目“单 Key 直连”模式），兼容读取旧版 gemini_keys 数组；
//   - 保存/加载时自动清洗代理列表：https:// 等不支持的链接直接剔除（Workers 无法 TLS-in-TLS）。
import { cleanProxyList } from "./proxy/frames.ts";
import { DEFAULT_RACING, sanitizeRacingConfig, DEFAULT_HEALTH_CHECK, sanitizeHealthCheckConfig } from "./racing.ts";
import { DEFAULT_CLAUDE_PROMPT_POLICY, sanitizeClaudePromptPolicy } from "./promptpolicy.ts";
import type { VProxyConfig } from "./types.ts";

export interface Env {
  VPROXY_KV: KVNamespace;
  // 兜底配置（均可选；KV 配置优先）
  API_KEYS?: string; // 逗号分隔（客户端鉴权 Key）
  GEMINI_API_KEY?: string; // 新：单个上游 Key
  GEMINI_API_KEYS?: string; // 兼容旧：逗号分隔，取第一个
  GEMINI_BASE_URL?: string; // 可选：上游镜像/中转基地址
  PROXY_URLS?: string; // 逗号分隔
  ADMIN_TOKEN?: string; // 管理端点鉴权 token
}

export const CONFIG_KEY = "config";

const CACHE_TTL_MS = 60_000;

let cached: { value: VProxyConfig; at: number } | null = null;

export function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function clampNum(v: unknown, def: number, lo: number, hi: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(Math.min(hi, Math.max(lo, n))) : def;
}

export function defaultConfig(env: Env): VProxyConfig {
  return {
    gemini_key: parseList(env.GEMINI_API_KEY)[0] ?? parseList(env.GEMINI_API_KEYS)[0] ?? "",
    api_keys: parseList(env.API_KEYS),
    proxies: cleanProxyList(parseList(env.PROXY_URLS)).kept, // env 兜底也过一遍清洗
    subscription: "",
    model_aliases: {},
    disabled_models: [],
    subscription_refresh_minutes: 30,
    racing: { ...DEFAULT_RACING },
    drop_max_tokens: false,
    max_request_mb: 64,
    max_concurrent_requests: 16,
    aggregate_stream: false,
    gemini_base_url: sanitizeBaseUrl(env.GEMINI_BASE_URL),
    max_n: 8,
    health_check: { ...DEFAULT_HEALTH_CHECK },
    keepalive_url: "",
    keepalive_interval: 60,
    claude_prompt: { ...DEFAULT_CLAUDE_PROMPT_POLICY, replacements: [] },
  };
}

export function sanitizeBaseUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let v = raw.trim().replace(/\/+$/, "");
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) return ""; // 仅接受 http(s)，其余视为无效回退官方
  try {
    const u = new URL(v);
    // 裸域名（无路径）自动补 /v1beta，便于直接填镜像站域名
    if (u.pathname === "" || u.pathname === "/") v = u.origin + "/v1beta";
  } catch {
    return "";
  }
  return v;
}

export function sanitizeConfig(raw: unknown): VProxyConfig {
  const d = raw && typeof raw === "object" ? (raw as Partial<VProxyConfig> & { gemini_keys?: unknown }) : {};
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [];
  let refresh = Number(d.subscription_refresh_minutes);
  if (!Number.isFinite(refresh) || refresh < 5) refresh = 30;
  // 单 Key：优先读 gemini_key；旧配置只有 gemini_keys 数组时取第一个
  const geminiKey =
    typeof d.gemini_key === "string" && d.gemini_key.trim()
      ? d.gemini_key.trim()
      : Array.isArray(d.gemini_keys) && typeof d.gemini_keys[0] === "string"
        ? d.gemini_keys[0].trim()
        : "";
  return {
    gemini_key: geminiKey,
    api_keys: arr(d.api_keys),
    proxies: cleanProxyList(arr(d.proxies)).kept, // 自动剔除 https:// 等不支持条目
    subscription: typeof d.subscription === "string" ? d.subscription.trim() : "",
    model_aliases:
      d.model_aliases && typeof d.model_aliases === "object" && !Array.isArray(d.model_aliases)
        ? Object.fromEntries(
            Object.entries(d.model_aliases as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string" && v.trim())
              .map(([k, v]) => [k.trim(), String(v).trim()]),
          )
        : {},
    disabled_models: arr(d.disabled_models),
    subscription_refresh_minutes: Math.floor(refresh),
    racing: sanitizeRacingConfig(d.racing),
    drop_max_tokens: !!d.drop_max_tokens,
    max_request_mb: clampNum(d.max_request_mb, 64, 1, 1024),
    max_concurrent_requests: clampNum(d.max_concurrent_requests, 16, 1, 1000),
    aggregate_stream: !!d.aggregate_stream,
    gemini_base_url: sanitizeBaseUrl(d.gemini_base_url),
    max_n: clampNum(d.max_n, 8, 1, 32),
    health_check: sanitizeHealthCheckConfig(d.health_check),
    keepalive_url: typeof d.keepalive_url === "string" ? d.keepalive_url.trim() : "",
    keepalive_interval: clampNum(d.keepalive_interval, 60, 5, 86_400),
    claude_prompt: sanitizeClaudePromptPolicy(d.claude_prompt),
  };
}

export async function loadConfig(env: Env, force = false): Promise<VProxyConfig> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  let raw: unknown = null;
  try {
    raw = await env.VPROXY_KV.get(CONFIG_KEY, "json");
  } catch {
    raw = null;
  }
  let cfg: VProxyConfig;
  if (raw) {
    cfg = sanitizeConfig(raw);
    // 环境变量作为缺失字段的兜底（KV 已配置的字段优先）
    const d = defaultConfig(env);
    if (!cfg.gemini_key) cfg.gemini_key = d.gemini_key;
    if (cfg.api_keys.length === 0) cfg.api_keys = d.api_keys;
    if (cfg.proxies.length === 0) cfg.proxies = d.proxies;
  } else {
    cfg = defaultConfig(env);
    // 首次初始化：把 env 兜底配置写进 KV，后续即可纯 KV/面板管理
    try {
      await env.VPROXY_KV.put(CONFIG_KEY, JSON.stringify(cfg));
    } catch {
      // KV 写失败不阻塞请求
    }
  }
  cached = { value: cfg, at: Date.now() };
  return cfg;
}

export async function saveConfig(env: Env, cfg: VProxyConfig): Promise<void> {
  await env.VPROXY_KV.put(CONFIG_KEY, JSON.stringify(cfg));
  cached = { value: cfg, at: Date.now() };
}

export function invalidateConfigCache(): void {
  cached = null;
}

// 上游 Gemini Key：单 Key 直连（原项目 official 模式）
export function pickGeminiKey(cfg: VProxyConfig): string {
  return cfg.gemini_key;
}
