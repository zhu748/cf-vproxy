// 代理协议帧 + 字节流读取器 + HTTP/1.1 客户端 单元测试（Node 原生 TS 运行）
import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteBufReader, concatBytes } from "../src/proxy/byteio.ts";
import {
  buildHttpConnectRequest,
  buildSocks4ConnectRequest,
  buildSocks5AuthRequest,
  buildSocks5ConnectRequest,
  buildSocks5Greeting,
  classifyProxyLine,
  cleanProxyList,
  parseHttpConnectReply,
  parseProxyUrl,
  parseSocks4ConnectReply,
  parseSocks5AuthReply,
  parseSocks5ConnectReply,
  parseSocks5MethodReply,
} from "../src/proxy/frames.ts";
import {
  determineBodyShape,
  makeBodyStream,
  parseResponseHeadBlock,
  readFullBody,
} from "../src/proxy/httpclient.ts";

// ===== 工具 =====

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function newReader(chunks: Uint8Array[]): Promise<{ reader: ByteBufReader; stream: ReadableStream<Uint8Array> }> {
  const stream = streamFromChunks(chunks);
  const reader = new ByteBufReader(stream.getReader());
  return { reader, stream };
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// ===== SOCKS5 帧 =====

test("socks5 greeting: no auth", () => {
  const f = buildSocks5Greeting(null);
  assert.deepEqual(Array.from(f), [5, 1, 0]);
});

test("socks5 greeting: offers no-auth + userpass", () => {
  const f = buildSocks5Greeting(0x02);
  assert.deepEqual(Array.from(f), [5, 2, 0, 2]);
});

test("socks5 auth request frame", () => {
  const f = buildSocks5AuthRequest("alice", "p@ss w0rd");
  assert.equal(f[0], 1);
  assert.equal(f[1], 5); // "alice"
  assert.equal(dec(f.subarray(2, 7)), "alice");
  const plen = f[7];
  assert.equal(plen, 9);
  assert.equal(dec(f.subarray(8, 8 + plen)), "p@ss w0rd");
});

test("socks5 auth reply parse", () => {
  assert.deepEqual(parseSocks5AuthReply(new Uint8Array([1, 0])), { value: { status: 0 }, consumed: 2 });
  assert.equal(parseSocks5AuthReply(new Uint8Array([1])), null);
});

test("socks5 method reply parse", () => {
  assert.deepEqual(parseSocks5MethodReply(new Uint8Array([5, 2])), { value: { ver: 5, method: 2 }, consumed: 2 });
  assert.equal(parseSocks5MethodReply(new Uint8Array([5])), null);
});

test("socks5 connect request uses domain ATYP and big-endian port", () => {
  const f = buildSocks5ConnectRequest("generativelanguage.googleapis.com", 443);
  assert.equal(f[0], 5);
  assert.equal(f[1], 1); // CONNECT
  assert.equal(f[3], 3); // domain
  const hostLen = f[4];
  assert.equal(dec(f.subarray(5, 5 + hostLen)), "generativelanguage.googleapis.com");
  const port = (f[5 + hostLen] << 8) | f[6 + hostLen];
  assert.equal(port, 443);
});

test("socks5 connect reply: ipv4 / domain / truncated", () => {
  const ipv4 = new Uint8Array([5, 0, 0, 1, 10, 0, 0, 1, 0x01, 0xbb]);
  const r1 = parseSocks5ConnectReply(ipv4);
  assert.ok(r1);
  assert.equal(r1.value.rep, 0);
  assert.equal(r1.consumed, 10);

  const domain = concatBytes([new Uint8Array([5, 0, 0, 3, 3]), enc("foo"), new Uint8Array([0, 80])]);
  const r2 = parseSocks5ConnectReply(domain);
  assert.ok(r2);
  assert.equal(r2.consumed, 4 + 1 + 3 + 2);

  assert.equal(parseSocks5ConnectReply(new Uint8Array([5, 0, 0, 3])), null); // 长度字节未到
  const fail = new Uint8Array([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
  const r3 = parseSocks5ConnectReply(fail);
  assert.ok(r3);
  assert.equal(r3.value.rep, 5); // connection refused
});

test("http connect request includes basic auth", () => {
  const f = dec(buildHttpConnectRequest("proxy.example.com", 8080, "u", "p"));
  assert.ok(f.startsWith("CONNECT proxy.example.com:8080 HTTP/1.1\r\n"));
  assert.ok(f.includes("Proxy-Authorization: Basic " + btoa("u:p")));
  assert.ok(f.endsWith("\r\n\r\n"));

  const f2 = dec(buildHttpConnectRequest("h", 1));
  assert.ok(!f2.includes("Proxy-Authorization"));
});

test("http connect reply parse", () => {
  const ok = parseHttpConnectReply(enc("HTTP/1.1 200 Connection established\r\n\r\n"));
  assert.equal(ok.ok, true);
  const denied = parseHttpConnectReply(enc("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"));
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 407);
});

// ===== parseProxyUrl =====

test("parseProxyUrl: socks5 with auth", () => {
  const p = parseProxyUrl("socks5://user:p%40ss@1.2.3.4:1080");
  assert.ok(p);
  assert.equal(p.kind, "socks5");
  assert.equal(p.host, "1.2.3.4");
  assert.equal(p.port, 1080);
  assert.equal(p.username, "user");
  assert.equal(p.password, "p@ss");
});

test("parseProxyUrl: http proxy default port", () => {
  const p = parseProxyUrl("http://10.0.0.1");
  assert.ok(p);
  assert.equal(p.port, 80);
});

test("parseProxyUrl: socks4 / socks4a accepted", () => {
  const p1 = parseProxyUrl("socks4://u@5.6.7.8:5678");
  assert.ok(p1);
  assert.equal(p1.kind, "socks4");
  assert.equal(p1.port, 5678);
  assert.equal(p1.username, "u");
  const p2 = parseProxyUrl("socks4a://mysocks4.example.com:5678");
  assert.ok(p2);
  assert.equal(p2.kind, "socks4");
  assert.equal(p2.host, "mysocks4.example.com");
  assert.equal(parseProxyUrl("vmess://xxxxxxxx"), null);
  assert.equal(parseProxyUrl(""), null);
});

test("parseProxyUrl: https proxy rejected (Workers 无法 TLS-in-TLS)", () => {
  assert.equal(parseProxyUrl("https://u:p@proxy.io:443"), null);
  const v = classifyProxyLine("https://u:p@proxy.io:443");
  assert.equal(v.status, "unsupported");
  if (v.status === "unsupported") assert.ok(v.reason.includes("https"));
});

test("parseProxyUrl: bare host defaults to socks5", () => {
  const p = parseProxyUrl("1.2.3.4:1080");
  assert.ok(p);
  assert.equal(p.kind, "socks5");
  assert.equal(p.port, 1080);
});

// ===== SOCKS4 / 4a 帧 =====

test("socks4 connect: pure-4 frame for IPv4 target", () => {
  const f = buildSocks4ConnectRequest("192.168.1.1", 443, "alice");
  assert.deepEqual(Array.from(f.subarray(0, 8)), [4, 1, 0x01, 0xbb, 192, 168, 1, 1]);
  assert.equal(dec(f.subarray(8, 13)), "alice");
  assert.equal(f[f.length - 1], 0); // userid 以 NUL 结尾
  assert.equal(f.length, 9 + 5);
});

test("socks4 connect: 4a frame for domain target", () => {
  const f = buildSocks4ConnectRequest("generativelanguage.googleapis.com", 443);
  assert.equal(f[0], 4);
  assert.equal(f[1], 1);
  assert.equal((f[2] << 8) | f[3], 443);
  // 4a 标记：IP 占位 0.0.0.1
  assert.deepEqual(Array.from(f.subarray(4, 8)), [0, 0, 0, 1]);
  // 无 userid：紧跟 NUL 后是域名，域名后 NUL 结尾
  assert.equal(f[8], 0);
  const host = "generativelanguage.googleapis.com";
  assert.equal(dec(f.subarray(9, 9 + host.length)), host);
  assert.equal(f[f.length - 1], 0);
});

test("socks4 connect: bad port throws", () => {
  assert.throws(() => buildSocks4ConnectRequest("1.2.3.4", 0));
  assert.throws(() => buildSocks4ConnectRequest("1.2.3.4", 70000));
});

test("socks4 reply parse: granted / rejected / short buffer", () => {
  const ok = parseSocks4ConnectReply(new Uint8Array([0, 0x5a, 0x01, 0xbb, 10, 0, 0, 1]));
  assert.ok(ok);
  assert.equal(ok.value.rep, 0x5a);
  assert.equal(ok.consumed, 8);

  const no = parseSocks4ConnectReply(new Uint8Array([0, 0x5b, 0, 0, 0, 0, 0, 0]));
  assert.ok(no);
  assert.equal(no.value.rep, 0x5b);

  // 个别实现回显 0x04 版本号，兼容
  const echo = parseSocks4ConnectReply(new Uint8Array([4, 0x5a, 0, 0, 0, 0, 0, 0]));
  assert.ok(echo);
  assert.equal(echo.value.rep, 0x5a);

  assert.equal(parseSocks4ConnectReply(new Uint8Array([0, 0x5a, 0, 0, 0, 0, 0])), null);
});

test("socks4 tryParse consumes exactly 8 bytes and keeps tail", async () => {
  const reply = new Uint8Array([0, 0x5a, 0x01, 0xbb, 1, 2, 3, 4]);
  const { reader } = await newReader([reply, enc("TAIL")]);
  const v = await reader.tryParse(parseSocks4ConnectReply);
  assert.equal(v.rep, 0x5a);
  const rest = await reader.readAvailable();
  assert.equal(dec(rest!), "TAIL");
});

// ===== classifyProxyLine / cleanProxyList（https 自动剔除） =====

test("classifyProxyLine: supported schemes pass", () => {
  for (const s of [
    "socks5://1.2.3.4:1080",
    "socks5h://u:p@h:1080",
    "socks4://1.2.3.4:5678",
    "socks4a://mysocks4.example.com:5678",
    "socks://1.2.3.4",
    "http://5.6.7.8:8080",
    "1.2.3.4:1080", // 裸地址默认 socks5
  ]) {
    const v = classifyProxyLine(s);
    assert.equal(v.status, "ok", s);
    if (v.status === "ok") assert.ok(v.entry.host.length > 0);
  }
});

test("classifyProxyLine: https / tls / ssl auto-removed with reason", () => {
  for (const s of ["https://p.example.com", "tls://1.2.3.4:443", "ssl://1.2.3.4:443"]) {
    const v = classifyProxyLine(s);
    assert.equal(v.status, "unsupported", s);
    if (v.status === "unsupported") assert.ok(v.reason.includes("TLS-in-TLS") || v.reason.includes("https"));
  }
});

test("classifyProxyLine: unknown protocols and junk removed", () => {
  for (const s of ["vmess://xxxxxxxx", "vless://uuid@host:443", "ss://base64", "trojan://pass@host:443", "not a url :://"]) {
    assert.equal(classifyProxyLine(s).status, "unsupported", s);
  }
  assert.equal(classifyProxyLine("").status, "unsupported");
});

test("cleanProxyList: keeps supported, dedups, reports removed", () => {
  const r = cleanProxyList([
    "socks5://1.2.3.4:1080",
    "https://proxy.example.com", // 剔除
    "vmess://abc", // 剔除
    "socks5://1.2.3.4:1080", // 去重
    "socks4://5.6.7.8:5678",
    "", // 跳过
  ]);
  assert.deepEqual(r.kept, ["socks5://1.2.3.4:1080", "socks4://5.6.7.8:5678"]);
  assert.equal(r.removed.length, 2);
  assert.ok(r.removed[0].reason.includes("https"));
  assert.ok(r.removed[1].reason.includes("vmess"));
});

test("readLine across chunks", async () => {
  const { reader } = await newReader([enc("HE"), enc("LLO\r\n"), enc("WORLD\r\n"), enc("TAIL")]);
  assert.equal(await reader.readLine(), "HELLO");
  assert.equal(await reader.readLine(), "WORLD");
  const rest = await reader.readAvailable();
  assert.equal(dec(rest!), "TAIL");
});

test("readExact waits for enough bytes", async () => {
  const { reader } = await newReader([enc("abc"), enc("defg")]);
  const out = await reader.readExact(7);
  assert.equal(dec(out), "abcdefg");
});

test("readHeaderBlock returns full head incl terminator and keeps leftover", async () => {
  const head = "HTTP/1.1 200 OK\r\nX-A: 1\r\n\r\nBODY-DATA";
  const { reader } = await newReader([enc(head.slice(0, 5)), enc(head.slice(5))]);
  const block = await reader.readHeaderBlock();
  assert.equal(dec(block), "HTTP/1.1 200 OK\r\nX-A: 1\r\n\r\n");
  const rest = await reader.readAvailable();
  assert.equal(dec(rest!), "BODY-DATA");
});

test("tryParse consumes exactly the parsed reply length", async () => {
  const reply = new Uint8Array([5, 0, 0, 1, 1, 2, 3, 4, 0, 80]);
  const extra = enc("TAIL");
  const { reader } = await newReader([reply, extra]);
  const v = await reader.tryParse(parseSocks5ConnectReply);
  assert.equal(v.rep, 0);
  const rest = await reader.readAvailable();
  assert.equal(dec(rest!), "TAIL");
});

test("readAvailable returns null at EOF", async () => {
  const { reader } = await newReader([]);
  assert.equal(await reader.readAvailable(), null);
});

// ===== HTTP/1.1 响应解析 =====

test("parseResponseHeadBlock", () => {
  const block = enc("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n");
  const head = parseResponseHeadBlock(block);
  assert.equal(head.status, 200);
  assert.equal(head.reason, "OK");
  assert.equal(head.headers["content-type"], "text/event-stream");
  assert.equal(head.headers["transfer-encoding"], "chunked");
});

test("determineBodyShape", () => {
  assert.deepEqual(determineBodyShape({ "transfer-encoding": "chunked" }), { chunked: true, contentLength: null });
  assert.deepEqual(determineBodyShape({ "content-length": "123" }), { chunked: false, contentLength: 123 });
  assert.deepEqual(determineBodyShape({}), { chunked: false, contentLength: null });
});

test("makeBodyStream decodes chunked body", async () => {
  const body = "3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n";
  const { reader } = await newReader([enc(body)]);
  const stream = makeBodyStream(reader, { chunked: true, contentLength: null }, () => {});
  const text = dec(await readWholeStream(stream));
  assert.equal(text, "abcdefg");
});

test("makeBodyStream content-length exact read", async () => {
  const { reader } = await newReader([enc("hello world extra-should-not-appear")]);
  const stream = makeBodyStream(reader, { chunked: false, contentLength: 11 }, () => {});
  const text = dec(await readWholeStream(stream));
  assert.equal(text, "hello world");
});

test("makeBodyStream EOF-terminated body", async () => {
  const { reader } = await newReader([enc("chunk1"), enc("chunk2")]);
  const stream = makeBodyStream(reader, { chunked: false, contentLength: null }, () => {});
  const text = dec(await readWholeStream(stream));
  assert.equal(text, "chunk1chunk2");
});

test("readFullBody: content-length", async () => {
  const { reader } = await newReader([enc("12345"), enc("67890")]);
  const out = await readFullBody(reader, { chunked: false, contentLength: 8 });
  assert.equal(dec(out), "12345678");
});

async function readWholeStream(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const r = s.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await r.read();
    if (done) break;
    if (value) parts.push(value);
  }
  return concatBytes(parts);
}
