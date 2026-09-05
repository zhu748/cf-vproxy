// 配置层单元测试：单 Gemini Key 简化（兼容旧 gemini_keys）、代理列表自动清洗
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeConfig, parseList } from "../src/config.ts";

test("parseList: 逗号/换行/空值", () => {
  assert.deepEqual(parseList("a, b,,c\nd"), ["a", "b", "c", "d"]);
  assert.deepEqual(parseList(undefined), []);
  assert.deepEqual(parseList(""), []);
});

test("sanitizeConfig: 新版单 gemini_key", () => {
  const cfg = sanitizeConfig({ gemini_key: "AIzaSyABC", api_keys: ["k1"], proxies: [] });
  assert.equal(cfg.gemini_key, "AIzaSyABC");
  assert.deepEqual(cfg.api_keys, ["k1"]);
});

test("sanitizeConfig: 兼容旧版 gemini_keys 数组（取第一个）", () => {
  const cfg = sanitizeConfig({ gemini_keys: ["AIzaSyOLD1", "AIzaSyOLD2"], api_keys: ["k1"] });
  assert.equal(cfg.gemini_key, "AIzaSyOLD1");
});

test("sanitizeConfig: gemini_key 优先于 gemini_keys", () => {
  const cfg = sanitizeConfig({ gemini_key: "NEW", gemini_keys: ["OLD"] });
  assert.equal(cfg.gemini_key, "NEW");
});

test("sanitizeConfig: 自动剔除不支持的代理链接（https / vmess）并去重", () => {
  const cfg = sanitizeConfig({
    proxies: [
      "socks5://1.2.3.4:1080",
      "https://proxy.example.com",
      "vmess://abc",
      "socks5://1.2.3.4:1080",
      "socks4://5.6.7.8:5678",
    ],
  });
  assert.deepEqual(cfg.proxies, ["socks5://1.2.3.4:1080", "socks4://5.6.7.8:5678"]);
});

test("sanitizeConfig: 其它字段规范化", () => {
  const cfg = sanitizeConfig({
    subscription: " https://sub.example.com/x ",
    subscription_refresh_minutes: 0, // 非法 → 回落 30
    model_aliases: { "gpt-4o": "gemini-3.7-flash", bad: 123 },
    disabled_models: ["m1", "", "m2"],
  });
  assert.equal(cfg.subscription, "https://sub.example.com/x");
  assert.equal(cfg.subscription_refresh_minutes, 30);
  assert.deepEqual(cfg.model_aliases, { "gpt-4o": "gemini-3.7-flash" });
  assert.deepEqual(cfg.disabled_models, ["m1", "m2"]);
});
