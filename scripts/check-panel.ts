// 面板 HTML/JS 语法级校验：抽取拼装结果中的 <script>，用 node --check 验证 JS 语法
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { renderPanelHtml } from "../src/handlers/panel.ts";

const html = renderPanelHtml();
const m = /<script>\n([\s\S]*?)<\/script>/.exec(html);
if (!m) {
  console.error("FAIL: 未找到 <script> 块");
  process.exit(1);
}
const js = m[1];
writeFileSync("/tmp/panel_check.mjs", js);
console.log("panel html bytes:", html.length);
console.log("panel js bytes:", js.length);
execFileSync(process.execPath, ["--check", "/tmp/panel_check.mjs"]);
// 基本结构断言
for (const needle of ['id="v-race"', 'data-v="race"', "race-test-all", "race-save", "/proxies/test-all", "/health"]) {
  if (!html.includes(needle)) {
    console.error("FAIL: 缺少关键元素", needle);
    process.exit(1);
  }
}
console.log("OK: 面板 JS 语法通过，竞速页签与健康度端点齐备");
