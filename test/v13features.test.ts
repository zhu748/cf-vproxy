// v1.3.0 新增功能单测：配置扩展（base_url/max_n/health_check/node_retry）、
// resolveN、metrics、cron 判定（Node 直跑，无 Workers 依赖）
import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeBaseUrl, sanitizeConfig } from "../src/config.ts";
import {
  sanitizeHealthCheckConfig,
  sanitizeRacingConfig,
  DEFAULT_RACING,
  DEFAULT_HEALTH_CHECK,
  sweepDue,
  keepaliveDue,
} from "../src/racing.ts";
import { resolveN } from "../src/convert/common.ts";
import {
  metricsBegin,
  metricsFinish,
  snapshotMetrics,
  mergeSnapshots,
  renderPrometheus,
  resetMetricsForTest,
} from "../src/metrics.ts";


// ---------- sanitizeBaseUrl ----------

test("sanitizeBaseUrl: 空值与非法值回退空串", () => {
  assert.equal(sanitizeBaseUrl(""), "");
  assert.equal(sanitizeBaseUrl(undefined), "");
  assert.equal(sanitizeBaseUrl("ftp://x.com"), "");
  assert.equal(sanitizeBaseUrl("not a url"), "");
});

test("sanitizeBaseUrl: 裸域名自动补 /v1beta，完整路径保留", () => {
  assert.equal(sanitizeBaseUrl("https://mirror.example.com"), "https://mirror.example.com/v1beta");
  assert.equal(sanitizeBaseUrl("https://mirror.example.com/"), "https://mirror.example.com/v1beta");
  assert.equal(sanitizeBaseUrl("https://mirror.example.com/v1beta"), "https://mirror.example.com/v1beta");
  assert.equal(sanitizeBaseUrl("http://localhost:8080/gemini/v1beta///"), "http://localhost:8080/gemini/v1beta");
});

// ---------- health_check / racing.node_retry ----------

test("sanitizeHealthCheckConfig: 默认值与钳位", () => {
  const d = sanitizeHealthCheckConfig(undefined);
  assert.deepEqual(d, DEFAULT_HEALTH_CHECK);
  const clamped = sanitizeHealthCheckConfig({
    enabled: 1,
    interval_minutes: 1,
    batch_size: 999,
    concurrency: 99,
    timeout_seconds: 1,
  });
  assert.equal(clamped.enabled, true);
  assert.equal(clamped.interval_minutes, 5);
  assert.equal(clamped.batch_size, 40);
  assert.equal(clamped.concurrency, 10);
  assert.equal(clamped.timeout_seconds, 2);
});

test("sanitizeRacingConfig: node_retry 默认 true，显式 false 保留", () => {
  assert.equal(sanitizeRacingConfig({}).node_retry, DEFAULT_RACING.node_retry);
  assert.equal(sanitizeRacingConfig({ node_retry: false }).node_retry, false);
  assert.equal(sanitizeRacingConfig({ node_retry: true }).node_retry, true);
});

// ---------- config 全量 sanitize 兼容新字段 ----------

test("sanitizeConfig: 保留 gemini_base_url / max_n / health_check", () => {
  const cfg = sanitizeConfig({
    gemini_key: "k",
    gemini_base_url: "https://m.example.com",
    max_n: 99,
    health_check: { enabled: false, interval_minutes: 30, batch_size: 10, concurrency: 2, timeout_seconds: 4 },
    proxies: ["socks5://1.2.3.4:1080"],
  });
  assert.equal(cfg.gemini_base_url, "https://m.example.com/v1beta");
  assert.equal(cfg.max_n, 32);
  assert.equal(cfg.health_check.enabled, false);
  assert.equal(cfg.health_check.interval_minutes, 30);
  assert.equal(cfg.proxies.length, 1);
});

test("sanitizeConfig: 非法 base_url 回退空串（走官方地址）", () => {
  const cfg = sanitizeConfig({ gemini_base_url: "javascript:alert(1)" });
  assert.equal(cfg.gemini_base_url, "");
});

// ---------- resolveN（原项目 max_n 语义） ----------

test("resolveN: 缺省 1", () => {
  assert.deepEqual(resolveN(undefined, 8), { n: 1 });
  assert.deepEqual(resolveN(null, 8), { n: 1 });
});

test("resolveN: 非整数/越界报错文案与原项目一致", () => {
  assert.match(resolveN(1.5, 8).error ?? "", /n 必须是整数/);
  assert.match(resolveN(0, 8).error ?? "", /n 必须 >= 1/);
  assert.match(resolveN(-3, 8).error ?? "", /n 必须 >= 1/);
  assert.match(resolveN(9, 8).error ?? "", /n 超过上限 8/);
  assert.match(resolveN(33, 32).error ?? "", /n 超过上限 32/);
});

test("resolveN: 合法值直通", () => {
  assert.deepEqual(resolveN(1, 8), { n: 1 });
  assert.deepEqual(resolveN(8, 8), { n: 8 });
  assert.deepEqual(resolveN(5, 0), { n: 5 }); // maxN<=0 时回退 8
});

// ---------- metrics ----------

test("metrics: begin/finish 计数、延迟、状态分桶", () => {
  resetMetricsForTest();
  metricsBegin();
  metricsBegin();
  metricsBegin();
  metricsBegin();
  metricsFinish(200, 100, "openai");
  metricsFinish(429, 50, "openai");
  metricsFinish(500, 30, "gemini");
  const s = snapshotMetrics();
  assert.equal(s.total, 4); // metricsBegin 即计总数（4 次进入）
  assert.equal(s.errors, 2); // 429 + 500
  assert.equal(s.active, 1); // 4 begin - 3 finish（最后一个仍在飞）
  assert.equal(s.status.successful, 1);
  assert.equal(s.status.client_error, 1);
  assert.equal(s.status.server_error, 1);
  assert.equal(s.protocol.openai, 2);
  assert.equal(s.protocol.gemini, 1);
  assert.equal(s.maximum_latency_ms, 100);
  assert.equal(s.average_latency_ms, 45); // (100+50+30)/4，按进入请求数平均（对齐原项目 metrics.go）
});

test("metrics: mergeSnapshots 合并 KV 历史 + 内存增量", () => {
  resetMetricsForTest();
  metricsBegin();
  metricsFinish(200, 200, "anthropic");
  const mem = snapshotMetrics();
  const merged = mergeSnapshots(
    {
      active: 0,
      total: 10,
      errors: 1,
      average_latency_ms: 50,
      maximum_latency_ms: 400,
      status: { unknown: 0, informational: 0, successful: 9, redirection: 0, client_error: 1, server_error: 0 },
      protocol: { openai: 10 },
      updated_at: "2026-01-01T00:00:00Z",
    },
    mem,
  );
  assert.equal(merged.total, 11);
  assert.equal(merged.errors, 1);
  assert.equal(merged.maximum_latency_ms, 400);
  assert.equal(merged.protocol.openai, 10);
  assert.equal(merged.protocol.anthropic, 1);
  assert.equal(merged.status.successful, 10);
});

test("metrics: renderPrometheus 输出合法 exposition 文本", () => {
  resetMetricsForTest();
  metricsBegin();
  metricsFinish(200, 12, "openai");
  const text = renderPrometheus(snapshotMetrics());
  assert.match(text, /# TYPE cfvproxy_requests_total counter/);
  assert.match(text, /cfvproxy_requests_total 1/);
  assert.match(text, /cfvproxy_requests_status_total\{status="2xx"\} 1/);
  assert.match(text, /cfvproxy_requests_protocol_total\{protocol="openai"\} 1/);
});

// ---------- cron 判定 ----------

test("sweepDue: 开关/首跑/间隔判定", () => {
  const cfg = { health_check: { enabled: true, interval_minutes: 15 } };
  const now = 1_000_000_000_000;
  assert.equal(sweepDue({ health_check: { enabled: false, interval_minutes: 15 } }, 0, now), false);
  assert.equal(sweepDue(cfg, 0, now), true); // 首跑
  assert.equal(sweepDue(cfg, now - 14 * 60_000, now), false);
  assert.equal(sweepDue(cfg, now - 15 * 60_000, now), true);
});

test("keepaliveDue: URL 空/首跑立即/间隔判定（对齐原项目首次立即发送）", () => {
  const now = 1_000_000_000_000;
  assert.equal(keepaliveDue("", 60, 0, now), false);
  assert.equal(keepaliveDue("https://x.example.com/keepalive", 60, 0, now), true);
  assert.equal(keepaliveDue("https://x.example.com/keepalive", 60, now - 59_000, now), false);
  assert.equal(keepaliveDue("https://x.example.com/keepalive", 60, now - 60_000, now), true);
  // 间隔钳位最小 5 秒
  assert.equal(keepaliveDue("https://x.example.com/keepalive", 1, now - 5_000, now), true);
  assert.equal(keepaliveDue("https://x.example.com/keepalive", 1, now - 4_000, now), false);
});
