#!/usr/bin/env node
// tls13-keepalive-test.mjs —— v2.2 连接复用端到端闭环测试（本地 Node TLS 1.3 服务端）
// 验证链路：Tls13Client → HTTP/1.1 keep-alive 请求 → CL/chunked 精确定界 → connPool 归还 →
// 同连接二次请求（无 TLS 握手）→ 死连接冷重试自愈。
import net from "node:net";
import nodeTls from "node:tls";
import { Duplex } from "node:stream";
import { execSync } from "node:child_process";
import fs from "node:fs";

const { Tls13Client } = await import("../src/proxy/tls13.ts");
const { ByteBufReader } = await import("../src/proxy/byteio.ts");
const { ConnPool } = await import("../src/proxy/connpool.ts");
const { writeTunnelRequest, parseResponseHeadBlock, determineBodyShape, makeBodyStream, isBodylessStatus, responseAllowsReuse } = await import("../src/proxy/httpclient.ts");

// ---- 自签证书（localhost SAN）----
execSync('openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -keyout /tmp/kat13key.pem -out /tmp/kat13cert.pem -days 1 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost"', { stdio: "pipe" });
const certPem = fs.readFileSync("/tmp/kat13cert.pem", "utf8");
const keyPem = fs.readFileSync("/tmp/kat13key.pem", "utf8");
const pubPem = execSync("openssl x509 -in /tmp/kat13cert.pem -noout -pubkey").toString();
const spki = new Uint8Array(Buffer.from(pubPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"));

// ---- HTTP/1.1 keep-alive 测试服务端 ----
// /cl       → Content-Length 定界（keep-alive，可复用）
// /chunked  → chunked 定界（keep-alive，可复用）
// /close    → Connection: close（不可复用）
// /kill     → 响应头后立刻 RST（错误体 → 不可复用）
let requestCount = 0;
const server = nodeTls.createServer({
  key: keyPem,
  cert: certPem,
  minVersion: "TLSv1.3",
  maxVersion: "TLSv1.3",
  ciphers: "TLS_AES_128_GCM_SHA256",
  requestCert: false,
  handshakeTimeout: 8000,
}, (sock) => {
  let pending = Buffer.alloc(0);
  sock.on("data", (d) => {
    pending = Buffer.concat([pending, d]);
    let idx;
    while ((idx = pending.indexOf("\r\n\r\n")) >= 0) {
      const head = pending.slice(0, idx).toString("latin1");
      const clMatch = /content-length:\s*(\d+)/i.exec(head);
      const cl = clMatch ? Number(clMatch[1]) : 0;
      if (pending.length < idx + 4 + cl) return; // body 未到齐
      const reqLine = head.split("\r\n")[0];
      const path = reqLine.split(" ")[1] ?? "/";
      pending = pending.slice(idx + 4 + cl);
      requestCount++;
      if (path === "/cl") {
        const body = `reply#${requestCount}`;
        sock.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      } else if (path === "/chunked") {
        sock.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n");
        const part1 = `chunk-${requestCount}`;
        const part2 = "-tail";
        sock.write(part1.length.toString(16) + "\r\n" + part1 + "\r\n");
        sock.write(part2.length.toString(16) + "\r\n" + part2 + "\r\n");
        sock.write("0\r\n\r\n");
      } else if (path === "/close") {
        const body = "bye";
        sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        sock.end();
      } else if (path === "/kill") {
        sock.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\npartial!");
        setTimeout(() => sock.destroy(), 30); // 中途 RST：错误体 → 不可复用
      } else {
        const body = "ok";
        sock.write(`HTTP/1.1 404 Not Found\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      }
    }
  });
  sock.on("error", () => {});
});
server.on("tlsClientError", (_e, s) => s?.destroy());
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ---- 客户端侧：模拟 viaProxy 的连接建立 + sendRequestOnConn ----
const TARGET = "localhost:" + port;
const pool = new ConnPool();
const results = [];
function check(name, ok, detail = "") {
  results.push([name, ok]);
  console.log((ok ? "  ✅" : "  ❌") + " " + name + (detail ? " — " + detail : ""));
}

async function establishConn() {
  const raw = net.connect({ host: "127.0.0.1", port });
  await new Promise((r, j) => { raw.once("connect", r); raw.once("error", j); });
  const web = Duplex.toWeb(raw);
  const reader = new ByteBufReader(web.readable.getReader());
  const writer = web.writable.getWriter();
  const tls = new Tls13Client(reader, writer, { serverName: "localhost", trustAnchors: [spki], onClose: () => raw.destroy() });
  await tls.handshake();
  const now = Date.now();
  return {
    proxyRaw: "socks5://fake:1080",
    target: TARGET,
    tls,
    reader: new ByteBufReader({
      read: () => tls.read().then((v) => (v === null ? { done: true, value: undefined } : { done: false, value: v })),
      releaseLock: () => {},
    }),
    writer: { write: (c) => tls.write(c) },
    created: now, lastUsed: now, uses: 0,
  };
}

async function requestOnConn(conn, path, warm) {
  let sawBytes = false;
  try {
    await writeTunnelRequest(conn.writer, { method: "GET", url: `https://localhost:${port}${path}`, headers: {}, body: new Uint8Array(0) });
    const headBlock = await conn.reader.readHeaderBlock();
    sawBytes = true;
    const head = parseResponseHeadBlock(headBlock);
    const shape = isBodylessStatus("GET", head.status) ? { chunked: false, contentLength: 0 } : determineBodyShape(head.headers);
    const allowsReuse = responseAllowsReuse(head) && (shape.chunked || shape.contentLength !== null);
    const body = makeBodyStream(conn.reader, shape, (reusable) => {
      pool.release(conn, reusable && allowsReuse);
    });
    const text = await new Response(body).text();
    return { status: head.status, text, warm };
  } catch (e) {
    pool.discard(conn);
    throw Object.assign(e, { sawBytes });
  }
}

// 场景 1：冷连接请求 + 归还 + 暖连接二次请求（无握手）
console.log("== 场景 1：CL 定界 → 归还池 → 暖连接复用 ==");
const t1 = Date.now();
const conn1 = await establishConn();
const hsMs = Date.now() - t1;
let r1 = await requestOnConn(conn1, "/cl", false);
check("冷连接首次请求 200", r1.status === 200, `body=${r1.text}`);
check("连接已归还池（CL 精确定界）", pool.stats().idleConns === 1);
const warm = pool.acquire("socks5://fake:1080", TARGET);
check("池中取回暖连接", warm !== null && warm === conn1);
const t2 = Date.now();
r1 = await requestOnConn(warm, "/cl", true);
check("暖连接二次请求 200（跳过 TLS 握手）", r1.status === 200 && r1.text.startsWith("reply#"), `body=${r1.text}, 二次请求耗时 ${Date.now() - t2}ms（首次含握手 ${hsMs}ms）`);
check("暖连接再次归还", pool.stats().idleConns === 1 && pool.isWarm("socks5://fake:1080"));

// 场景 2：chunked 定界复用
console.log("== 场景 2：chunked 定界 → 归还池 → 复用 ==");
const conn2 = await establishConn();
let r2 = await requestOnConn(conn2, "/chunked", false);
check("chunked 首次请求 200", r2.status === 200, `body=${r2.text}`);
check("chunked 连接归还池", pool.stats().idleConns === 2);
const warm2 = pool.acquire("socks5://fake:1080", TARGET);
r2 = await requestOnConn(warm2, "/cl", true);
check("chunked 归还后复用请求 200", r2.status === 200, `body=${r2.text}`);

// 场景 3：Connection: close 不回池
console.log("== 场景 3：Connection: close 响应不回池 ==");
const conn3 = await establishConn();
const r3 = await requestOnConn(conn3, "/close", false);
check("close 响应读取成功", r3.status === 200 && r3.text === "bye");
check("close 连接不回池（池维持 2）", pool.stats().idleConns === 2, `idle=${pool.stats().idleConns}`);
check("close 后 TLS 已死", conn3.tls.isClosed || (await conn3.tls.read()) === null);

// 场景 4：体中途 RST → cleanup(false) → 连接被杀
console.log("== 场景 4：体截断（RST）→ 不回池并杀死 ==");
const conn4 = await establishConn();
try {
  await requestOnConn(conn4, "/kill", false);
  check("截断体按预期抛错", false, "未抛错");
} catch (e) {
  check("截断体按预期抛错", true, e.message?.slice(0, 60));
}
await new Promise((r) => setTimeout(r, 80));
check("截断连接已被杀不回池", pool.stats().idleConns === 2 && conn4.tls.isClosed);

// 场景 5：暖连接静默死亡 → 冷重试自愈（复用失败且无响应字节）
console.log("== 场景 5：暖连接死亡 → 冷路径自愈 ==");
const conn5 = await establishConn();
await requestOnConn(conn5, "/cl", false);
const warm5 = pool.acquire("socks5://fake:1080", TARGET);
warm5.tls.close(); // 模拟对端静默断开（连接死）
let healed = false;
try {
  await requestOnConn(warm5, "/cl", true);
} catch (e) {
  healed = !e.sawBytes;
}
check("死暖连接失败（无响应字节 → 可安全重试）", healed);
const conn5b = await establishConn();
const r5 = await requestOnConn(conn5b, "/cl", false);
check("冷路径重建后请求成功", r5.status === 200, `body=${r5.text}`);

// ---- 汇总 ----
const failed = results.filter(([, ok]) => !ok);
console.log(`\n== 结果：${results.length - failed.length}/${results.length} 通过 ==`);
server.close();
process.exit(failed.length === 0 ? 0 : 1);
