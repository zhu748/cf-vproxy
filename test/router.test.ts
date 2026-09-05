// 路由表单元测试：v1.6.0 抽离的纯路由匹配模块（src/router.ts）。
// 此前路由分散在 index.ts（import 链拉进 cloudflare:sockets，Node 无法加载），
// 现在可以完整回归 —— 重点覆盖本次新接线的 5 个孤立端点与单模型查询。
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchApiRoute, NEEDS_UPSTREAM } from "../src/router.ts";

test("router: OpenAI chat / models", () => {
  assert.deepEqual(matchApiRoute("POST", "/v1/chat/completions"), { kind: "chat_completions" });
  assert.deepEqual(matchApiRoute("GET", "/v1/models"), { kind: "openai_models" });
});

test("router: v1.6.0 新接线端点全部可达", () => {
  assert.deepEqual(matchApiRoute("POST", "/v1/responses"), { kind: "responses" });
  assert.deepEqual(matchApiRoute("POST", "/v1/audio/speech"), { kind: "audio_speech" });
  assert.deepEqual(matchApiRoute("POST", "/v1/images/generations"), { kind: "images_generations" });
  assert.deepEqual(matchApiRoute("POST", "/v1/images/edits"), { kind: "images_edits" });
  assert.deepEqual(matchApiRoute("POST", "/v1/images/variations"), { kind: "images_variations" });
});

test("router: 单模型查询（含 URL 编码模型名）", () => {
  assert.deepEqual(matchApiRoute("GET", "/v1/models/gemini-2.5-pro"), {
    kind: "openai_model_detail",
    model: "gemini-2.5-pro",
  });
  assert.deepEqual(matchApiRoute("GET", "/v1/models/" + encodeURIComponent("假流式-gemini-2.5-pro")), {
    kind: "openai_model_detail",
    model: "假流式-gemini-2.5-pro",
  });
  // POST 不匹配详情端点
  assert.equal(matchApiRoute("POST", "/v1/models/gemini-2.5-pro").kind, "unknown");
});

test("router: Anthropic 端点", () => {
  assert.deepEqual(matchApiRoute("POST", "/v1/messages"), { kind: "anthropic_messages" });
  assert.deepEqual(matchApiRoute("POST", "/v1/messages/count_tokens"), { kind: "anthropic_count_tokens" });
  // GET /v1/messages 不是合法路由
  assert.equal(matchApiRoute("GET", "/v1/messages").kind, "unknown");
});

test("router: Gemini 原生端点（模型名 + 动作）", () => {
  assert.deepEqual(matchApiRoute("GET", "/v1beta/models"), { kind: "gemini_list_models" });
  const r = matchApiRoute("POST", "/v1beta/models/gemini-2.5-pro:generateContent");
  assert.equal(r.kind, "gemini_native");
  assert.equal(r.model, "gemini-2.5-pro");
  assert.equal(r.action, "generateContent");

  const s = matchApiRoute("POST", "/v1beta/models/gemini-2.5-pro:streamGenerateContent");
  assert.equal(s.action, "streamGenerateContent");

  // GET 动作端点不匹配（保持旧行为）
  assert.equal(matchApiRoute("GET", "/v1beta/models/gemini-2.5-pro:generateContent").kind, "unknown");
  // 非法动作名不匹配
  assert.equal(matchApiRoute("POST", "/v1beta/models/gemini-2.5-pro:not-an-action!").kind, "unknown");
});

test("router: 未知路径 / 方法不匹配", () => {
  assert.equal(matchApiRoute("POST", "/v1/unknown").kind, "unknown");
  assert.equal(matchApiRoute("GET", "/v1/chat/completions").kind, "unknown");
  assert.equal(matchApiRoute("DELETE", "/v1/models").kind, "unknown");
});

test("router: NEEDS_UPSTREAM 分类正确（列表类端点不需要代理池）", () => {
  assert.ok(NEEDS_UPSTREAM.has("chat_completions"));
  assert.ok(NEEDS_UPSTREAM.has("responses"));
  assert.ok(NEEDS_UPSTREAM.has("audio_speech"));
  assert.ok(NEEDS_UPSTREAM.has("images_edits"));
  assert.ok(NEEDS_UPSTREAM.has("gemini_native"));
  assert.ok(NEEDS_UPSTREAM.has("anthropic_messages"));

  assert.ok(!NEEDS_UPSTREAM.has("openai_models"));
  assert.ok(!NEEDS_UPSTREAM.has("openai_model_detail"));
  assert.ok(!NEEDS_UPSTREAM.has("gemini_list_models"));
  assert.ok(!NEEDS_UPSTREAM.has("unknown"));
});
