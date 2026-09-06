#!/usr/bin/env node
// tls13-direct-test.mjs —— 直连 Google（无代理）验证 tls13.ts 的协议正确性
import net from "node:net";
import { Duplex } from "node:stream";
import { performance } from "node:perf_hooks";

const { Tls13Client } = await import("../src/proxy/tls13.ts");
const { ByteBufReader } = await import("../src/proxy/byteio.ts");
const TARGET = "generativelanguage.googleapis.com";

const sock = net.connect({ host: TARGET, port: 443 });
await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
sock.setNoDelay(true);
const web = Duplex.toWeb(sock);
class VReader extends ByteBufReader {
  async readExact(n) {
    const r = await super.readExact(n);
    if (n <= 8) {
      console.error(`[rx ${n}] ${Buffer.from(r).toString("hex")}`);
    } else {
      console.error(`[rx ${n}] ${Buffer.from(r.slice(0, 24)).toString("hex")}...`);
    }
    return r;
  }
}
const reader = new VReader(web.readable.getReader());
const writer = web.writable.getWriter();

const t0 = performance.now();
const tls = new Tls13Client(reader, writer, { serverName: TARGET, onClose: () => sock.destroy() });
await tls.handshake();
console.log(`handshake OK in ${Math.round(performance.now() - t0)}ms (cert chain + CertificateVerify + Finished all passed)`);

const req = `GET /v1beta/models HTTP/1.1\r\nHost: ${TARGET}\r\nUser-Agent: direct-test/1.0\r\nConnection: close\r\n\r\n`;
const tw = performance.now();
await tls.write(Buffer.from(req));
let data = Buffer.alloc(0);
for (;;) {
  const c = await tls.read();
  if (c === null) break;
  data = Buffer.concat([data, Buffer.from(c)]);
  if (data.length > 8192) break;
}
console.log(`HTTP ${Math.round(performance.now() - tw)}ms: ${data.toString("latin1").split("\r\n")[0]}`);
const headers = data.toString("latin1").split("\r\n\r\n")[0];
console.log("headers:", headers.split("\r\n").slice(1, 6).join(" | "));
console.log("body bytes:", data.length - (data.indexOf("\r\n\r\n") + 4));
tls.close();
sock.destroy();
process.exit(0);
