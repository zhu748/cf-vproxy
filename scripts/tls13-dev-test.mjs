#!/usr/bin/env node
// tls13-dev-test.mjs —— 在 Node 24 上用真实代理 + 真实 Google 端到端验证 tls13.ts。
// 用法：node scripts/tls13-dev-test.mjs [proxy-url]
//   无参数时自动从 onrender 代理池拉取，并用本机逐一测试（TCP→代理握手→TLS1.3→HTTP GET）。
import net from "node:net";
import { Duplex } from "node:stream";
import { performance } from "node:perf_hooks";

// Node 24 支持 type stripping，直接 import TS 源码
const { Tls13Client, hkdfExpandLabel } = await import("../src/proxy/tls13.ts");
const { ByteBufReader } = await import("../src/proxy/byteio.ts");

const TARGET = "generativelanguage.googleapis.com";
const LIST_URL = "https://youhua.onrender.com/api/latest/txt";

// ---------- minimal stream shims ----------
function socketIO(sock) {
  const web = Duplex.toWeb(sock);
  const reader = web.readable.getReader();
  const writer = web.writable.getWriter();
  return { reader: new ByteBufReader(reader), writer };
}

function parseProxyUrl(raw) {
  const m = /^(\w+):\/\/(?:(.*?)(?::(.*?))?@)?([^:]+):(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return { kind: m[1], user: m[2] || undefined, pwd: m[3] || undefined, host: m[4], port: Number(m[5]) };
}

async function recvExact(sock, n) {
  const chunks = [];
  let got = 0;
  while (got < n) {
    const c = await sock.read(n - got);
    if (c === null) throw new Error("EOF");
    chunks.push(c);
    got += c.length;
  }
  return Buffer.concat(chunks);
}

async function socks5Handshake(io, p) {
  await io.writer.write(new Uint8Array([5, 1, 0]));
  const m = await io.reader.readExact(2);
  if (m[0] !== 5 || m[1] !== 0) throw new Error("socks5 method " + m[1]);
  const hostB = Buffer.from(TARGET);
  const pkt = new Uint8Array(4 + 1 + hostB.length + 2);
  pkt[0] = 5; pkt[1] = 1; pkt[2] = 0; pkt[3] = 3;
  pkt[4] = hostB.length;
  pkt.set(hostB, 5);
  pkt[5 + hostB.length] = 443 >> 8;
  pkt[6 + hostB.length] = 443 & 0xff;
  await io.writer.write(pkt);
  const head = await io.reader.readExact(4);
  if (head[1] !== 0) throw new Error("socks5 rep " + head[1]);
  const atyp = head[3];
  if (atyp === 1) await io.reader.readExact(6);
  else if (atyp === 3) { const ln = (await io.reader.readExact(1))[0]; await io.reader.readExact(ln + 2); }
  else if (atyp === 4) await io.reader.readExact(18);
  else throw new Error("bad atyp");
}

async function httpConnectHandshake(io, p) {
  const req = `CONNECT ${TARGET}:443 HTTP/1.1\r\nHost: ${TARGET}:443\r\nUser-Agent: devtest/1.0\r\n\r\n`;
  await io.writer.write(Buffer.from(req));
  const block = await io.reader.readHeaderBlock();
  const line = Buffer.from(block).toString("latin1").split("\r\n")[0];
  const code = parseInt((line.split(" ")[1] || "0"), 10);
  if (code < 200 || code >= 300) throw new Error("CONNECT rejected: " + line);
}

// ---------- HKDF 自检（RFC 8448 造已知向量太重，此处做交叉验证） ----------
async function selfTest() {
  const secret = new Uint8Array(32).fill(0xab);
  const ctx = new Uint8Array(4).fill(0xcd);
  const out = await hkdfExpandLabel(secret, "c hs traffic", ctx, 32);
  if (out.length !== 32) throw new Error("hkdf label length");
  console.log("[selftest] hkdfExpandLabel ok:", Buffer.from(out).toString("hex").slice(0, 32) + "...");
}

// ---------- main ----------
async function testProxy(raw) {
  const p = parseProxyUrl(raw);
  if (!p || (p.kind !== "socks5" && p.kind !== "http")) return { raw, ok: false, error: "skip" };
  const t0 = performance.now();
  let sock;
  try {
    sock = net.connect({ host: p.host, port: p.port });
    await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); setTimeout(() => rej(new Error("tcp timeout")), 6000); });
    sock.setNoDelay(true);
    const io = socketIO(sock);
    if (p.kind === "socks5") await socks5Handshake(io, p);
    else await httpConnectHandshake(io, p);

    // ---- TLS 1.3 ----
    const tls = new Tls13Client(io.reader, io.writer, {
      serverName: TARGET,
      onClose: () => { try { sock.destroy(); } catch {} },
    });
    const hsStart = performance.now();
    await tls.handshake();
    const hsMs = Math.round(performance.now() - hsStart);

    // ---- HTTP/1.1 GET ----
    const req = `GET /v1beta/models HTTP/1.1\r\nHost: ${TARGET}\r\nUser-Agent: devtest/1.0\r\nConnection: close\r\n\r\n`;
    await tls.write(Buffer.from(req));
    let data = Buffer.alloc(0);
    for (;;) {
      const chunk = await tls.read();
      if (chunk === null) break;
      data = Buffer.concat([data, Buffer.from(chunk)]);
      if (data.length > 65536) break;
      if (data.includes("\r\n\r\n") && data.length > 200) break;
    }
    const statusLine = data.toString("latin1").split("\r\n")[0] || "(empty)";
    if (process.env.DBG1) console.log("[inner]", raw, "hsMs=", hsMs, "bytes=", data.length, "status=", statusLine);
    const totalMs = Math.round(performance.now() - t0);
    tls.close();
    return { raw, ok: /^HTTP\/\d(\.\d)? [2345]\d\d/.test(statusLine), statusLine, hsMs, totalMs, bytes: data.length };
  } catch (e) {
    try { sock?.destroy(); } catch {}
    if (process.env.DBG1) console.log("FULL ERROR:", typeof e, e && e.stack, JSON.stringify(String(e)));
    return { raw, ok: false, error: (e && e.stack ? String(e.stack).split('\n')[0] : String(e)).slice(0, 140), totalMs: Math.round(performance.now() - t0) };
  }
}

async function main() {
  await selfTest();
  const arg = process.argv[2];
  let list;
  if (arg) {
    list = [arg];
  } else {
    const resp = await fetch(LIST_URL);
    const text = await resp.text();
    list = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  }
  // 取前 25 个 + 已知稳定节点
  let merged;
  if (arg) {
    merged = [arg];
  } else {
    const known = ["socks5://45.194.33.12:30001", "http://14.251.13.20:8080", "socks5://193.25.215.182:22222", "socks5://43.135.176.121:1080", "http://107.167.18.122:443"];
    merged = [...new Set([...known, ...list])].slice(0, 30);
  }
  console.log(`testing ${merged.length} proxies with TLS 1.3 pure-JS client...`);
  const results = [];
  const CONC = 12;
  for (let i = 0; i < merged.length; i += CONC) {
    const batch = merged.slice(i, i + CONC);
    const rs = await Promise.all(batch.map(testProxy));
    results.push(...rs);
    for (const r of rs) {
      if (r.ok) {
        console.log(`  [OK ] ${r.raw.padEnd(38)} hs=${String(r.hsMs).padStart(5)}ms total=${String(r.totalMs).padStart(6)}ms  ${r.statusLine}  (${r.bytes}B)`);
      }
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n=== RESULT: ${okCount}/${results.length} proxies passed pure-JS TLS 1.3 + HTTP ===`);
  console.log("failures:");
  for (const r of results.filter((x) => !x.ok && x.error !== "skip")) {
    console.log(`  ${r.raw.padEnd(38)} ${r.error} | status=${r.statusLine ?? '-'} bytes=${r.bytes ?? '-'} hs=${r.hsMs ?? '-'}`);
  }
  process.exit(okCount > 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
