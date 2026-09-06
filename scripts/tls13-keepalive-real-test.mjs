#!/usr/bin/env node
// tls13-keepalive-real-test.mjs —— v2.2 连接复用：真实代理 + 真实 Google 端到端验证。
// 走与生产一致的代码路径（tunnel.ts 代理握手 / httpclient.ts HTTP 客户端 / connpool.ts 连接池），
// 仅用 node:net 替代 cloudflare:sockets。
// 每个代理：冷请求（TCP+代理握手+TLS 握手+HTTP）→ 归还池 → 暖请求（仅 HTTP）→ 对比延迟。
import net from "node:net";
import { Duplex } from "node:stream";
import { performance } from "node:perf_hooks";

const { Tls13Client } = await import("../src/proxy/tls13.ts");
const { ByteBufReader } = await import("../src/proxy/byteio.ts");
const { ConnPool } = await import("../src/proxy/connpool.ts");
const { writeTunnelRequest, parseResponseHeadBlock, determineBodyShape, makeBodyStream, isBodylessStatus, responseAllowsReuse } = await import("../src/proxy/httpclient.ts");
const { socks5Handshake, httpConnectHandshake } = await import("../src/proxy/tunnel.ts");

const TARGET = "generativelanguage.googleapis.com";
const LIST_URL = "https://youhua.onrender.com/api/latest/txt";

function parseProxyUrl(raw) {
  const m = /^(\w+):\/\/(?:(.*?)(?::(.*?))?@)?([^:]+):(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return { kind: m[1], username: m[2] || undefined, password: m[3] || undefined, host: m[4], port: Number(m[5]), raw: raw.trim() };
}

const pool = new ConnPool();

async function establish(proxyRaw) {
  const p = parseProxyUrl(proxyRaw);
  const sock = net.connect({ host: p.host, port: p.port });
  await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); setTimeout(() => rej(new Error("tcp timeout")), 8000); });
  sock.setNoDelay(true);
  const web = Duplex.toWeb(sock);
  const io = { readable: web.readable, writable: web.writable };
  const hs = p.kind === "socks5" ? await socks5Handshake(io, p, TARGET, 443) : await httpConnectHandshake(io, p, TARGET, 443);
  const tls = new Tls13Client(hs.reader, hs.writer, { serverName: TARGET, onClose: () => { try { sock.destroy(); } catch {} } });
  const t = performance.now();
  await tls.handshake();
  const tlsMs = Math.round(performance.now() - t);
  const now = Date.now();
  const conn = {
    proxyRaw, target: TARGET + ":443", tls,
    reader: new ByteBufReader({
      read: () => tls.read().then((v) => (v === null ? { done: true, value: undefined } : { done: false, value: v })),
      releaseLock: () => {},
    }),
    writer: { write: (c) => tls.write(c) },
    created: now, lastUsed: now, uses: 0,
  };
  return [conn, tlsMs];
}

async function request(conn, path) {
  await writeTunnelRequest(conn.writer, { method: "GET", url: "https://" + TARGET + path, headers: { "User-Agent": "keepalive-test/2.2" }, body: new Uint8Array(0) });
  const headBlock = await conn.reader.readHeaderBlock();
  const head = parseResponseHeadBlock(headBlock);
  const shape = isBodylessStatus("GET", head.status) ? { chunked: false, contentLength: 0 } : determineBodyShape(head.headers);
  const allowsReuse = responseAllowsReuse(head) && (shape.chunked || shape.contentLength !== null);
  const t = performance.now();
  const text = await new Response(makeBodyStream(conn.reader, shape, (r) => pool.release(conn, r && allowsReuse))).text();
  return { status: head.status, connHeader: head.headers["connection"] ?? "(none)", ms: Math.round(performance.now() - t), bytes: text.length };
}

async function testProxy(proxyRaw) {
  let conn, tlsMs;
  const t0 = performance.now();
  try {
    [conn, tlsMs] = await establish(proxyRaw);
  } catch (e) {
    return { proxyRaw, ok: false, error: String(e.message || e).slice(0, 80) };
  }
  const setupMs = Math.round(performance.now() - t0);
  try {
    const r1 = await request(conn, "/v1beta/models?pageSize=1");
    const coldTotal = setupMs + r1.ms;
    const warmConn = pool.acquire(proxyRaw, TARGET + ":443");
    if (!warmConn) {
      return { proxyRaw, ok: false, error: "未回池（响应 conn=" + r1.connHeader + "）", r1 };
    }
    const tw = performance.now();
    const r2 = await request(warmConn, "/v1beta/models?pageSize=1");
    const warmTotal = Math.round(performance.now() - tw);
    // 第三次请求再验证一次稳定性
    const warmConn2 = pool.acquire(proxyRaw, TARGET + ":443");
    const r3 = warmConn2 ? await request(warmConn2, "/v1beta/models?pageSize=1") : null;
    return { proxyRaw, ok: true, r1, r2, r3, setupMs, tlsMs, coldTotal, warmTotal, saved: coldTotal - warmTotal, connHeader: r1.connHeader };
  } catch (e) {
    return { proxyRaw, ok: false, error: String(e.message || e).slice(0, 100) };
  }
}

async function main() {
  const arg = process.argv[2];
  let merged;
  if (arg) {
    merged = [arg];
  } else {
    let list = [];
    try {
      const resp = await fetch(LIST_URL, { signal: AbortSignal.timeout(10_000) });
      list = (await resp.text()).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    } catch {}
    const known = ["socks5://45.194.33.12:30001", "http://14.251.13.20:8080", "socks5://193.25.215.182:22222", "http://107.167.18.122:443"];
    merged = [...new Set([...known, ...list])].slice(0, 14);
  }
  console.log(`[keepalive-real] 测试 ${merged.length} 个代理：冷请求 → 归还池 → 暖请求 → 暖请求\n`);
  const results = [];
  const CONC = 8;
  for (let i = 0; i < merged.length; i += CONC) {
    const rs = await Promise.all(merged.slice(i, i + CONC).map(testProxy));
    results.push(...rs);
    for (const r of rs) {
      if (r.ok) {
        console.log(`  [OK] ${r.proxyRaw.padEnd(36)} 冷=${String(r.coldTotal).padStart(5)}ms(握手${String(r.setupMs).padStart(4)}/TLS${String(r.tlsMs).padStart(4)}) 暖=${String(r.warmTotal).padStart(5)}ms 省=${String(r.saved).padStart(5)}ms | ${r.r1.status}/${r.r2.status}${r.r3 ? "/" + r.r3.status : ""} conn=${r.connHeader}`);
      } else {
        console.log(`  [--] ${r.proxyRaw.padEnd(36)} ${r.error}`);
      }
    }
  }
  const ok = results.filter((r) => r.ok);
  const avgSave = ok.length ? Math.round(ok.reduce((s, r) => s + r.saved, 0) / ok.length) : 0;
  console.log(`\n=== ${ok.length}/${results.length} 代理复用成功；平均节省 ${avgSave}ms/请求（暖连接跳过 TCP+代理握手+TLS） ===`);
  process.exit(ok.length > 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
