#!/usr/bin/env node
// tls13-local-server-test.mjs —— 本地 Node TLS 1.3 服务端 + tls13.ts 客户端闭环测试
// 服务端能给出精确错误信息（bad_record_mac / decrypt_error / 等）
import net from "node:net";
import nodeTls from "node:tls";
import { Duplex } from "node:stream";
import { generateKeyPairSync, X509Certificate } from "node:crypto";

const { Tls13Client } = await import("../src/proxy/tls13.ts");
const { ByteBufReader } = await import("../src/proxy/byteio.ts");

// 生成自签证书
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const { execSync } = await import("node:child_process");
// openssl 生成自签证书（localhost SAN）
execSync('openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -keyout /tmp/t13key.pem -out /tmp/t13cert.pem -days 1 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,DNS:*.localhost"', { stdio: "pipe" });
const fs = await import("node:fs");
const certPem = fs.readFileSync("/tmp/t13cert.pem", "utf8");
const keyPem = fs.readFileSync("/tmp/t13key.pem", "utf8");
const certDer = new Uint8Array(Buffer.from(certPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"));
const pubPem = execSync("openssl x509 -in /tmp/t13cert.pem -noout -pubkey").toString();
const spki = new Uint8Array(Buffer.from(pubPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"));

// TLS 1.3 服务端
const server = nodeTls.createServer({
  key: keyPem,
  cert: certPem,
  minVersion: "TLSv1.3",
  maxVersion: "TLSv1.3",
  ciphers: "TLS_AES_128_GCM_SHA256",
  requestCert: false,
  handshakeTimeout: 8000,
}, (sock) => {
  console.log("[server] secure connection established");
  let data = "";
  sock.on("data", (d) => {
    data += d.toString("latin1");
    if (data.includes("\r\n\r\n")) {
      sock.write("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nHELLO");
      sock.end();
    }
  });
  sock.on("error", (e) => console.log("[server] socket error:", e.message));
});
server.on("tlsClientError", (err, sock) => {
  console.log("[server] tlsClientError:", err.message);
  sock?.destroy();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log("[test] server on port", port);

// 客户端：经本地 TCP 连接
const raw = net.connect({ host: "127.0.0.1", port });
await new Promise((r, j) => { raw.once("connect", r); raw.once("error", j); });
const web = Duplex.toWeb(raw);
const reader = new ByteBufReader(web.readable.getReader());
const writer = web.writable.getWriter();
const client = new Tls13Client(reader, writer, {
  serverName: "localhost",
  trustAnchors: [spki],
  onClose: () => raw.destroy(),
});
try {
  const t0 = Date.now();
  await client.handshake();
  console.log(`[client] handshake OK in ${Date.now() - t0}ms`);
  await client.write(Buffer.from("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
  console.log("[client] write OK");
  let body = Buffer.alloc(0);
  for (;;) {
    const c = await client.read();
    if (c === null) break;
    body = Buffer.concat([body, Buffer.from(c)]);
    if (body.length > 1024) break;
  }
  console.log("[client] response:", body.toString("latin1").split("\r\n")[0], "| bytes:", body.length);
} catch (e) {
  console.log("[client] FAILED:", e.message);
}
process.exit(0);
