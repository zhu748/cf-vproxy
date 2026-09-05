// Token 计数缓存 —— 移植自 vertex-master internal/vertex/counttokens_cache.go（Workers 版）
//
//   - key = 模型 + 结构化稳定序列化（对象键排序）的 contents；
//   - TTL 5 分钟，最多 256 条，仅缓存 totalTokens > 0 的结果；
//   - 超容量按「最旧写入」淘汰（对齐原项目 LRU-by-oldest 语义）；
//   - single-flight：并发相同查询合并为一次上游调用。
//
// ⚠️ 纯逻辑文件：KV/fetch 由调用方注入，可在 Node 单测中直接运行。

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 256;

interface CacheEntry {
  totalTokens: number;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const flights = new Map<string, Promise<number>>();

/** 稳定序列化：对象键排序、数组保序（对齐原项目 structurally-hashed contents） */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = walk(obj[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

export function countTokensCacheKey(model: string, contents: unknown): string {
  return model + "|" + stableStringify(contents);
}

/** 查缓存（TTL 过期即未命中） */
export function cacheGet(key: string): number | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.totalTokens;
}

function cachePut(key: string, totalTokens: number): void {
  if (totalTokens <= 0) return; // 仅缓存有效计数
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // 淘汰最旧写入
    let oldestKey = "";
    let oldestAt = Infinity;
    for (const [k, v] of cache) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { totalTokens, at: Date.now() });
}

/** 清空缓存（测试/管理用） */
export function cacheClear(): void {
  cache.clear();
  flights.clear();
}

export function cacheStats(): { entries: number } {
  return { entries: cache.size };
}

/**
 * single-flight 包装：并发相同 key 的查询等待同一个 Promise。
 * loader 抛错时不上缓存，直接透出。
 */
export async function countTokensWithCache(key: string, loader: () => Promise<number>): Promise<number> {
  const cached = cacheGet(key);
  if (cached !== null) return cached;
  const flight = flights.get(key);
  if (flight) return flight;
  const p = (async () => {
    try {
      const n = await loader();
      cachePut(key, n);
      return n;
    } finally {
      flights.delete(key);
    }
  })();
  flights.set(key, p);
  return p;
}

/**
 * 原生 Gemini :countTokens 请求体规范化 —— 移植自 internal/api/gemini_request.go：
 * generateContentRequest 信封解包；contents 兼容 string/object/array。
 */
export function unwrapCountTokensBody(body: unknown): { contents: unknown; model?: string } {
  if (!body || typeof body !== "object") return { contents: [] };
  const b = body as Record<string, unknown>;
  const inner = b.generateContentRequest && typeof b.generateContentRequest === "object" ? (b.generateContentRequest as Record<string, unknown>) : b;
  let contents: unknown = inner.contents ?? inner.content ?? [];
  if (typeof contents === "string") {
    contents = [{ role: "user", parts: [{ text: contents }] }];
  } else if (contents && typeof contents === "object" && !Array.isArray(contents)) {
    const c = contents as Record<string, unknown>;
    contents = [Array.isArray(c.parts) ? c : { role: "user", parts: [{ text: JSON.stringify(c) }] }];
  } else if (!Array.isArray(contents)) {
    contents = [];
  }
  return { contents, model: typeof inner.model === "string" ? inner.model : undefined };
}

/**
 * 用量回填：生成响应缺 usageMetadata 时，用 :countTokens 精确补算
 * （移植自 completeProtocolUsageWithCountTokens）：
 *   输入 = systemInstruction（并成 user 内容） + contents
 *   输出 = 模型内容（thought/text/functionCall parts）
 * 永不本地估算；一侧缺失时从 total 推导。
 */
export function buildCountBackfillContents(
  greq: { contents?: unknown; systemInstruction?: unknown },
  gresp: { candidates?: Array<{ content?: { parts?: unknown[] } }> },
): unknown {
  const input: unknown[] = [];
  const sys = greq.systemInstruction as { parts?: unknown[] } | undefined;
  if (sys && Array.isArray(sys.parts)) input.push({ role: "user", parts: sys.parts });
  const reqContents = Array.isArray(greq.contents) ? greq.contents : [];
  input.push(...reqContents);
  const outParts: unknown[] = [];
  const cand = gresp.candidates?.[0];
  if (cand?.content && Array.isArray(cand.content.parts)) outParts.push(...cand.content.parts);
  return {
    contents: [
      ...input,
      ...(outParts.length > 0 ? [{ role: "model", parts: outParts }] : []),
    ],
  };
}
