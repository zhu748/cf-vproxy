#!/usr/bin/env node
// tls13-resumption-test.mjs —— v2.3 TLS 1.3 PSK 会话恢复端到端验证（本地 Node TLS 服务器）。
//
// 验证链路（全部走真实 OpenSSL 服务端，含 binder 校验、票据签发/消费、Finished 验证）：
//   连接1 → 服务器A：完整握手（证书校验+CV 验签），读响应期间吸收 NewSessionTicket；
//   连接2 → 服务器A：携带票据握手 → 应为 PSK 恢复（resumed=true，无证书飞行段）；
//   连接3 → 服务器B（同证书但从未签发过票据）：票据不被识别 → 服务端拒绝恢复，
//           回退完整握手（证书校验仍通过）—— 降级安全性验证；
//   连接4 → 服务器A：3MB 请求体写入（writeRecords 单缓冲区批路径压测）。
//
// 运行：node scripts/tls13-resumption-test.mjs
import net from "node:net";
import nodeTls from "node:tls";
import { Duplex } from "node:stream";
import { execSync } from "node:child_process";
import fs from "node:fs";

const { Tls13Client, peekSessionTicket } = await import("../src/proxy/tls13.ts");
const { ByteBufReader } = await import("../src/proxy/byteio.ts");

const assert = (cond, msg) => {
  if (!cond) {
    console.error("❌ ASSERT FAILED: " + msg);
    process.exitCode = 1;
  } else {
    console.log("✅ " + msg);
  }
};

// ---- 自签证书（localhost SAN）—— 与 tls13-local-server-test.mjs 相同 ----
execSync(
  'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -keyout /tmp/t13r-key.pem -out /tmp/t13r-cert.pem -days 1 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,DNS:*.localhost"',
  { stdio: "pipe" },
);
const certPem = fs.readFileSync("/tmp/t13r-cert.pem", "utf8");
const keyPem = fs.readFileSync("/tmp/t13r-key.pem", "utf8");
const certDer = new Uint8Array(Buffer.from(certPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"));
const pubPem = execSync("openssl x509 -in /tmp/t13r-cert.pem -noout -pubkey").toString();
const spki = new Uint8Array(Buffer.from(pubPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"));
void certDer;

// ---- TLS 1.3 服务端（每实例独立 ticket keys → B 不认识 A 的票据）----
const serverConns = [];
const makeServer = async (label) => {
  const server = nodeTls.createServer(
    {
      key: keyPem,
      cert: certPem,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ciphers: "TLS_AES_128_GCM_SHA256",
      requestCert: false,
      handshakeTimeout: 8000,
    },
    (sock) => {
      const reused = sock.isSessionReused();
      serverConns.push({ label, reused });
      console.log(`[server:${label}] connection established, session_reused=${reused}`);
      let data = Buffer.alloc(0);
      sock.on("data", (d) => {
        data = Buffer.concat([data, d]);
        if (data.includes("\r\n\r\n")) {
          sock.write(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nHI",
          );
          sock.end();
        }
      });
      sock.on("error", () => {});
    },
  );
  server.on("tlsClientError", (err, sock) => {
    console.log(`[server:${label}] tlsClientError:`, err.message);
    sock?.destroy();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
};

// ---- 客户端连接 ----
const connectOnce = async (port) => {
  const raw = net.connect({ host: "127.0.0.1", port });
  await new Promise((r, j) => {
    raw.once("connect", r);
    raw.once("error", j);
  });
  const web = Duplex.toWeb(raw);
  const reader = new ByteBufReader(web.readable.getReader());
  const writer = web.writable.getWriter();
  const client = new Tls13Client(reader, writer, {
    serverName: "localhost",
    trustAnchors: [spki],
    onClose: () => raw.destroy(),
  });
  const t0 = Date.now();
  await client.handshake();
  const hsMs = Date.now() - t0;
  return { client, hsMs, raw };
};

const readAll = async (client, cap = 4096) => {
  let body = Buffer.alloc(0);
  for (;;) {
    const c = await client.read();
    if (c === null) break;
    body = Buffer.concat([body, Buffer.from(c)]);
    if (body.length > cap) break;
  }
  return body;
};

// ==================================================================
console.log("== 连接1：完整握手 + 吸收 NewSessionTicket ==");
const A = await makeServer("A");
const B = await makeServer("B");
try {
  {
    const { client, hsMs, raw } = await connectOnce(A.port);
    await client.write(Buffer.from("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
    const body = await readAll(client);
    client.close();
    raw.destroy();
    const ticket = peekSessionTicket("localhost");
    assert(body.toString("latin1").startsWith("HTTP/1.1 200"), "连接1 完整握手成功并收到响应");
    assert(!client.resumed, "连接1 走完整握手（resumed=false）");
    assert(ticket !== null && ticket.psk.length === 32, "连接1 吸收到会话票据（PSK 32 字节）");
    console.log(`   握手耗时 ${hsMs}ms，identity ${ticket?.identity.length} 字节, lifetime ${ticket?.lifetimeSec}s`);
  }

  console.log("== 连接2：向服务器A 提供票据 → PSK 恢复 ==");
  {
    const { client, hsMs, raw } = await connectOnce(A.port);
    await client.write(Buffer.from("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
    const body = await readAll(client);
    client.close();
    raw.destroy();
    assert(body.toString("latin1").startsWith("HTTP/1.1 200"), "连接2 响应正常");
    assert(client.resumed, "连接2 通过 PSK 恢复完成握手（resumed=true，无证书飞行段）");
    const connA = serverConns.filter((c) => c.label === "A");
    assert(connA.length >= 2 && connA[connA.length - 1].reused === true, "服务端视角：会话被复用（isSessionReused=true）");
    console.log(`   握手耗时 ${hsMs}ms（完整握手省去证书段传输与验签）`);
  }

  console.log("== 连接3：把票据给从未签发过票据的服务器B → 拒绝恢复，降级完整握手 ==");
  {
    const { client, hsMs, raw } = await connectOnce(B.port);
    await client.write(Buffer.from("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
    const body = await readAll(client);
    client.close();
    raw.destroy();
    assert(body.toString("latin1").startsWith("HTTP/1.1 200"), "连接3 响应正常");
    assert(!client.resumed, "连接3 服务端拒绝恢复 → 自动回退完整握手（安全降级）");
    const connB = serverConns.filter((c) => c.label === "B");
    assert(connB[connB.length - 1].reused === false, "服务端视角：B 无会话复用");
    console.log(`   握手耗时 ${hsMs}ms`);
  }

  console.log("== 连接4：3MB 请求体写入（writeRecords 单缓冲区批路径） ==");
  {
    const { client, raw } = await connectOnce(A.port);
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61); // 192 条记录
    const t0 = Date.now();
    await client.write(big); // > 16KB → 分片 + 单缓冲区批量写
    await client.write(Buffer.from("\r\n\r\n"));
    const body = await readAll(client);
    client.close();
    raw.destroy();
    assert(body.toString("latin1").startsWith("HTTP/1.1 200"), "连接4 大请求体写入与响应正常");
    console.log(`   3MB 写入耗时 ${Date.now() - t0}ms`);
  }

  console.log(process.exitCode ? "\n== 有断言失败 ==" : "\n== 全部通过 ==");
} finally {
  A.server.close();
  B.server.close();
}
