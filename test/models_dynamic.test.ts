// v1.4.0 官方 ListModels 动态模型表单测：分类规则、官方响应解析、
// 动态表激活/回退、resolveModel 接入动态表（Node 直跑，无 Workers 依赖）
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyModels,
  buildTable,
  parseOfficialModelsResponse,
  builtinTable,
  setActiveTable,
  activeTable,
  activeSourceInfo,
  listChatModels,
  listNativeOnlyModels,
  listExcludedModels,
  isChatModelActive,
  isKnownModelActive,
  modelMeta,
  type GModelMeta,
} from "../src/modellist.ts";
import { ALL_MODELS, GEMINI_CHAT_MODELS, GEMINI_NATIVE_ONLY_MODELS, isChatModel, isKnownModel } from "../src/models.ts";
import { resolveModel } from "../src/modelresolve.ts";
import { sanitizeConfig } from "../src/config.ts";

// ---------- 内置表（来自 models_data.ts，官方拉取基线） ----------

test("内置模型表: 官方拉取基线完整可用", () => {
  assert.ok(GEMINI_CHAT_MODELS.length >= 30, "chat 模型应不少于 30 个");
  assert.ok(GEMINI_NATIVE_ONLY_MODELS.length >= 1, "应有原生透传模型（veo 系列）");
  assert.ok(isChatModel("gemini-2.5-flash"));
  assert.ok(isChatModel("gemini-3.8-flash"));
  assert.ok(isKnownModel("veo-3.1-generate-preview"));
  assert.ok(!isKnownModel("gemini-embedding-001"), "embedding 模型应被排除");
  assert.ok(!isKnownModel("aqa"), "generateAnswer 模型应被排除");
  assert.ok(!isKnownModel("gemini-3.1-flash-live-preview"), "bidi 实时模型应被排除");
});

test("内置模型表: builtinTable 分类与排除", () => {
  const t = builtinTable();
  assert.equal(t.source, "builtin");
  assert.ok(t.chat.length + t.native_only.length === ALL_MODELS.length);
  assert.ok(t.excluded.length >= 10, "排除的 embedding/bidi/aqa 模型应大于 10 个");
  const m = t.meta.get("gemini-2.5-flash");
  assert.ok(m && m.display_name === "Gemini 2.5 Flash" && m.input_token_limit === 1048576);
});

// ---------- classifyModels ----------

test("classifyModels: chat / native_only / excluded 三桶", () => {
  const models: GModelMeta[] = [
    { name: "m-chat", methods: ["generateContent", "countTokens"] },
    { name: "m-predict", methods: ["predict"] },
    { name: "m-veo", methods: ["predictLongRunning"] },
    { name: "m-embed", methods: ["embedContent"] },
    { name: "m-bidi", methods: ["bidiGenerateContent"] },
    { name: "m-aqa", methods: ["generateAnswer"] },
  ];
  const cls = classifyModels(models);
  assert.deepEqual(cls.chat.map((m) => m.name), ["m-chat"]);
  assert.deepEqual(cls.native_only.map((m) => m.name), ["m-predict", "m-veo"]);
  assert.deepEqual(cls.excluded.map((m) => m.name), ["m-embed", "m-bidi", "m-aqa"]);
});

test("classifyModels: 非法条目过滤", () => {
  const cls = classifyModels([
    { name: "", methods: ["generateContent"] },
    { name: "bad-methods", methods: "generateContent" as unknown as string[] },
    null as unknown as GModelMeta,
    { name: "ok", methods: ["generateContent"] },
  ]);
  assert.equal(cls.chat.length, 1);
  assert.equal(cls.chat[0].name, "ok");
});

// ---------- parseOfficialModelsResponse ----------

test("parseOfficialModelsResponse: 官方单页解析（去前缀+元数据映射+分页）", () => {
  const r = parseOfficialModelsResponse({
    models: [
      {
        name: "models/gemini-x",
        displayName: "Gemini X",
        description: "desc",
        version: "001",
        inputTokenLimit: 1000,
        outputTokenLimit: 100,
        thinking: true,
        temperature: 1,
        topP: 0.95,
        topK: 64,
        supportedGenerationMethods: ["generateContent", "countTokens"],
      },
      { name: "models/veo-y", supportedGenerationMethods: ["predictLongRunning"] },
      { name: "models/", supportedGenerationMethods: ["generateContent"] },
      {},
    ],
    nextPageToken: "tok-2",
  });
  assert.equal(r.models.length, 2);
  assert.equal(r.models[0].name, "gemini-x");
  assert.equal(r.models[0].display_name, "Gemini X");
  assert.equal(r.models[0].input_token_limit, 1000);
  assert.equal(r.models[0].thinking, true);
  assert.deepEqual(r.models[0].methods, ["generateContent", "countTokens"]);
  assert.deepEqual(r.models[1].methods, ["predictLongRunning"]);
  assert.equal(r.nextPageToken, "tok-2");
});

test("parseOfficialModelsResponse: 非法响应安全返回空", () => {
  assert.deepEqual(parseOfficialModelsResponse(null).models, []);
  assert.deepEqual(parseOfficialModelsResponse("x").models, []);
  assert.deepEqual(parseOfficialModelsResponse({}).models, []);
  assert.deepEqual(parseOfficialModelsResponse({ models: "no" }).models, []);
  assert.equal(parseOfficialModelsResponse({ models: [] }).nextPageToken, undefined);
});

// ---------- 动态表激活与回退 ----------

test("buildTable + setActiveTable: 动态表即刻生效（同步查询函数）", () => {
  const dynamic = [
    { name: "official-only-model", methods: ["generateContent"] },
    { name: "veo-official", methods: ["predictLongRunning"] },
    { name: "embed-x", methods: ["embedContent"] },
  ];
  setActiveTable(buildTable("official", "2026-09-05T00:00:00Z", dynamic));
  assert.equal(activeTable().source, "official");
  assert.equal(activeSourceInfo().source, "official");
  assert.equal(activeSourceInfo().total, 2);
  assert.ok(isChatModelActive("official-only-model"));
  assert.ok(isKnownModelActive("veo-official"));
  assert.ok(!isKnownModelActive("embed-x"));
  assert.ok(listChatModels().includes("official-only-model"));
  assert.ok(listNativeOnlyModels().includes("veo-official"));
  assert.ok(listExcludedModels().includes("embed-x"));
  const mm = modelMeta("official-only-model");
  assert.ok(mm && mm.name === "official-only-model");
});

test("resolveModel: 动态表生效后新模型可用、已下线模型 404", () => {
  const cfg = sanitizeConfig({});
  setActiveTable(buildTable("official", undefined, [{ name: "brand-new-model", methods: ["generateContent"] }]));
  const okRes = resolveModel(cfg, "brand-new-model", true);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.model, "brand-new-model");
  // 内置表里有但官方拉取后不在表中 → 官方表优先，返回 404
  const gone = resolveModel(cfg, "gemini-2.5-flash", true);
  assert.equal(gone.ok, false);
  assert.equal(gone.status, 404);
});

test("activeTable: 回退内置表", () => {
  setActiveTable(builtinTable());
  assert.equal(activeTable().source, "builtin");
  assert.ok(isChatModelActive("gemini-2.5-flash"));
  assert.ok(!isChatModelActive("brand-new-model"));
  assert.equal(activeSourceInfo().source, "builtin");
});

// ---------- KV 持久化（mock KVNamespace） ----------

function mockKV(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const counts = { gets: 0, puts: 0, deletes: 0 };
  return {
    counts,
    VPROXY_KV: {
      get: async (key: string, type?: string) => {
        counts.gets++;
        if (!store.has(key)) return null;
        const v = store.get(key);
        if (type === "json" && typeof v === "string") {
          try {
            return JSON.parse(v);
          } catch {
            return null;
          }
        }
        return v;
      },
      put: async (key: string, value: string) => {
        counts.puts++;
        store.set(key, value);
      },
      delete: async (key: string) => {
        counts.deletes++;
        store.delete(key);
      },
    },
  } as unknown as { VPROXY_KV: KVNamespace; counts: typeof counts };
}

test("loadActiveModels/storeDynamicModels/clearDynamicModels: KV 往返", async () => {
  const { loadActiveModels, storeDynamicModels, clearDynamicModels } = await import("../src/modellist.ts");
  const kv = mockKV();
  setActiveTable(builtinTable());

  // 1) KV 无动态表 → 内置表
  await loadActiveModels(kv, true);
  assert.equal(activeTable().source, "builtin");

  // 2) 存入动态表 → 立即生效 + KV 写入
  await storeDynamicModels(kv, [{ name: "kv-model", methods: ["generateContent"] }], "2026-09-05T12:00:00Z");
  assert.equal(kv.counts.puts, 1);
  assert.equal(activeTable().source, "official");
  assert.ok(isChatModelActive("kv-model"));

  // 3) force 重载（模拟新 isolate / 缓存过期）→ 从 KV 恢复官方表
  setActiveTable(builtinTable());
  await loadActiveModels(kv, true);
  assert.equal(activeTable().source, "official");
  assert.ok(isChatModelActive("kv-model"));
  assert.equal(activeTable().fetched_at, "2026-09-05T12:00:00Z");

  // 4) 恢复内置 → KV 删除 + 回退
  await clearDynamicModels(kv);
  assert.equal(kv.counts.deletes, 1);
  assert.equal(activeTable().source, "builtin");
});

test("loadActiveModels: KV 损坏数据回退内置表", async () => {
  const { loadActiveModels } = await import("../src/modellist.ts");
  const kv = mockKV({ "models:dynamic": { fetched_at: "x", models: [] } });
  setActiveTable(builtinTable());
  await loadActiveModels(kv, true);
  assert.equal(activeTable().source, "builtin");
});

test("loadActiveModels: KV 抛异常不影响服务（回退内置表）", async () => {
  const { loadActiveModels } = await import("../src/modellist.ts");
  const bad = {
    VPROXY_KV: {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {},
      delete: async () => {},
    },
  } as unknown as { VPROXY_KV: KVNamespace };
  setActiveTable(builtinTable());
  await loadActiveModels(bad, true);
  assert.equal(activeTable().source, "builtin");
});
