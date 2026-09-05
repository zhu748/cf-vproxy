// 思考强度（Thinking Budget）归一化 —— 移植自 vertex-master internal/transform/thinking.go
//
// 把各协议的"思考强度"参数（OpenAI reasoning_effort / Anthropic thinking / Gemini 原生
// thinkingConfig）统一映射到 Gemini 的 thinkingConfig，按模型官方能力做 clamp，
// 并按目标模型支持的字段形态（budget vs level）归一化 —— 出站时 thinkingConfig 里
// thinkingBudget 与 thinkingLevel 只保留一个。
//
// 模型家族（与原项目 thinkingKindForModel 对齐）：
//   budget-pro          gemini-2.5-pro               budget 128–32768，NONE→128（无法关闭）
//   budget-flash        gemini-2.5-flash             budget 0–24576
//   budget-flash-lite   gemini-2.5-flash-lite        budget 512–24576（正数下限 512）
//   unsupported         gemini-2.5-flash-image       删除整个 thinkingConfig
//   levels-no-minimal   3.7/3.8-flash、3.1-pro       LOW/MEDIUM/HIGH（NONE/MINIMAL→LOW）
//   levels-minimal-high 3.1-flash-image 系            MINIMAL/HIGH 两档
//   levels-low-high     3-pro-preview                 LOW/HIGH 两档
//   fixed               3-pro-image                   移除强度字段（保留模型默认）
//   levels-all          3.6/3.5/3.1-flash-lite/3-flash MINIMAL/LOW/MEDIUM/HIGH
//   其它（未知模型）     原样透传，不做改写
//
// ⚠️ 纯逻辑文件：不 import 任何运行时 API，可在 Node 单测中直接运行。

export type ThinkingLevel = "NONE" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export interface ThinkingConfig {
  thinkingLevel?: ThinkingLevel;
  thinkingBudget?: number;
  includeThoughts?: boolean;
}

export type ThinkingKind =
  | "budget-pro"
  | "budget-flash"
  | "budget-flash-lite"
  | "levels-all"
  | "levels-no-minimal"
  | "levels-minimal-high"
  | "levels-low-high"
  | "fixed"
  | "unsupported"
  | "passthrough";

/** 剥离假流式前缀（防御性：fake- / 假流式- 可能叠加） */
export function stripFakePrefixes(model: string): string {
  let m = model;
  for (;;) {
    if (m.startsWith("fake-")) m = m.slice(5);
    else if (m.startsWith("假流式-")) m = m.slice(4);
    else break;
  }
  return m;
}

/** 模型 → 思考家族（假流式前缀防御性剥除后匹配） */
export function thinkingKindForModel(model: string): ThinkingKind {
  const m = stripFakePrefixes(model);
  if (m === "gemini-2.5-pro") return "budget-pro";
  if (m.startsWith("gemini-2.5-flash-image")) return "unsupported";
  if (m.startsWith("gemini-2.5-flash-lite")) return "budget-flash-lite";
  if (m.startsWith("gemini-2.5-flash")) return "budget-flash";
  // gemini-3 / 3.x 家族
  if (m.startsWith("gemini-3-pro-image")) return "fixed";
  if (m.startsWith("gemini-3-pro")) return "levels-low-high";
  if (m.includes("3.7-flash") || m.includes("3.8-flash") || m.startsWith("gemini-3.1-pro")) return "levels-no-minimal";
  if (m.includes("flash-image") || m.includes("flash-lite-image")) return "levels-minimal-high";
  if (/^gemini-(3\.6|3\.5|3\.1|3)([-.]|$)/.test(m)) return "levels-all";
  return "passthrough";
}

/** Gemini 3.6 及以后版本（maxOutputTokens 一律丢弃的兼容行为） */
export function isGemini36OrLater(model: string): boolean {
  const m = stripFakePrefixes(model);
  const match = /^gemini-(\d+)(?:\.(\d+))?/.exec(m);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = match[2] !== undefined ? Number(match[2]) : 0;
  return major > 3 || (major === 3 && minor >= 6);
}

function canonicalLevel(v: string): ThinkingLevel | null {
  const s = String(v).trim().toUpperCase();
  switch (s) {
    case "NONE":
    case "DISABLED":
    case "OFF":
      return "NONE";
    case "MINIMAL":
      return "MINIMAL";
    case "LOW":
      return "LOW";
    case "MEDIUM":
      return "MEDIUM";
    case "HIGH":
    case "XHIGH":
    case "MAX":
      return "HIGH";
    default:
      return null;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Level → 2.5 系 budget（原项目映射表） */
export function levelToBudget(level: ThinkingLevel, kind: "budget-pro" | "budget-flash" | "budget-flash-lite"): number {
  switch (level) {
    case "NONE":
      return kind === "budget-pro" ? 128 : 0;
    case "MINIMAL":
    case "LOW":
      return 1024;
    case "MEDIUM":
      return 8192;
    case "HIGH":
      return kind === "budget-pro" ? 32768 : 24576;
  }
}

/** 2.5 系 budget → Level（3.x budget_tokens 映射复用：-1 动态 → HIGH） */
export function budgetToLevel(budget: number): ThinkingLevel {
  if (budget === -1) return "HIGH"; // 动态
  if (budget <= 0) return "NONE";
  if (budget <= 1024) return "LOW";
  if (budget <= 8192) return "MEDIUM";
  return "HIGH";
}

function normalizeBudgetForKind(budget: number, kind: ThinkingKind): number | null {
  if (!Number.isFinite(budget)) return null;
  if (budget === -1) return -1; // 动态：原样保留
  switch (kind) {
    case "budget-pro":
      return clamp(Math.round(budget), 128, 32768);
    case "budget-flash":
      return clamp(Math.round(budget), 0, 24576);
    case "budget-flash-lite":
      return budget <= 0 ? 0 : clamp(Math.round(budget), 512, 24576);
    default:
      return null;
  }
}

function levelAllowed(kind: ThinkingKind, level: ThinkingLevel): ThinkingLevel {
  switch (kind) {
    case "levels-no-minimal":
      return level === "NONE" || level === "MINIMAL" ? "LOW" : level;
    case "levels-minimal-high":
      return level === "MEDIUM" || level === "HIGH" ? "HIGH" : "MINIMAL";
    case "levels-low-high":
      return level === "MEDIUM" || level === "HIGH" ? "HIGH" : "LOW";
    default:
      return level;
  }
}

/**
 * 出站前对 generationConfig.thinkingConfig 做最终归一化：
 *   - 输入 cfg 可能带 thinkingLevel / thinkingBudget / includeThoughts（来自协议转换或原生透传）；
 *   - 返回 null 表示删除整个 thinkingConfig（模型不支持思考）；
 *   - 返回对象里 thinkingBudget 与 thinkingLevel 只保留一个（对齐模型支持的字段形态）。
 */
export function normalizeThinkingConfig(model: string, cfg: ThinkingConfig | undefined | null): ThinkingConfig | null {
  const kind = thinkingKindForModel(model);
  if (kind === "unsupported") return null;
  if (kind === "fixed") {
    // 保留 includeThoughts（展示思考摘要），移除强度字段
    if (cfg?.includeThoughts !== undefined) return { includeThoughts: cfg.includeThoughts };
    return null;
  }
  const out: ThinkingConfig = {};
  if (cfg?.includeThoughts !== undefined) out.includeThoughts = !!cfg.includeThoughts;

  const hasLevel = typeof cfg?.thinkingLevel === "string" && cfg.thinkingLevel.length > 0;
  const hasBudget = typeof cfg?.thinkingBudget === "number" && Number.isFinite(cfg.thinkingBudget);

  if (kind === "passthrough") {
    // 未知模型：原样透传（不猜字段形态）
    if (hasLevel) out.thinkingLevel = String(cfg!.thinkingLevel).toUpperCase() as ThinkingLevel;
    if (hasBudget) out.thinkingBudget = cfg!.thinkingBudget;
    return Object.keys(out).length > 0 ? out : null;
  }

  if (kind === "budget-pro" || kind === "budget-flash" || kind === "budget-flash-lite") {
    let budget: number | null = null;
    if (hasBudget) budget = normalizeBudgetForKind(cfg!.thinkingBudget!, kind);
    else if (hasLevel) {
      const level = canonicalLevel(String(cfg!.thinkingLevel));
      if (level) {
        // NONE → 0（pro 128）；2.5 系字段形态是 budget
        budget = levelToBudget(level, kind);
      }
    } else return Object.keys(out).length > 0 ? out : null;
    if (budget === null) return Object.keys(out).length > 0 ? out : null;
    if (budget === -1) {
      out.thinkingBudget = -1;
    } else if (budget <= 0 && kind === "budget-pro") {
      out.thinkingBudget = 128; // pro 无法关闭
    } else if (budget <= 0 && kind === "budget-flash-lite") {
      out.thinkingBudget = 0;
    } else if (budget > 0 && kind === "budget-flash-lite" && budget < 512) {
      out.thinkingBudget = 512; // 正数下限 512
    } else {
      out.thinkingBudget = budget;
    }
    return out;
  }

  // levels-* 家族：字段形态是 thinkingLevel
  let level: ThinkingLevel | null = null;
  if (hasLevel) level = canonicalLevel(String(cfg!.thinkingLevel));
  else if (hasBudget) level = budgetToLevel(cfg!.thinkingBudget!);
  if (level) out.thinkingLevel = levelAllowed(kind, level);
  return Object.keys(out).length > 0 ? out : null;
}

/** OpenAI reasoning_effort → 思考档位；"auto"/"default"/空 → null（不设置，让模型用默认行为） */
export function reasoningEffortToLevel(v: unknown): ThinkingLevel | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (!s || s === "auto" || s === "default") return null;
  const level = canonicalLevel(s);
  return level; // canonicalLevel 已把 xhigh/max 归到 HIGH、none/disabled/off 归到 NONE
}

/**
 * Anthropic thinking 配置 → thinkingConfig。
 *   - enabled：需要 budget_tokens ≥ 1024 → budget；无 budget → thinkingLevel HIGH
 *   - adaptive：默认 HIGH
 *   - disabled：NONE
 * display === "omitted" 时关闭 includeThoughts，否则开启。
 */
export function anthropicThinkingToConfig(
  thinking: unknown,
  display?: unknown,
): ThinkingConfig | null {
  const out: ThinkingConfig = {};
  out.includeThoughts = display !== "omitted";
  if (thinking && typeof thinking === "object") {
    const t = thinking as { type?: string; budget_tokens?: unknown };
    if (t.type === "disabled") {
      out.thinkingLevel = "NONE";
      return out;
    }
    if (t.type === "enabled") {
      const b = Number(t.budget_tokens);
      if (Number.isFinite(b) && b >= 1024) out.thinkingBudget = b; // 家族 clamp 在 normalizeThinkingConfig 完成
      else out.thinkingLevel = "HIGH";
      return out;
    }
    if (t.type === "adaptive") {
      out.thinkingLevel = "HIGH";
      return out;
    }
  }
  // 未传 thinking：只保留 includeThoughts 语义
  return out.includeThoughts ? out : null;
}
