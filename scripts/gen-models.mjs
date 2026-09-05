#!/usr/bin/env node
// 重新生成内置模型表 src/models_data.ts（官方 ListModels 一次性拉取方式）
//
// 用法：
//   GEMINI_API_KEY=你的Key node scripts/gen-models.mjs [输出文件]
//   GEMINI_BASE_URL=https://your-mirror.example.com/v1beta GEMINI_API_KEY=xx node scripts/gen-models.mjs
//
// 说明：部署后无需重新生成本文件也可以更新模型表 —— 面板「模型」页的
// 「从官方重新拉取」按钮会用当前配置的 Key 在线上直接拉取并写 KV。

const KEY = process.env.GEMINI_API_KEY || "";
const BASE = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
const OUT = process.argv[2] || new URL("../src/models_data.ts", import.meta.url).pathname;

if (!KEY) {
  console.error("缺少 GEMINI_API_KEY 环境变量");
  process.exit(1);
}

async function listPage(pageToken) {
  const url = `${BASE}/models?pageSize=1000${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`;
  const res = await fetch(url, { headers: { "x-goog-api-key": KEY, accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error?.message ?? res.statusText}`);
  return body;
}

const models = [];
let token = undefined;
let pages = 0;
for (let i = 0; i < 4; i++) {
  const page = await listPage(token);
  pages++;
  for (const m of page.models || []) {
    const name = String(m.name || "").replace(/^models\//, "");
    if (!name) continue;
    const entry = { name };
    for (const [src, dst] of [
      ["displayName", "display_name"],
      ["description", "description"],
      ["version", "version"],
      ["inputTokenLimit", "input_token_limit"],
      ["outputTokenLimit", "output_token_limit"],
    ]) {
      if (m[src] !== undefined && m[src] !== null && m[src] !== "") entry[dst] = m[src];
    }
    entry.methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
    for (const [src, dst] of [["thinking", "thinking"], ["temperature", "temperature"], ["topP", "top_p"], ["topK", "top_k"]]) {
      if (m[src] !== undefined && m[src] !== null) entry[dst] = m[src];
    }
    models.push(entry);
  }
  if (!page.nextPageToken) break;
  token = page.nextPageToken;
}

const fetchedAt = new Date().toISOString().slice(0, 10);
const lines = [];
lines.push("// 内置模型表数据 —— 由官方 ListModels API 一次性拉取后生成");
lines.push("// 生成工具：scripts/gen-models.mjs（仓库内，可在面板外手动重生成）");
lines.push("// 数据来源：GET {gemini_base}/v1beta/models?pageSize=1000（x-goog-api-key 鉴权）");
lines.push(`// 拉取时间：${fetchedAt}，共 ${models.length} 个模型`);
lines.push("//");
lines.push("// 分类规则（运行时由 src/modellist.ts 的 classifyModels 执行）：");
lines.push("//   chat        —— supportedGenerationMethods 含 generateContent（OpenAI/Anthropic/Gemini 三入口可用）");
lines.push("//   native_only —— 仅 predict / predictLongRunning（Gemini 原生透传 :predict / :predictLongRunning）");
lines.push("//   excluded    —— 仅 embedContent / generateAnswer / bidiGenerateContent（本代理不透传，自动排除）");
lines.push("");
lines.push(`export const BUILTIN_FETCHED_AT = ${JSON.stringify(fetchedAt)};`);
lines.push("");
lines.push("export interface BuiltinModelMeta {");
lines.push("  name: string;");
lines.push("  display_name?: string;");
lines.push("  description?: string;");
lines.push("  version?: string;");
lines.push("  input_token_limit?: number;");
lines.push("  output_token_limit?: number;");
lines.push("  methods: string[];");
lines.push("  thinking?: boolean;");
lines.push("  temperature?: number;");
lines.push("  top_p?: number;");
lines.push("  top_k?: number;");
lines.push("}");
lines.push("");
lines.push("export const BUILTIN_MODEL_META: BuiltinModelMeta[] = [");
for (const m of models) lines.push("  " + JSON.stringify(m) + ",");
lines.push("];");
lines.push("");

const fs = await import("node:fs");
fs.writeFileSync(OUT, lines.join("\n"));
console.log(`已生成 ${OUT}：${models.length} 个模型，${pages} 页`);
