#!/usr/bin/env node
// cf-vproxy-relay — cf-vproxy 的 Node 出口中转（零依赖，单文件）
//
// 为什么需要它：Cloudflare Workers runtime 的 startTls() 无法在代理隧道上完成 TLS
// 升级（平台级限制，与代理质量无关），导致「经代理访问 Google」在 Workers 上不可行；
// 而 Google 对 Cloudflare/数据中心出口 IP 段做了地区封锁 + 配额压制（直连也不稳）。
// Node 的 tls.connect() 可以在任意 net.Socket 之上做 TLS —— 本中转把代理池搬回 Node：
//
//   客户端 → cf-vproxy(Workers, 协议转换/面板) → 本中转(Node, 代理出口) → Google
//
// 用法（cf-vproxy 面板把 gemini_base_url 指向本服务，例如
//   https://your-relay.onrender.com/v1beta ）：
//
// 环境变量：
//   PORT               监听端口（Render 等平台自动注入；默认 8787）
//   ALLOWED_API_KEY    必填：允许的 Gemini API Key（中转只转发携带此 key 的请求；
//                      直接填你配置在 cf-vproxy 里的那把 key）
//   SUBSCRIPTION_URL   代理订阅（type://host:port 纯文本/裸 base64，同 cf-vproxy 格式）
//   STATIC_PROXIES     逗号分隔的静态代理列表（与订阅合并）
//   TARGET_HOST        上游主机（默认 generativelanguage.googleapis.com）
//   REFRESH_MINUTES    订阅刷新间隔（默认 30）
//   DIRECT_FALLBACK    代理全失败时是否允许直连兜底（默认 true；数据中心 IP 会被
//                      Google 地区封锁，建议保持 true 仅作最后保命）
//
// 部署：任何支持 Node 18+ 的平台 —— Render(Web Service, Native Node, start: node index.js)
// / Railway / fly.io / VPS(pm2)。零 npm 依赖，无需 package 安装步骤。
"use strict";

const http = require("http");
const net = require("net");
const tls = require("tls");
const https = require("https");

const PORT = parseInt(process.env.PORT || "8787", 10);
const TARGET_HOST = process.env.TARGET_HOST || "generativelanguage.googleapis.com";
const ALLOWED_API_KEY = process.env.ALLOWED_API_KEY || "";
const SUBSCRIPTION_URL = process.env.SUBSCRIPTION_URL || "";
const STATIC_PROXIES = (process.env.STATIC_PROXIES || "").split(",").map((s) => s.trim()).filter(Boolean);
const REFRESH_MINUTES = Math.max(5, parseInt(process.env.REFRESH_MINUTES || "30", 10));
const DIRECT_FALLBACK = (process.env.DIRECT_FALLBACK || "true").toLowerCase() !== "false";
const MAX_PROXIES = 200;

if (!ALLOWED_API_KEY) {
  console.error("[relay] FATAL: ALLOWED_API_KEY 环境变量未设置（应填 cf-vproxy 所用的 Gemini Key）");
}

// ==================== 代理池 ====================

/** 解析一行代理 URL → {kind, host, port, username, password, raw}；不支持的返回 null */
function parseProxyUrl(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "socks5://" + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(":", "").toLowerCase();
  let kind = null;
  if (scheme === "socks5" || scheme === "socks5h" || scheme === "socks") kind = "socks5";
  else if (scheme === "socks4" || scheme === "socks4a") kind = "socks4";
  else if (scheme === "http") kind = "http";
  if (!kind) return null;
  const host = u.hostname;
  const port = u.port ? parseInt(u.port, 10) : kind === "http" ? 80 : 1080;
  if (!host || !(port > 0 && port < 65536)) return null;
  return {
    kind, host, port,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    raw: s,
  };
}

/** 解析订阅文本（纯文本 / 整段 base64），同 cf-vproxy 的 decodeSubscription 语义 */
function parseSubscriptionText(text) {
  let content = String(text || "").trim();
  if (!content.includes("://")) {
    try {
      const bin = Buffer.from(content.replace(/\s+/g, ""), "base64").toString("utf8");
      if (bin.includes("://")) content = bin;
    } catch {}
  }
  return content
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map(parseProxyUrl)
    .filter(Boolean);
}

function fetchText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "GET", timeout: timeoutMs },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error("subscription HTTP " + res.statusCode));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("timeout", () => req.destroy(new Error("subscription fetch timeout")));
    req.on("error", (e) => reject(e));
    req.end();
  });
}

const pool = {
  proxies: [],
  async refresh() {
    const list = STATIC_PROXIES.map(parseProxyUrl).filter(Boolean);
    if (SUBSCRIPTION_URL) {
      try {
        const resp = await fetchText(SUBSCRIPTION_URL, 15000);
        const sub = parseSubscriptionText(resp);
        for (const p of sub) {
          if (list.length >= MAX_PROXIES) break;
          list.push(p);
        }
      } catch (e) {
        console.warn("[relay] subscription fetch failed:", e.message);
      }
    }
    const seen = new Set();
    this.proxies = list.filter((p) => {
      const k = p.kind + "|" + p.host + "|" + p.port + "|" + (p.username || "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    console.log("[relay] pool refreshed, size:", this.proxies.length);
  },
};

// ==================== 代理隧道握手（HTTP CONNECT / SOCKS5 / SOCKS4a） ====================

/** 带缓冲的 socket 读取器：readExact(n) / readUntilCrlfCrlf() */
class BufReader {
  constructor(sock) {
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.listeners = []; // () => void：数据到达/关闭时被调用（由等待者自行重试匹配）
    sock.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.notify();
    });
    sock.on("close", () => {
      this.closed = true;
      this.notify();
    });
    sock.on("error", () => {
      this.closed = true;
      this.notify();
    });
  }
  notify() {
    for (const l of this.listeners.splice(0)) {
      try { l(); } catch {}
    }
  }
  waitForChange() {
    return new Promise((resolve) => this.listeners.push(resolve));
  }
  async readExact(n) {
    for (;;) {
      if (this.buf.length >= n) {
        const out = this.buf.subarray(0, n);
        this.buf = this.buf.subarray(n);
        return out;
      }
      if (this.closed) throw new Error("proxy closed connection during handshake (got " + this.buf.length + "/" + n + ")");
      await this.waitForChange();
    }
  }
  async readUntilCrlfCrlf(limit = 8192) {
    for (;;) {
      const idx = this.buf.indexOf("\r\n\r\n");
      if (idx >= 0) {
        const head = this.buf.subarray(0, idx + 4).toString("latin1");
        this.buf = this.buf.subarray(idx + 4);
        return head;
      }
      if (this.buf.length > limit) throw new Error("proxy handshake reply too large");
      if (this.closed) throw new Error("proxy closed before CONNECT reply");
      await this.waitForChange();
    }
  }
}

/** 建立经代理的 TCP 隧道（握手成功后返回裸 socket，对端即 targetHost:port） */
async function handshakeTunnel(p, targetHost, targetPort, timeoutMs = 12000) {
  const sock = net.connect({ host: p.host, port: p.port });
  sock.setNoDelay(true);
  const connectTimer = setTimeout(() => {
    sock.destroy(new Error("proxy tcp connect timeout"));
  }, timeoutMs);
  await new Promise((resolve, reject) => {
    sock.once("connect", () => {
      clearTimeout(connectTimer);
      resolve();
    });
    const onErr = (e) => {
      clearTimeout(connectTimer);
      reject(new Error("proxy tcp connect failed: " + (e && e.message ? e.message : String(e))));
    };
    sock.once("error", onErr);
  });
  const rd = new BufReader(sock);

  if (p.kind === "http") {
    let head = "CONNECT " + targetHost + ":" + targetPort + " HTTP/1.1\r\nHost: " + targetHost + ":" + targetPort + "\r\n";
    if (p.username !== undefined) {
      head += "Proxy-Authorization: Basic " + Buffer.from(p.username + ":" + (p.password || "")).toString("base64") + "\r\n";
    }
    head += "\r\n";
    sock.write(head);
    const reply = await rd.readUntilCrlfCrlf();
    if (!/^HTTP\/\d(?:\.\d)?\s+2\d\d/.test(reply.split("\r\n")[0] || "")) {
      throw new Error("http-proxy CONNECT failed: " + (reply.split("\r\n")[0] || "empty"));
    }
  } else if (p.kind === "socks5") {
    const wantAuth = p.username !== undefined;
    sock.write(Buffer.from(wantAuth ? [5, 2, 0, 2] : [5, 1, 0]));
    const m = await rd.readExact(2);
    if (m[0] !== 5) throw new Error("socks5: bad version " + m[0]);
    if (m[1] === 0xff) throw new Error("socks5: no acceptable auth method");
    if (m[1] === 2) {
      if (!wantAuth) throw new Error("socks5: proxy requires auth but none configured");
      const u = Buffer.from(p.username, "utf8");
      const pw = Buffer.from(p.password || "", "utf8");
      sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
      const a = await rd.readExact(2);
      if (a[1] !== 0) throw new Error("socks5: auth failed (status " + a[1] + ")");
    } else if (m[1] !== 0) {
      throw new Error("socks5: unsupported auth method " + m[1]);
    }
    const hb = Buffer.from(targetHost, "utf8");
    sock.write(Buffer.concat([
      Buffer.from([5, 1, 0, 3, hb.length]), hb,
      Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    ]));
    const r = await rd.readExact(4);
    if (r[1] !== 0) throw new Error("socks5: CONNECT rep=" + r[1]);
    const atyp = r[3];
    if (atyp === 1) await rd.readExact(6);
    else if (atyp === 3) {
      const l = await rd.readExact(1);
      await rd.readExact(l[0] + 2);
    } else if (atyp === 4) await rd.readExact(18);
    else throw new Error("socks5: atyp " + atyp);
  } else {
    // SOCKS4/4a（目标是域名时用 4a 扩展，由代理解析 DNS）
    const hb = Buffer.from(targetHost, "utf8");
    const isIp = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(targetHost);
    const uid = Buffer.from(p.username || "", "utf8");
    if (isIp) {
      sock.write(Buffer.concat([
        Buffer.from([4, 1, (targetPort >> 8) & 0xff, targetPort & 0xff]),
        Buffer.from([+isIp[1], +isIp[2], +isIp[3], +isIp[4]]),
        uid, Buffer.from([0]),
      ]));
    } else {
      sock.write(Buffer.concat([
        Buffer.from([4, 1, (targetPort >> 8) & 0xff, targetPort & 0xff, 0, 0, 0, 1]),
        uid, Buffer.from([0]), hb, Buffer.from([0]),
      ]));
    }
    const rep = await rd.readExact(8);
    if (rep[1] !== 0x5a) throw new Error("socks4: rep=0x" + rep[1].toString(16));
  }
  // 握手中读超的残余字节（极罕见）原样退回数据流，交给上层
  if (rd.buf.length > 0) sock.unshift(rd.buf);
  return sock;
}

// ==================== 健康度（连败指数冷却，简化版） ====================

const health = new Map(); // raw -> {fail, success, cooldownUntil, avgMs}
function cooldownSeconds(n) {
  return Math.min(30 * Math.pow(2, Math.min(n, 8) - 1), 1800);
}
function markFail(raw, reason) {
  const h = health.get(raw) || { fail: 0, success: 0, cooldownUntil: 0, avgMs: 0 };
  h.fail += 1;
  h.cooldownUntil = Date.now() + cooldownSeconds(h.fail) * 1000;
  health.set(raw, h);
  console.log("[relay] proxy fail:", raw, "—", String(reason).slice(0, 120));
}
function markSuccess(raw, ms) {
  const h = health.get(raw) || { fail: 0, success: 0, cooldownUntil: 0, avgMs: 0 };
  h.fail = 0;
  h.success += 1;
  h.avgMs = h.avgMs > 0 ? h.avgMs * 0.7 + ms * 0.3 : ms;
  h.cooldownUntil = 0;
  health.set(raw, h);
}
function pickCandidates(max = 4) {
  const now = Date.now();
  const ok = pool.proxies.filter((p) => {
    const h = health.get(p.raw);
    return !h || h.cooldownUntil <= now;
  });
  const score = (raw) => {
    const h = health.get(raw);
    if (!h) return 0; // 未测试居中
    return (h.success - h.fail * 2) * 1000 - h.avgMs;
  };
  ok.sort((a, b) => score(b.raw) - score(a.raw));
  // 已验证可用者优先，未测试的跟随其后（探索）
  return ok.slice(0, max);
}

// ==================== HTTP 服务 ====================

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 502, message: "relay upstream failure: " + e.message, status: "UNAVAILABLE" } }));
    } else {
      res.destroy();
    }
  });
});

async function handle(req, res) {
  const u = new URL(req.url, "http://relay.local");
  if (u.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pool: pool.proxies.length, at: new Date().toISOString() }));
    return;
  }
  if (!ALLOWED_API_KEY) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: 500, message: "relay misconfigured: ALLOWED_API_KEY not set" } }));
    return;
  }
  const key = req.headers["x-goog-api-key"] || u.searchParams.get("key") || "";
  if (key !== ALLOWED_API_KEY) {
    // 与 Google 的鉴权错误结构一致，cf-vproxy 无感透传
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: 401, message: "API key not valid. Please pass a valid API key.", status: "UNAUTHENTICATED" } }));
    return;
  }

  // 上游路径：cf-vproxy 的 gemini_base_url 形如 https://host/v1beta，
  // 拼接后已是完整 Google 路径 —— 原样转发
  const path = u.pathname + u.search;

  const started = Date.now();
  const candidates = pickCandidates(4);
  let lastErr = null;

  for (const p of candidates) {
    let raw = null;
    let tlsSock = null;
    try {
      raw = await handshakeTunnel(p, TARGET_HOST, 443, 12000);
      tlsSock = tls.connect({ socket: raw, servername: TARGET_HOST, rejectUnauthorized: true });
      await new Promise((resolve, reject) => {
        const onErr = (e) => reject(new Error("tls upgrade failed: " + (e && e.message ? e.message : String(e))));
        tlsSock.once("secureConnect", resolve);
        tlsSock.once("error", onErr);
      });
    } catch (e) {
      lastErr = e;
      if (tlsSock) tlsSock.destroy();
      else if (raw) raw.destroy();
      markFail(p.raw, e.message);
      continue;
    }
    markSuccess(p.raw, Date.now() - started);
    return pipeUpstream(req, res, tlsSock, path);
  }

  if (DIRECT_FALLBACK) {
    let tlsSock = null;
    try {
      tlsSock = tls.connect({ host: TARGET_HOST, port: 443, servername: TARGET_HOST, rejectUnauthorized: true });
      await new Promise((resolve, reject) => {
        tlsSock.once("secureConnect", resolve);
        tlsSock.once("error", (e) => reject(new Error("direct tls failed: " + e.message)));
      });
      console.warn("[relay] all proxies failed — falling back to DIRECT (datacenter IPs are often geo-blocked by Google)");
      return pipeUpstream(req, res, tlsSock, path);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(lastErr ? "all proxy candidates failed; last: " + lastErr.message : "no proxies configured (set SUBSCRIPTION_URL or STATIC_PROXIES)");
}

/** 在已建立的 TLS 连接上转发 HTTP 请求（支持流式 SSE） */
function pipeUpstream(req, res, tlsSock, path) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (["host", "connection", "content-length", "transfer-encoding", "keep-alive"].includes(lk)) continue;
    headers[k] = v;
  }
  headers.host = TARGET_HOST;

  const up = http.request(
    {
      createConnection: () => tlsSock,
      method: req.method,
      path,
      headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on("error", (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 502, message: "relay upstream pipe failure: " + e.message, status: "UNAVAILABLE" } }));
    } else {
      res.destroy();
    }
    tlsSock.destroy();
  });
  req.pipe(up);
  res.on("close", () => {
    if (!res.writableEnded) up.destroy();
  });
}

// ==================== 启动 ====================

pool.refresh().then(() => {
  setInterval(() => {
    pool.refresh().catch(() => {});
  }, REFRESH_MINUTES * 60 * 1000);
});

server.listen(PORT, () => {
  console.log("[relay] cf-vproxy Node relay listening on :" + PORT, "→", TARGET_HOST);
  console.log("[relay] subscription:", SUBSCRIPTION_URL || "(none)", "| static:", STATIC_PROXIES.length, "| direct-fallback:", DIRECT_FALLBACK);
});
