// Web 管理面板：单文件内联 HTML/CSS/JS（无构建步骤、无外部依赖）。
// 访问 GET /admin（HTML 不带鉴权，token 由面板登录页输入并保存在浏览器 localStorage）。
// 设计：深色现代风（Linear/Vercel 风），六大页签：仪表盘 / 配置 / 代理 / 用量 / 模型 / 日志。

const PANEL_CSS = `
:root{
  --bg:#0b0e14;--bg2:#0f131b;--card:#141925;--card2:#181f2e;--border:#232c3d;--border2:#2e3950;
  --text:#e8ecf3;--muted:#8b95a8;--dim:#5c6478;
  --accent:#5b8cff;--accent2:#7aa5ff;--ok:#34d399;--warn:#fbbf24;--err:#f87171;--purple:#a78bfa;
  --radius:12px;--radius-sm:8px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:var(--accent);text-decoration:none}
button{font:inherit;cursor:pointer;border:none;border-radius:var(--radius-sm)}
input,textarea,select{font:inherit;color:var(--text);background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;outline:none;transition:border .15s}
input:focus,textarea:focus{border-color:var(--accent)}
input::placeholder,textarea::placeholder{color:var(--dim)}
textarea{width:100%;resize:vertical;font-family:var(--mono);font-size:12.5px}
code,code*{font-family:var(--mono);font-size:12.5px}

/* ---- 布局 ---- */
.wrap{max-width:1080px;margin:0 auto;padding:0 20px 80px}
header{position:sticky;top:0;z-index:50;background:rgba(11,14,20,.85);backdrop-filter:blur(10px);border-bottom:1px solid var(--border)}
.hbar{max-width:1080px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:16px}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px;letter-spacing:.2px}
.logo .dot{width:10px;height:10px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok)}
.logo .badge{font-size:10.5px;color:var(--accent);background:rgba(91,140,255,.12);border:1px solid rgba(91,140,255,.3);padding:1px 8px;border-radius:99px;font-weight:600}
.hspace{flex:1}
.hbtn{background:var(--card);border:1px solid var(--border);color:var(--muted);padding:6px 14px;font-size:12.5px;transition:.15s}
.hbtn:hover{color:var(--text);border-color:var(--border2)}
nav{border-bottom:1px solid var(--border);background:var(--bg2)}
.tabs{max-width:1080px;margin:0 auto;padding:0 20px;display:flex;gap:2px;overflow-x:auto}
.tab{padding:11px 18px;color:var(--muted);font-size:13.5px;border-bottom:2px solid transparent;white-space:nowrap;transition:.15s}
.tab:hover{color:var(--text)}
.tab.on{color:var(--accent2);border-bottom-color:var(--accent);font-weight:600}
main{padding-top:26px}
.view{display:none}
.view.on{display:block}
.grid{display:grid;gap:14px}
.g4{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.g2{grid-template-columns:1fr 1fr}
@media(max-width:760px){.g2{grid-template-columns:1fr}}

/* ---- 卡片 ---- */
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px}
.card h3{font-size:13px;color:var(--muted);font-weight:600;margin-bottom:10px;text-transform:uppercase;letter-spacing:.6px}
.stat .num{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.stat .sub{font-size:11.5px;color:var(--dim);margin-top:2px}
.c-accent .num{color:var(--accent2)}.c-ok .num{color:var(--ok)}.c-purple .num{color:var(--purple)}.c-warn .num{color:var(--warn)}

/* ---- 表格 ---- */
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;padding:8px 10px;border-bottom:1px solid var(--border)}
.tbl td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:top}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:rgba(91,140,255,.03)}
.tbl .num{font-variant-numeric:tabular-nums;font-family:var(--mono);font-size:12.5px}
.scroll{overflow-x:auto}

/* ---- 组件 ---- */
.btn{background:var(--accent);color:#fff;padding:8px 18px;font-size:13px;font-weight:600;transition:.15s}
.btn:hover{background:var(--accent2)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.ghost{background:var(--card2);border:1px solid var(--border);color:var(--text)}
.btn.ghost:hover{border-color:var(--accent)}
.btn.danger{background:transparent;border:1px solid rgba(248,113,113,.4);color:var(--err)}
.btn.danger:hover{background:rgba(248,113,113,.08)}
.btn.sm{padding:4px 12px;font-size:12px}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--card2);border:1px solid var(--border);border-radius:99px;padding:3px 6px 3px 12px;font-size:12.5px;font-family:var(--mono)}
.chip .x{width:16px;height:16px;line-height:15px;text-align:center;border-radius:50%;color:var(--muted);font-size:13px}
.chip .x:hover{color:var(--err);background:rgba(248,113,113,.12)}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.tag{display:inline-block;padding:1px 9px;border-radius:99px;font-size:11px;font-weight:600;letter-spacing:.3px}
.tag.socks5{background:rgba(91,140,255,.14);color:var(--accent2);border:1px solid rgba(91,140,255,.3)}
.tag.socks4{background:rgba(167,139,250,.14);color:var(--purple);border:1px solid rgba(167,139,250,.3)}
.tag.http{background:rgba(52,211,153,.12);color:var(--ok);border:1px solid rgba(52,211,153,.3)}
.tag.ok{background:rgba(52,211,153,.12);color:var(--ok)}
.tag.err{background:rgba(248,113,113,.12);color:var(--err)}
.tag.warn{background:rgba(251,191,36,.12);color:var(--warn)}
.field{margin-bottom:18px}
.field>label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:6px;font-weight:600}
.field .hint{font-size:11.5px;color:var(--dim);margin-top:5px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.model-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.model-item{background:var(--card2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;font-family:var(--mono);font-size:12.5px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.empty{color:var(--dim);text-align:center;padding:28px 0;font-size:13px}
.bar{height:6px;border-radius:3px;background:var(--bg2);overflow:hidden;margin-top:6px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--purple));border-radius:3px}
details.sub models,details.sub summary{cursor:pointer}
details.sub summary{color:var(--muted);font-size:12px;user-select:none}
details.sub summary:hover{color:var(--text)}

/* ---- 登录 ---- */
#login{position:fixed;inset:0;z-index:100;background:var(--bg);display:none;align-items:center;justify-content:center;padding:20px}
#login.on{display:flex}
.login-card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:34px}
.login-card h1{font-size:19px;margin-bottom:6px}
.login-card p{color:var(--muted);font-size:13px;margin-bottom:22px}
.login-card input{width:100%;margin-bottom:14px}
.login-err{color:var(--err);font-size:12.5px;min-height:18px;margin-bottom:8px}

/* ---- toast ---- */
#toasts{position:fixed;right:20px;bottom:20px;z-index:200;display:flex;flex-direction:column;gap:10px}
.toast{background:var(--card2);border:1px solid var(--border2);border-left:3px solid var(--accent);border-radius:var(--radius-sm);padding:11px 16px;font-size:13px;max-width:380px;box-shadow:0 8px 28px rgba(0,0,0,.45);animation:tin .2s ease}
.toast.ok{border-left-color:var(--ok)}
.toast.err{border-left-color:var(--err)}
.toast.warn{border-left-color:var(--warn)}
@keyframes tin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}

/* ---- 剔除报告 ---- */
.report{background:rgba(251,191,36,.05);border:1px solid rgba(251,191,36,.25);border-radius:var(--radius-sm);padding:12px 14px;font-size:12.5px;margin-top:12px}
.report .t{color:var(--warn);font-weight:600;margin-bottom:6px}
.report li{margin-left:18px;color:var(--muted);font-family:var(--mono);font-size:11.5px;word-break:break-all}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-1px}
@keyframes sp{to{transform:rotate(360deg)}}
`;

const PANEL_HTML = `
<div id="login">
  <div class="login-card">
    <h1>cf-vproxy 管理面板</h1>
    <p>输入 ADMIN_TOKEN 登录。token 仅保存在本浏览器 localStorage，不落服务端。</p>
    <div class="login-err" id="login-err"></div>
    <input id="login-token" type="password" placeholder="ADMIN_TOKEN" autocomplete="off">
    <button class="btn" style="width:100%" id="login-btn">登 录</button>
  </div>
</div>

<header>
  <div class="hbar">
    <div class="logo"><span class="dot" id="health-dot"></span>cf-vproxy <span class="badge" id="ver-badge">v?</span></div>
    <div class="hspace"></div>
    <span style="font-size:12px;color:var(--dim)" id="login-state">未登录</span>
    <button class="hbtn" id="logout-btn">退出</button>
  </div>
</header>
<nav><div class="tabs" id="tabs">
  <div class="tab on" data-v="dash">仪表盘</div>
  <div class="tab" data-v="cfg">配置</div>
  <div class="tab" data-v="proxy">代理</div>
  <div class="tab" data-v="race">竞速</div>
  <div class="tab" data-v="usage">用量</div>
  <div class="tab" data-v="models">模型</div>
  <div class="tab" data-v="logs">日志</div>
</div></nav>

<div class="wrap"><main>

<!-- ===== 仪表盘 ===== -->
<section class="view on" id="v-dash">
  <div class="grid g4" id="dash-stats"></div>
  <div class="grid g2" style="margin-top:14px">
    <div class="card">
      <h3>模型调用 Top</h3>
      <div id="dash-models"><div class="empty">暂无数据</div></div>
    </div>
    <div class="card">
      <h3>最近请求</h3>
      <div class="scroll" id="dash-logs"><div class="empty">暂无数据</div></div>
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <h3>服务信息</h3>
    <div class="scroll" id="dash-info"></div>
  </div>
</section>

<!-- ===== 配置 ===== -->
<section class="view" id="v-cfg">
  <div class="card">
    <div class="row" style="justify-content:space-between;margin-bottom:6px">
      <h3 style="margin:0">基础配置</h3>
      <button class="btn" id="cfg-save">保存配置</button>
    </div>
    <div class="field">
      <label>Gemini 上游 API Key（单 Key 直连，对齐原项目 official 模式）</label>
      <input id="cfg-gemini" type="password" style="width:100%;font-family:var(--mono)" placeholder="AIzaSy...">
      <div class="hint">打码显示（含 ****）。未修改时原样保存即可；输入框留空表示清除。</div>
    </div>
    <div class="field">
      <label>客户端鉴权 Key 列表（客户端请求必须携带其中之一）</label>
      <div class="chips" id="cfg-keys"></div>
      <div class="row" style="margin-top:10px">
        <input id="cfg-key-in" placeholder="添加客户端 Key，如 mykey123" style="flex:1;min-width:200px;font-family:var(--mono)">
        <button class="btn ghost sm" id="cfg-key-add">+ 添加</button>
      </div>
    </div>
    <div class="field">
      <label>订阅链接（自动拉取 socks4/socks5/http 节点；https 等不支持协议自动剔除）</label>
      <input id="cfg-sub" type="text" style="width:100%;font-family:var(--mono)" placeholder="https://example.com/sub?token=xxx">
      <div class="row" style="margin-top:8px;align-items:center">
        <span style="font-size:12.5px;color:var(--muted)">刷新间隔</span>
        <input id="cfg-sub-min" type="number" min="5" style="width:90px"> <span style="font-size:12.5px;color:var(--muted)">分钟（最小 5）</span>
        <button class="btn ghost sm" id="cfg-sub-refresh">立即刷新订阅</button>
      </div>
    </div>
    <div class="field">
      <label>模型别名（客户端请求名 → 实际 Gemini 模型）</label>
      <div id="cfg-alias-rows"></div>
      <div class="row" style="margin-top:10px">
        <input id="cfg-alias-k" placeholder="别名，如 gpt-4o" style="flex:1;min-width:160px;font-family:var(--mono)">
        <input id="cfg-alias-v" placeholder="目标模型，如 gemini-3.7-flash" style="flex:1;min-width:200px;font-family:var(--mono)">
        <button class="btn ghost sm" id="cfg-alias-add">+ 添加</button>
      </div>
    </div>
    <div class="field" style="margin-bottom:6px">
      <label>禁用模型（命中即 403）</label>
      <div class="chips" id="cfg-disabled"></div>
      <div class="row" style="margin-top:10px">
        <input id="cfg-disabled-in" placeholder="模型名，如 gemini-3.8-flash" style="flex:1;min-width:220px;font-family:var(--mono)">
        <button class="btn ghost sm" id="cfg-disabled-add">+ 添加</button>
      </div>
    </div>
  </div>
</section>

<!-- ===== 代理 ===== -->
<section class="view" id="v-proxy">
  <div class="card">
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <h3 style="margin:0">出站代理列表</h3>
      <div class="row">
        <button class="btn ghost sm" id="px-test-all">批量测试</button>
        <button class="btn" id="px-save">保存代理</button>
      </div>
    </div>
    <div class="scroll" id="px-list"></div>
    <div id="px-test-report" style="margin-top:10px"></div>
  </div>
  <div class="card" style="margin-top:14px">
    <h3>添加代理（支持 socks4:// socks4a:// socks5:// http://，可一次粘贴多行）</h3>
    <textarea id="px-add-in" rows="4" placeholder="socks5://user:pass@1.2.3.4:1080&#10;socks4://5.6.7.8:5678&#10;http://user:pass@5.6.7.8:8080"></textarea>
    <div class="row" style="margin-top:10px">
      <button class="btn" id="px-add-btn">解析并添加</button>
      <span style="font-size:12px;color:var(--dim)">https:// / vmess 等不支持的链接会自动剔除并提示原因</span>
    </div>
    <div id="px-add-report"></div>
  </div>
</section>

<!-- ===== 竞速 ===== -->
<section class="view" id="v-race">
  <div class="card">
    <div class="row" style="justify-content:space-between;margin-bottom:6px">
      <h3 style="margin:0">对冲竞速配置（移植自原项目 race engine）</h3>
      <button class="btn" id="race-save">保存竞速配置</button>
    </div>
    <div class="hint" style="margin-bottom:12px">开启后每个请求按健康分选出多个候选节点：首个立即发出，每隔对冲延迟追加下一个，首胜即停、败者立即中止；429/失败节点自动冷却并接力。关闭则退回「健康分排序 + 轮换 + 故障接力」。</div>
    <div class="grid g2">
      <div class="field">
        <label class="row" style="gap:10px;cursor:pointer"><input type="checkbox" id="race-enabled" style="width:auto"> 启用并发竞速</label>
        <div class="hint">代理池 ≥2 个节点时生效；单节点自动直发</div>
      </div>
      <div class="field">
        <label class="row" style="gap:10px;cursor:pointer"><input type="checkbox" id="race-dynamic" style="width:auto"> 动态对冲延迟（用全体健康节点平均延迟）</label>
        <div class="hint">开启后 hedge_delay_ms 被平均延迟（100ms~10s）取代</div>
      </div>
      <div class="field">
        <label>候选上限 top_k（按健康分取前 K，1~16）</label>
        <input id="race-topk" type="number" min="1" max="16" style="width:140px">
      </div>
      <div class="field">
        <label>同时在飞上限 max_concurrent（1~6）</label>
        <input id="race-mc" type="number" min="1" max="6" style="width:140px">
      </div>
      <div class="field">
        <label>对冲延迟 hedge_delay_ms（100~10000）</label>
        <input id="race-delay" type="number" min="100" max="10000" step="50" style="width:140px"> <span style="font-size:12.5px;color:var(--muted)">毫秒</span>
      </div>
      <div class="field">
        <label>单请求最多尝试节点数 max_attempts（1~20）</label>
        <input id="race-ma" type="number" min="1" max="20" style="width:140px">
      </div>
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="row" style="justify-content:space-between;margin-bottom:10px">
      <h3 style="margin:0">节点健康度（内存 + KV 快照持久化）</h3>
      <div class="row">
        <button class="btn ghost sm" id="race-refresh">刷新</button>
        <button class="btn sm" id="race-test-all">全量测速</button>
        <button class="btn danger sm" id="race-reset">重置健康度</button>
      </div>
    </div>
    <div class="grid g4" id="race-stats" style="margin-bottom:12px"></div>
    <div class="scroll" id="race-tbl"><div class="empty">暂无数据 —— 发起请求或执行全量测速后生成</div></div>
    <div id="race-test-report" style="margin-top:10px"></div>
  </div>
</section>

<!-- ===== 用量 ===== -->
<section class="view" id="v-usage">
  <div class="grid g4" id="usage-totals"></div>
  <div class="card" style="margin-top:14px">
    <div class="row" style="justify-content:space-between;margin-bottom:10px">
      <h3 style="margin:0">按客户端 Key 统计（KV 持久化，重启/冷启动不丢）</h3>
      <button class="btn danger sm" id="usage-reset">清空统计</button>
    </div>
    <div class="scroll" id="usage-tbl"><div class="empty">暂无数据</div></div>
  </div>
</section>

<!-- ===== 模型 ===== -->
<section class="view" id="v-models">
  <div class="card">
    <h3>Chat 模型（OpenAI / Anthropic / Gemini 三入口可用）</h3>
    <div class="model-grid" id="md-chat"></div>
  </div>
  <div class="card" style="margin-top:14px">
    <h3>仅 Gemini 原生透传（:predict 等）</h3>
    <div class="model-grid" id="md-native"></div>
  </div>
</section>

<!-- ===== 日志 ===== -->
<section class="view" id="v-logs">
  <div class="card">
    <div class="row" style="justify-content:space-between;margin-bottom:10px">
      <h3 style="margin:0">最近请求（内存环形缓冲 64 条，冷启动清空；持久统计见「用量」页）</h3>
      <div class="row">
        <button class="btn ghost sm" id="logs-refresh">刷新</button>
        <button class="btn danger sm" id="logs-clear">清空</button>
      </div>
    </div>
    <div class="scroll" id="logs-tbl"><div class="empty">暂无数据</div></div>
  </div>
</section>

</main></div>
<div id="toasts"></div>
`;

const PANEL_JS = `
var TOKEN = localStorage.getItem("vproxy_token") || "";
var CFG = null;   // /admin/config 缓存
var PX = [];      // 代理工作副本
var ALIASES = {}; // 别名工作副本

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmtN(n){ return (n || 0).toLocaleString("en-US"); }
function fmtT(iso){ return iso ? String(iso).replace("T"," ").slice(5,19) : "-"; }

function toast(msg, type, ms){
  var d = document.createElement("div");
  d.className = "toast " + (type || "");
  d.textContent = msg;
  $("toasts").appendChild(d);
  setTimeout(function(){
    d.style.transition = "opacity .3s"; d.style.opacity = "0";
    setTimeout(function(){ d.remove(); }, 320);
  }, ms || 3200);
}

function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({ "authorization": "Bearer " + TOKEN }, opts.headers || {});
  if (opts.body && !opts.headers["content-type"]) opts.headers["content-type"] = "application/json";
  return fetch("/admin" + path, opts).then(function(r){
    if (r.status === 401){ showLogin(true); throw new Error("NEED_LOGIN"); }
    return r.json().then(function(j){
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      return j;
    });
  });
}

// ===== 登录 =====
function showLogin(fail){
  $("login").classList.add("on");
  $("login-state").textContent = "未登录";
  if (fail) $("login-err").textContent = "token 无效或网络错误，请重试";
}
function hideLogin(){
  $("login").classList.remove("on");
  $("login-state").textContent = "已登录";
  $("login-err").textContent = "";
}
function tryLogin(t){
  TOKEN = t;
  return api("/config").then(function(j){
    localStorage.setItem("vproxy_token", TOKEN);
    hideLogin();
    boot();
    return j;
  }).catch(function(e){
    showLogin(true);
    throw e;
  });
}
$("login-btn").onclick = function(){ $("login-err").textContent = ""; tryLogin($("login-token").value).catch(function(){}); };
$("login-token").addEventListener("keydown", function(e){ if (e.key === "Enter") $("login-btn").click(); });
$("logout-btn").onclick = function(){
  localStorage.removeItem("vproxy_token");
  TOKEN = ""; CFG = null;
  showLogin(false);
};

// ===== 页签 =====
var LOADERS = {};
function switchTab(name){
  var tabs = document.querySelectorAll(".tab");
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("on", tabs[i].getAttribute("data-v") === name);
  var views = document.querySelectorAll(".view");
  for (var j = 0; j < views.length; j++) views[j].classList.toggle("on", views[j].id === "v-" + name);
  if (LOADERS[name]) LOADERS[name]();
}
$("tabs").addEventListener("click", function(e){
  var t = e.target.closest(".tab");
  if (t) switchTab(t.getAttribute("data-v"));
});

// ===== 仪表盘 =====
function statCard(num, sub, cls){
  return '<div class="card stat ' + (cls || "") + '"><div class="num">' + num + '</div><div class="sub">' + sub + '</div></div>';
}
LOADERS.dash = function(){
  Promise.all([api("/usage"), api("/logs"), api("/config")]).then(function(rs){
    var totals = rs[0].totals || {};
    var logs = rs[1].logs || [];
    var cfg = rs[2];
    $("dash-stats").innerHTML =
      statCard(fmtN(totals.requests), "总请求数", "c-accent") +
      statCard(fmtN(totals.input_tokens), "输入 tokens", "") +
      statCard(fmtN(totals.output_tokens), "输出 tokens", "c-purple") +
      statCard(fmtN(totals.keys), "客户端 Key", "") +
      statCard(fmtN((cfg.proxies || []).length), "出站代理", "c-warn") +
      statCard(cfg.gemini_key ? "已配置" : "未配置", "上游 Gemini Key", cfg.gemini_key ? "c-ok" : "c-warn");
    var tm = totals.top_models || [];
    if (tm.length){
      var max = tm[0].requests || 1;
      $("dash-models").innerHTML = tm.map(function(m){
        return '<div style="margin-bottom:10px"><div class="row" style="justify-content:space-between;font-size:12.5px"><code>' + esc(m.model) + '</code><span class="num" style="color:var(--muted)">' + fmtN(m.requests) + '</span></div><div class="bar"><i style="width:' + Math.round((m.requests / max) * 100) + '%"></i></div></div>';
      }).join("");
    }
    var recent = logs.slice(0, 8);
    if (recent.length){
      $("dash-logs").innerHTML = '<table class="tbl"><tbody>' + recent.map(function(l){
        var st = l.status < 400 ? "ok" : "err";
        return '<tr><td style="white-space:nowrap;color:var(--dim)">' + esc(fmtT(l.at)) + '</td><td><span class="tag ' + st + '">' + l.status + '</span></td><td>' + esc(l.protocol) + '</td><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(l.path) + '">' + esc(l.path) + '</td><td class="num" style="color:var(--muted);white-space:nowrap">' + l.ms + 'ms</td></tr>';
      }).join("") + '</tbody></table>';
    }
    $("dash-info").innerHTML = '<table class="tbl"><tbody>' + [
      ["OpenAI 协议", "POST /v1/chat/completions · GET /v1/models"],
      ["Anthropic 协议", "POST /v1/messages · POST /v1/messages/count_tokens"],
      ["Gemini 原生", "POST /v1beta/models/{model}:{generateContent|streamGenerateContent|countTokens|predict}"],
      ["出站代理", "socks4/4a · socks5 · http CONNECT（https 代理不支持，自动剔除）"],
      ["出站模式", "对冲竞速 / 健康轮换（面板「竞速」页可配）"],
      ["上游模式", "Gemini 官方 API 单 Key 直连（official）"]
    ].map(function(r){ return '<tr><td style="white-space:nowrap;color:var(--muted);width:120px">' + r[0] + '</td><td><code>' + r[1] + '</code></td></tr>'; }).join("") + '</tbody></table>';
  }).catch(function(e){ if (e.message !== "NEED_LOGIN") toast("加载失败：" + e.message, "err"); });
};

// ===== 配置页 =====
function renderKeys(){
  var keys = (CFG && CFG.api_keys) || [];
  $("cfg-keys").innerHTML = keys.length
    ? keys.map(function(k, i){ return '<span class="chip">' + esc(k) + '<span class="x" title="删除" onclick="rmKey(' + i + ')">×</span></span>'; }).join("")
    : '<span style="color:var(--dim);font-size:12.5px">未配置 —— 服务将拒绝所有业务请求</span>';
}
window.rmKey = function(i){ CFG.api_keys.splice(i, 1); renderKeys(); };
function renderAliases(){
  var ks = Object.keys(ALIASES);
  $("cfg-alias-rows").innerHTML = ks.length
    ? ks.map(function(k){
        return '<div class="row" style="margin-bottom:6px"><code style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:4px 10px">' + esc(k) + '</code><span style="color:var(--dim)">→</span><code style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:4px 10px">' + esc(ALIASES[k]) + '</code><button class="btn danger sm" onclick="rmAlias(\\'' + esc(k).replace(/'/g, "\\'") + '\\')">删除</button></div>';
      }).join("")
    : '<span style="color:var(--dim);font-size:12.5px">无别名</span>';
}
window.rmAlias = function(k){ delete ALIASES[k]; renderAliases(); };
function renderDisabled(){
  var ds = (CFG && CFG.disabled_models) || [];
  $("cfg-disabled").innerHTML = ds.length
    ? ds.map(function(m, i){ return '<span class="chip" style="border-color:rgba(248,113,113,.35)">' + esc(m) + '<span class="x" onclick="rmDisabled(' + i + ')">×</span></span>'; }).join("")
    : '<span style="color:var(--dim);font-size:12.5px">无禁用模型</span>';
}
window.rmDisabled = function(i){ CFG.disabled_models.splice(i, 1); renderDisabled(); };

LOADERS.cfg = function(){
  api("/config").then(function(j){
    CFG = j; delete CFG._hint;
    PX = (j.proxies || []).slice();
    ALIASES = Object.assign({}, j.model_aliases || {});
    $("cfg-gemini").value = j.gemini_key || "";
    $("cfg-sub").value = j.subscription || "";
    $("cfg-sub-min").value = j.subscription_refresh_minutes || 30;
    renderKeys(); renderAliases(); renderDisabled();
  }).catch(function(e){ if (e.message !== "NEED_LOGIN") toast("加载失败：" + e.message, "err"); });
};

$("cfg-key-add").onclick = function(){
  var v = $("cfg-key-in").value.trim();
  if (!v) return;
  if (CFG.api_keys.indexOf(v) >= 0){ toast("该 Key 已存在", "warn"); return; }
  CFG.api_keys.push(v);
  $("cfg-key-in").value = "";
  renderKeys();
};
$("cfg-key-in").addEventListener("keydown", function(e){ if (e.key === "Enter") $("cfg-key-add").click(); });
$("cfg-alias-add").onclick = function(){
  var k = $("cfg-alias-k").value.trim(), v = $("cfg-alias-v").value.trim();
  if (!k || !v){ toast("别名与目标模型都要填写", "warn"); return; }
  ALIASES[k] = v;
  $("cfg-alias-k").value = ""; $("cfg-alias-v").value = "";
  renderAliases();
};
$("cfg-disabled-add").onclick = function(){
  var v = $("cfg-disabled-in").value.trim();
  if (!v) return;
  if (CFG.disabled_models.indexOf(v) < 0) CFG.disabled_models.push(v);
  $("cfg-disabled-in").value = "";
  renderDisabled();
};
$("cfg-save").onclick = function(){
  var btn = this;
  var body = {
    gemini_key: $("cfg-gemini").value.trim(),
    api_keys: CFG.api_keys,
    subscription: $("cfg-sub").value.trim(),
    subscription_refresh_minutes: Math.max(5, parseInt($("cfg-sub-min").value, 10) || 30),
    model_aliases: ALIASES,
    disabled_models: CFG.disabled_models
  };
  btn.disabled = true; btn.textContent = "保存中...";
  api("/config", { method: "POST", body: JSON.stringify(body) }).then(function(j){
    btn.disabled = false; btn.textContent = "保存配置";
    toast("配置已保存", "ok");
    if (j.removed_proxies && j.removed_proxies.length) toast("自动剔除 " + j.removed_proxies.length + " 条不支持的代理链接（见代理页）", "warn", 5000);
    CFG = j.config; delete CFG._hint;
  }).catch(function(e){
    btn.disabled = false; btn.textContent = "保存配置";
    if (e.message !== "NEED_LOGIN") toast("保存失败：" + e.message, "err");
  });
};
$("cfg-sub-refresh").onclick = function(){
  var btn = this;
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  api("/proxies/refresh", { method: "POST" }).then(function(j){
    btn.disabled = false; btn.textContent = "立即刷新订阅";
    toast("订阅已刷新：" + j.proxies + " 个节点，剔除 " + j.skipped_unsupported + " 个不支持", "ok", 4500);
    switchTab("proxy");
  }).catch(function(e){
    btn.disabled = false; btn.textContent = "立即刷新订阅";
    if (e.message !== "NEED_LOGIN") toast(e.message, "err");
  });
};

// ===== 代理页 =====
var PX_SUPPORTED = ["socks4", "socks4a", "socks5", "socks5h", "socks", "http"];
function parsePx(line){
  var s = line.trim();
  var m = /^([a-z][a-z0-9+.-]*):\\/\\//i.exec(s);
  var scheme = m ? m[1].toLowerCase() : "socks5";
  var rest = s.replace(/^[a-z][a-z0-9+.-]*:\\/\\//i, "");
  var auth = "";
  var at = rest.lastIndexOf("@");
  if (at >= 0){ auth = rest.slice(0, at); rest = rest.slice(at + 1); }
  var hp = rest.split("/")[0];
  var host = hp;
  var port = scheme.indexOf("socks") === 0 ? 1080 : 80;
  var c = hp.split(":");
  if (c.length >= 2){ host = c[0]; port = parseInt(c[1], 10) || port; }
  var kind = "http";
  if (scheme === "socks5" || scheme === "socks5h" || scheme === "socks") kind = "socks5";
  else if (scheme.indexOf("socks4") === 0) kind = "socks4";
  return { kind: kind, host: host, port: port, hasAuth: !!auth };
}
function filterProxyLines(text){
  var lines = text.split(/[\\r\\n]+/).map(function(s){ return s.trim(); }).filter(Boolean);
  var kept = [], removed = [];
  lines.forEach(function(l){
    var m = /^([a-z][a-z0-9+.-]*):\\/\\//i.exec(l);
    var scheme = m ? m[1].toLowerCase() : "socks5";
    if (scheme === "https" || scheme === "ssl" || scheme === "tls"){
      removed.push({ raw: l, reason: "https 代理在 Workers 上不可用（无法 TLS-in-TLS）" });
      return;
    }
    if (PX_SUPPORTED.indexOf(scheme) < 0){
      removed.push({ raw: l, reason: "不支持的协议 " + scheme + "://" });
      return;
    }
    if (kept.indexOf(l) >= 0) return;
    kept.push(l);
  });
  return { kept: kept, removed: removed };
}
function renderPx(){
  if (!PX.length){
    $("px-list").innerHTML = '<div class="empty">未配置代理 —— 当前直连 generativelanguage.googleapis.com</div>';
    return;
  }
  $("px-list").innerHTML = '<table class="tbl"><thead><tr><th>协议</th><th>地址</th><th>认证</th><th style="width:160px">操作</th></tr></thead><tbody>' +
    PX.map(function(p, i){
      var e = parsePx(p);
      return '<tr><td><span class="tag ' + e.kind + '">' + e.kind + '</span></td>' +
        '<td style="font-family:var(--mono);font-size:12.5px;word-break:break-all">' + esc(e.host + ":" + e.port) + '</td>' +
        '<td>' + (e.hasAuth ? '<span class="tag warn">user:pass</span>' : '<span style="color:var(--dim)">-</span>') + '</td>' +
        '<td><button class="btn ghost sm" onclick="testPx(' + i + ',this)">测试</button> <button class="btn danger sm" onclick="rmPx(' + i + ')">删除</button></td></tr>';
    }).join("") + '</tbody></table>';
}
window.rmPx = function(i){ PX.splice(i, 1); renderPx(); };
window.testPx = function(i, btn){
  btn.disabled = true;
  var old = btn.textContent;
  btn.innerHTML = '<span class="spin"></span>';
  api("/proxy/test", { method: "POST", body: JSON.stringify({ proxy: PX[i] }) }).then(function(r){
    btn.disabled = false; btn.textContent = old;
    if (r.ok) toast("socks 连通正常，延迟 " + r.latency_ms + "ms", "ok");
    else toast("测试失败：" + (r.error || "未知错误"), "err", 5000);
  }).catch(function(e){
    btn.disabled = false; btn.textContent = old;
    if (e.message !== "NEED_LOGIN") toast(e.message, "err");
  });
};
$("px-add-btn").onclick = function(){
  var t = $("px-add-in").value;
  if (!t.trim()){ toast("请先粘贴代理链接", "warn"); return; }
  var r = filterProxyLines(t);
  var added = 0;
  r.kept.forEach(function(l){ if (PX.indexOf(l) < 0){ PX.push(l); added++; } });
  renderPx();
  $("px-add-in").value = "";
  $("px-add-report").innerHTML = r.removed.length
    ? '<div class="report"><div class="t">已自动剔除 ' + r.removed.length + ' 条不支持的链接：</div><ul>' + r.removed.map(function(x){ return '<li>' + esc(x.raw) + ' —— ' + esc(x.reason) + '</li>'; }).join("") + '</ul></div>'
    : "";
  toast(added ? "已添加 " + added + " 条代理（记得点「保存代理」）" : "没有新增（可能已存在）", added ? "ok" : "warn");
};
$("px-save").onclick = function(){
  var btn = this;
  btn.disabled = true; btn.textContent = "保存中...";
  api("/config", { method: "POST", body: JSON.stringify({ proxies: PX }) }).then(function(j){
    btn.disabled = false; btn.textContent = "保存代理";
    PX = j.config.proxies || [];
    renderPx();
    if (j.removed_proxies && j.removed_proxies.length){
      $("px-add-report").innerHTML = '<div class="report"><div class="t">保存时自动剔除 ' + j.removed_proxies.length + ' 条：</div><ul>' + j.removed_proxies.map(function(x){ return '<li>' + esc(x.raw) + ' —— ' + esc(x.reason) + '</li>'; }).join("") + '</ul></div>';
    }
    toast("代理列表已保存", "ok");
  }).catch(function(e){
    btn.disabled = false; btn.textContent = "保存代理";
    if (e.message !== "NEED_LOGIN") toast(e.message, "err");
  });
};
$("px-test-all").onclick = function(){
  var btn = this;
  if (!PX.length){ toast("没有可测试的代理", "warn"); return; }
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 测速中';
  $("px-test-report").innerHTML = '<div style="color:var(--muted);font-size:12.5px"><span class="spin"></span> 服务端并发测速中（并发 6，结果写入节点健康度）...</div>';
  api("/proxies/test-all", { method: "POST" }).then(function(j){
    btn.disabled = false; btn.textContent = "批量测试";
    var rows = j.results || [];
    $("px-test-report").innerHTML = '<div class="report" style="background:rgba(91,140,255,.05);border-color:rgba(91,140,255,.25)"><div class="t" style="color:var(--accent2)">服务端并发测速（' + j.reachable + '/' + j.total + ' 可用，已写入健康度）</div><ul>' +
      rows.map(function(x){ return '<li style="color:' + (x.ok ? "var(--ok)" : "var(--err)") + '">' + esc(x.proxy) + ' —— ' + (x.ok ? x.latency_ms + "ms" : esc(x.error || "失败")) + '</li>'; }).join("") + '</ul></div>';
    toast("批量测试完成：" + j.reachable + "/" + j.total + " 可用", "ok");
  }).catch(function(e){
    btn.disabled = false; btn.textContent = "批量测试";
    if (e.message !== "NEED_LOGIN") toast(e.message, "err");
  });
};
LOADERS.proxy = function(){
  api("/config").then(function(j){
    PX = (j.proxies || []).slice();
    renderPx();
  }).catch(function(e){ if (e.message !== "NEED_LOGIN") toast("加载失败：" + e.message, "err"); });
};

// ===== 竞速页 =====
var HEALTH = null; // /admin/health 缓存
function fmtProxyLabel(uri){
  var s = String(uri || "");
  var at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(0, s.indexOf("://") + 3) + "***@" + s.slice(at + 1);
  return s;
}
function renderRaceForm(){
  var r = (CFG && CFG.racing) || {};
  $("race-enabled").checked = !!r.enabled;
  $("race-dynamic").checked = !!r.dynamic_delay;
  $("race-topk").value = r.top_k != null ? r.top_k : 6;
  $("race-mc").value = r.max_concurrent != null ? r.max_concurrent : 3;
  $("race-delay").value = r.hedge_delay_ms != null ? r.hedge_delay_ms : 1000;
  $("race-ma").value = r.max_attempts != null ? r.max_attempts : 8;
}
function renderHealthTable(){
  var h = (HEALTH && HEALTH.health) || {};
  var entries = Object.keys(h);
  var now = Date.now();
  var coolingN = 0, stickyN = 0;
  entries.forEach(function(k){ if (h[k].cooldown_until * 1000 > now) coolingN++; if (h[k].sticky) stickyN++; });
  $("race-stats").innerHTML =
    statCard(String(entries.length), "已知节点", "c-accent") +
    statCard(HEALTH ? HEALTH.avg_latency_ms + "ms" : "-", "健康节点均延迟", "") +
    statCard(String(stickyN), "粘性优选", "c-ok") +
    statCard(String(coolingN), "冷却中", coolingN ? "c-warn" : "");
  if (!entries.length){
    $("race-tbl").innerHTML = '<div class="empty">暂无数据 —— 发起请求或执行全量测速后生成</div>';
    return;
  }
  entries.sort(function(a, b){
    var ha = h[a], hb = h[b];
    if (ha.sticky !== hb.sticky) return ha.sticky ? -1 : 1;
    return (hb.success - hb.fail) - (ha.success - ha.fail);
  });
  $("race-tbl").innerHTML = '<table class="tbl"><thead><tr><th>节点</th><th>成功</th><th>失败</th><th>连败</th><th>最近延迟</th><th>均延迟</th><th>429</th><th>状态</th></tr></thead><tbody>' +
    entries.map(function(k){
      var x = h[k];
      var cooling = x.cooldown_until * 1000 > now;
      var cdLeft = cooling ? Math.ceil((x.cooldown_until * 1000 - now) / 1000) : 0;
      var st = x.sticky && !cooling
        ? '<span class="tag ok">粘性</span>'
        : cooling
          ? '<span class="tag warn">冷却 ' + cdLeft + 's</span>'
          : '<span class="tag">正常</span>';
      return '<tr><td style="font-family:var(--mono);font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(k) + '">' + esc(fmtProxyLabel(k)) + '</td>' +
        '<td class="num" style="color:var(--ok)">' + fmtN(x.success) + '</td><td class="num" style="color:var(--err)">' + fmtN(x.fail) + '</td>' +
        '<td class="num">' + x.consec_fail + '</td><td class="num">' + (x.last_ms ? x.last_ms + "ms" : "-") + '</td><td class="num">' + (x.avg_ms ? Math.round(x.avg_ms) + "ms" : "-") + '</td>' +
        '<td class="num">' + x.rate_limit_count + '</td><td>' + st + '</td></tr>';
    }).join("") + '</tbody></table>';
}
LOADERS.race = function(){
  Promise.all([api("/health"), api("/config")]).then(function(rs){
    HEALTH = rs[0];
    CFG = rs[1]; delete CFG._hint;
    PX = (CFG.proxies || []).slice();
    renderRaceForm();
    renderHealthTable();
  }).catch(function(e){ if (e.message !== "NEED_LOGIN") toast("加载失败：" + e.message, "err"); });
};
$("race-save").onclick = function(){
  var btn = this;
  var body = { racing: {
    enabled: $("race-enabled").checked,
    dynamic_delay: $("race-dynamic").checked,
    top_k: parseInt($("race-topk").value, 10) || 6,
    max_concurrent: parseInt($("race-mc").value, 10) || 3,
    hedge_delay_ms: parseInt($("race-delay").value, 10) || 1000,
    max_attempts: parseInt($("race-ma").value, 10) || 8
  } };
  btn.disabled = true; btn.textContent = "保存中...";
  api("/config", { method: "POST", body: JSON.stringify(body) }).then(function(j){
    btn.disabled = false; btn.textContent = "保存竞速配置";
    CFG = j.config; delete CFG._hint;
    toast("竞速配置已保存", "ok");
  }).catch(function(e){
    btn.disabled = false; btn.textContent = "保存竞速配置";
    if (e.message !== "NEED_LOGIN") toast("保存失败：" + e.message, "err");
  });
};
$("race-refresh").onclick = function(){ LOADERS.race(); };
$("race-reset").onclick = function(){
  if (!confirm("确定清空所有节点健康度？胜出记忆与冷却状态将重建。")) return;
  api("/health/reset", { method: "POST" }).then(function(){ toast("健康度已重置", "ok"); LOADERS.race(); })
    .catch(function(e){ if (e.message !== "NEED_LOGIN") toast(e.message, "err"); });
};
$("race-test-all").onclick = function(){
  var btn = this;
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 测速中';
  $("race-test-report").innerHTML = '<div style="color:var(--muted);font-size:12.5px"><span class="spin"></span> 服务端并发测速中（并发 6）...</div>';
  api("/proxies/test-all", { method: "POST" }).then(function(j){
    btn.disabled = false; btn.textContent = "全量测速";
    var rows = j.results || [];
    $("race-test-report").innerHTML = '<div class="report" style="background:rgba(91,140,255,.05);border-color:rgba(91,140,255,.25)"><div class="t" style="color:var(--accent2)">测速结果（' + j.reachable + '/' + j.total + ' 可用，已写入健康度）</div><ul>' +
      rows.map(function(x){ return '<li style="color:' + (x.ok ? "var(--ok)" : "var(--err)") + '">' + esc(x.proxy) + ' —— ' + (x.ok ? x.latency_ms + "ms" : esc(x.error || "失败")) + '</li>'; }).join("") + '</ul></div>';
    toast("全量测速完成：" + j.reachable + "/" + j.total + " 可用", "ok");
    LOADERS.race();
  }).catch(function(e){
    btn.disabled = false; btn.textContent = "全量测速";
    if (e.message !== "NEED_LOGIN") toast(e.message, "err");
  });
};

// ===== 用量页 =====
LOADERS.usage = function(){
  api("/usage").then(function(j){
    var t = j.totals || {};
    var u = j.usage || {};
    $("usage-totals").innerHTML =
      statCard(fmtN(t.requests), "总请求数", "c-accent") +
      statCard(fmtN(t.input_tokens), "输入 tokens", "") +
      statCard(fmtN(t.output_tokens), "输出 tokens", "c-purple") +
      statCard(fmtN(t.keys), "客户端 Key", "");
    var entries = Object.keys(u).sort(function(a, b){ return (u[b].requests || 0) - (u[a].requests || 0); });
    if (!entries.length){ $("usage-tbl").innerHTML = '<div class="empty">暂无数据 —— 发起一次对话后刷新</div>'; return; }
    $("usage-tbl").innerHTML = '<table class="tbl"><thead><tr><th>客户端 Key</th><th>请求</th><th>输入 tok</th><th>输出 tok</th><th>首次使用</th><th>最近使用</th><th>模型分布</th></tr></thead><tbody>' +
      entries.map(function(k){
        var r = u[k];
        var models = Object.keys(r.models || {}).map(function(m){
          return '<tr><td style="padding:3px 10px;color:var(--muted)"><code>' + esc(m) + '</code></td><td class="num" style="padding:3px 10px">' + fmtN(r.models[m].requests) + '</td><td class="num" style="padding:3px 10px">' + fmtN(r.models[m].input_tokens) + '</td><td class="num" style="padding:3px 10px">' + fmtN(r.models[m].output_tokens) + '</td></tr>';
        }).join("");
        return '<tr><td style="font-family:var(--mono);font-size:12.5px;word-break:break-all">' + esc(k) + '</td>' +
          '<td class="num">' + fmtN(r.requests) + '</td><td class="num">' + fmtN(r.input_tokens) + '</td><td class="num">' + fmtN(r.output_tokens) + '</td>' +
          '<td style="color:var(--muted);font-size:12px;white-space:nowrap">' + esc(fmtT(r.first_used)) + '</td>' +
          '<td style="color:var(--muted);font-size:12px;white-space:nowrap">' + esc(fmtT(r.last_used)) + '</td>' +
          '<td><details class="sub"><summary>' + Object.keys(r.models || {}).length + ' 个模型</summary><table class="tbl" style="margin-top:6px">' + models + '</table></details></td></tr>';
      }).join("") + '</tbody></table>';
  }).catch(function(e){ if (e.message !== "NEED_LOGIN") toast("加载失败：" + e.message, "err"); });
};
$("usage-reset").onclick = function(){
  if (!confirm("确定清空所有用量统计？此操作不可恢复。")) return;
  api("/usage/reset", { method: "POST" }).then(function(){ toast("统计已清空", "ok"); LOADERS.usage(); })
    .catch(function(e){ if (e.message !== "NEED_LOGIN") toast(e.message, "err"); });
};

// ===== 模型页 =====
LOADERS.models = function(){
  api("/models").then(function(j){
    var aliases = j.aliases || {};
    var dis = j.disabled || [];
    var reverse = {};
    Object.keys(aliases).forEach(function(k){ (reverse[aliases[k]] = reverse[aliases[k]] || []).push(k); });
    function item(m){
      var tags = "";
      (reverse[m] || []).forEach(function(k){ tags += ' <span class="tag ok">' + esc(k) + ' →</span>'; });
      if (aliases[m]) tags += ' <span class="tag warn">→ ' + esc(aliases[m]) + '</span>';
      if (dis.indexOf(m) >= 0) tags += ' <span class="tag err">已禁用</span>';
      return '<div class="model-item"><span>' + esc(m) + '</span><span style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">' + tags + '</span></div>';
    }
    $("md-chat").innerHTML = j.chat_models.map(item).join("");
    $("md-native").innerHTML = j.native_only_models.map(item).join("");
  }).catch(function(e){ if (e.message !== "NEED_LOGIN") toast("加载失败：" + e.message, "err"); });
};

// ===== 日志页 =====
function renderLogsTable(logs){
  if (!logs.length){ $("logs-tbl").innerHTML = '<div class="empty">暂无请求</div>'; return; }
  $("logs-tbl").innerHTML = '<table class="tbl"><thead><tr><th>时间</th><th>协议</th><th>方法</th><th>路径</th><th>状态</th><th>耗时</th><th>出口</th><th>Key</th></tr></thead><tbody>' +
    logs.map(function(l){
      var st = l.status < 400 ? "ok" : "err";
      return '<tr><td style="white-space:nowrap;color:var(--dim)">' + esc(fmtT(l.at)) + '</td>' +
        '<td>' + esc(l.protocol) + '</td><td>' + esc(l.method) + '</td>' +
        '<td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:12px" title="' + esc(l.path) + '">' + esc(l.path) + '</td>' +
        '<td><span class="tag ' + st + '">' + l.status + '</span></td>' +
        '<td class="num" style="color:var(--muted)">' + l.ms + 'ms</td>' +
        '<td style="font-family:var(--mono);font-size:11.5px;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(l.via) + '">' + esc(l.via) + '</td>' +
        '<td style="font-family:var(--mono);font-size:11.5px;color:var(--muted)">' + esc(l.key) + '</td></tr>';
    }).join("") + '</tbody></table>';
}
LOADERS.logs = function(){
  api("/logs").then(function(j){ renderLogsTable(j.logs || []); })
    .catch(function(e){ if (e.message !== "NEED_LOGIN") toast("加载失败：" + e.message, "err"); });
};
$("logs-refresh").onclick = function(){ LOADERS.logs(); };
$("logs-clear").onclick = function(){
  api("/logs/clear", { method: "POST" }).then(function(){ toast("日志已清空", "ok"); LOADERS.logs(); })
    .catch(function(e){ if (e.message !== "NEED_LOGIN") toast(e.message, "err"); });
};

// ===== 启动 =====
function boot(){
  fetch("/healthz").then(function(r){ return r.ok; }).catch(function(){ return false; }).then(function(ok){
    $("health-dot").style.background = ok ? "var(--ok)" : "var(--err)";
    $("health-dot").style.boxShadow = ok ? "0 0 10px var(--ok)" : "0 0 10px var(--err)";
  });
  fetch("/").then(function(r){ return r.json(); }).then(function(j){
    if (j.version) $("ver-badge").textContent = "v" + j.version;
  }).catch(function(){});
  switchTab("dash");
}
if (TOKEN) tryLogin(TOKEN).catch(function(){});
else showLogin(false);
`;

/** 拼装完整面板 HTML 页面 */
export function renderPanelHtml(): string {
  return (
    '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>cf-vproxy 管理面板</title>\n<style>" +
    PANEL_CSS +
    "</style>\n</head>\n<body>\n" +
    PANEL_HTML +
    "\n<script>\n" +
    PANEL_JS +
    "</script>\n</body>\n</html>"
  );
}



