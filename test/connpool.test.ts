// v2.2.0 连接复用池（connpool.ts）+ 复用判定（httpclient.ts）单元测试（Node 原生 TS 运行）
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnPool, type PooledConn } from "../src/proxy/connpool.ts";
import type { Tls13Client } from "../src/proxy/tls13.ts";
import { ByteBufReader } from "../src/proxy/byteio.ts";
import { isBodylessStatus, makeBodyStream, responseAllowsReuse, type ResponseHead } from "../src/proxy/httpclient.ts";

// ===== 测试工具 =====

function fakeTls(): { tls: Tls13Client; closedFlag: { v: boolean } } {
  const closedFlag = { v: false };
  const tls = {
    get isClosed() {
      return closedFlag.v;
    },
    close() {
      closedFlag.v = true;
    },
  } as unknown as Tls13Client;
  return { tls, closedFlag };
}

function fakeConn(proxyRaw: string, target = "h:443"): { conn: PooledConn; closedFlag: { v: boolean } } {
  const { tls, closedFlag } = fakeTls();
  const now = Date.now();
  const conn: PooledConn = {
    proxyRaw,
    target,
    tls,
    reader: new ByteBufReader(new ReadableStream<Uint8Array>().getReader()),
    writer: { write: async (_c: Uint8Array) => {} },
    created: now,
    lastUsed: now,
    uses: 0,
  };
  return { conn, closedFlag };
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function readerFromChunks(chunks: Uint8Array[]): ByteBufReader {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new ByteBufReader(stream.getReader());
}

// ===== ConnPool 基本语义 =====

test("connpool: acquire on empty pool returns null", () => {
  const pool = new ConnPool();
  assert.equal(pool.acquire("socks5://a:1", "h:443"), null);
});

test("connpool: release(reusable=true) → acquire returns same conn, uses incremented", () => {
  const pool = new ConnPool();
  const { conn } = fakeConn("socks5://a:1");
  pool.release(conn, true);
  assert.equal(pool.stats().idleConns, 1);
  const got = pool.acquire("socks5://a:1", "h:443");
  assert.ok(got);
  assert.equal(got, conn);
  assert.equal(got.uses, 1);
  // 取出后池为空
  assert.equal(pool.acquire("socks5://a:1", "h:443"), null);
});

test("connpool: release(reusable=false) closes conn, nothing pooled", () => {
  const pool = new ConnPool();
  const { conn, closedFlag } = fakeConn("http://b:2");
  pool.release(conn, false);
  assert.equal(closedFlag.v, true);
  assert.equal(pool.stats().idleConns, 0);
});

test("connpool: acquire per (proxy,target) key isolation", () => {
  const pool = new ConnPool();
  const a = fakeConn("socks5://a:1").conn;
  const b = fakeConn("socks5://a:1").conn; // 同代理不同连接实例
  const c = fakeConn("socks5://a:1").conn;
  const pA = "socks5://a:1";
  const pB = "socks5://b:2";
  const t1 = "host1:443";
  const t2 = "host2:443";
  const connA = { ...a, target: t1, proxyRaw: pA } as PooledConn;
  const connB = { ...b, target: t2, proxyRaw: pA } as PooledConn;
  const connC = { ...c, target: t1, proxyRaw: pB } as PooledConn;
  pool.release(connA, true);
  pool.release(connB, true);
  pool.release(connC, true);
  assert.equal(pool.acquire(pA, t1), connA);
  assert.equal(pool.acquire(pA, t2), connB);
  assert.equal(pool.acquire(pB, t1), connC);
});

test("connpool: dead conn (isClosed) never returned, killed on acquire", () => {
  const pool = new ConnPool();
  const { conn, closedFlag } = fakeConn("socks5://a:1");
  pool.release(conn, true);
  closedFlag.v = true; // 池内连接已死（对端静默断开）
  assert.equal(pool.acquire("socks5://a:1", "h:443"), null);
  assert.equal(pool.stats().idleConns, 0);
});

test("connpool: idle expiry via injected clock", () => {
  let t = 1000;
  const pool = new ConnPool({ maxIdleMs: 45_000 }, () => t);
  const { conn, closedFlag } = fakeConn("socks5://a:1");
  pool.release(conn, true);
  t += 44_999; // 未过期
  assert.ok(pool.acquire("socks5://a:1", "h:443"));
  pool.release(conn, true);
  t += 45_001; // 过期
  assert.equal(pool.acquire("socks5://a:1", "h:443"), null);
  assert.equal(closedFlag.v, true);
});

test("connpool: max uses eviction", () => {
  const pool = new ConnPool({ maxUses: 3 });
  const { conn } = fakeConn("socks5://a:1");
  for (let i = 0; i < 3; i++) {
    const got = i === 0 ? conn : pool.acquire("socks5://a:1", "h:443");
    pool.release(got!, true);
  }
  assert.equal(conn.uses, 3);
  // 第 3 次归还后 uses=3 ≥ maxUses=3 → 不再入池
  assert.equal(pool.acquire("socks5://a:1", "h:443"), null);
});

test("connpool: capacity limit evicts oldest idle", () => {
  let t = 0;
  const pool = new ConnPool({ maxConns: 2 }, () => t);
  const c1 = fakeConn("socks5://a:1").conn;
  const c2 = fakeConn("socks5://b:2").conn;
  const c3 = fakeConn("socks5://c:3").conn;
  pool.release(c1, true); // t=0 最旧
  t = 10;
  pool.release(c2, true);
  t = 20;
  pool.release(c3, true); // 超容：驱逐 c1
  assert.equal(pool.stats().idleConns, 2);
  assert.equal(pool.acquire("socks5://a:1", "h:443"), null); // c1 已被驱逐
  assert.ok(pool.acquire("socks5://b:2", "h:443"));
  assert.ok(pool.acquire("socks5://c:3", "h:443"));
});

test("connpool: isWarm reflects per-proxy warm conns", () => {
  const pool = new ConnPool();
  assert.equal(pool.isWarm("socks5://a:1"), false);
  const { conn } = fakeConn("socks5://a:1");
  pool.release(conn, true);
  assert.equal(pool.isWarm("socks5://a:1"), true);
  assert.equal(pool.isWarm("socks5://zz:9"), false);
});

test("connpool: discard kills conn", () => {
  const pool = new ConnPool();
  const { conn, closedFlag } = fakeConn("socks5://a:1");
  pool.discard(conn);
  assert.equal(closedFlag.v, true);
});

test("connpool: stats snapshot shape", () => {
  const pool = new ConnPool();
  const { conn } = fakeConn("socks5://a:1");
  pool.release(conn, true);
  const s = pool.stats();
  assert.equal(s.idleConns, 1);
  assert.equal(s.warmProxies, 1);
  assert.equal(s.conns[0].proxy, "socks5://a:1");
  assert.equal(s.conns[0].uses, 1);
});

// ===== makeBodyStream 复用判定 =====

test("makeBodyStream: chunked body fully read → cleanup(true)", async () => {
  const reader = readerFromChunks([enc("5\r\nhello\r\n0\r\n\r\n")]);
  const calls: boolean[] = [];
  const stream = makeBodyStream(reader, { chunked: true, contentLength: null }, (r) => calls.push(r));
  const out = await new Response(stream).text();
  assert.equal(out, "hello");
  assert.deepEqual(calls, [true]);
});

test("makeBodyStream: content-length body fully read → cleanup(true)", async () => {
  const reader = readerFromChunks([enc("hello world")]);
  const calls: boolean[] = [];
  const stream = makeBodyStream(reader, { chunked: false, contentLength: 11 }, (r) => calls.push(r));
  const out = await new Response(stream).text();
  assert.equal(out, "hello world");
  assert.deepEqual(calls, [true]);
});

test("makeBodyStream: EOF-terminated body → cleanup(false)（连接已死不可复用）", async () => {
  const reader = readerFromChunks([enc("partial")]);
  const calls: boolean[] = [];
  const stream = makeBodyStream(reader, { chunked: false, contentLength: null }, (r) => calls.push(r));
  const out = await new Response(stream).text();
  assert.equal(out, "partial");
  assert.deepEqual(calls, [false]);
});

test("makeBodyStream: consumer cancel → cleanup(false)", async () => {
  // 无尽流：读取一次后 cancel
  let pullCount = 0;
  const src = new ReadableStream<Uint8Array>({
    pull(controller) {
      pullCount++;
      controller.enqueue(enc("x".repeat(16)));
    },
  });
  const reader = new ByteBufReader(src.getReader());
  const calls: boolean[] = [];
  const stream = makeBodyStream(reader, { chunked: false, contentLength: 1_000_000 }, (r) => calls.push(r));
  const r = stream.getReader();
  await r.read();
  await r.cancel();
  assert.deepEqual(calls, [false]);
  void pullCount;
});

test("makeBodyStream: truncated chunked body (error) → cleanup(false)", async () => {
  // chunk 尺寸声明 5 但只有 3 字节 + EOF → readExact 抛错
  const src = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc("5\r\nabc"));
      controller.close();
    },
  });
  const reader = new ByteBufReader(src.getReader());
  const calls: boolean[] = [];
  const stream = makeBodyStream(reader, { chunked: true, contentLength: null }, (r) => calls.push(r));
  await assert.rejects(() => new Response(stream).text());
  assert.deepEqual(calls, [false]);
});

// ===== 复用判定纯函数 =====

test("isBodylessStatus: HEAD/204/304", () => {
  assert.equal(isBodylessStatus("HEAD", 200), true);
  assert.equal(isBodylessStatus("GET", 204), true);
  assert.equal(isBodylessStatus("GET", 304), true);
  assert.equal(isBodylessStatus("GET", 200), false);
  assert.equal(isBodylessStatus("POST", 429), false);
});

test("responseAllowsReuse: connection close / 1xx", () => {
  const base: ResponseHead = { status: 200, reason: "OK", headers: {} };
  assert.equal(responseAllowsReuse(base), true);
  assert.equal(responseAllowsReuse({ ...base, headers: { connection: "keep-alive" } }), true);
  assert.equal(responseAllowsReuse({ ...base, headers: { connection: "Close" } }), false);
  assert.equal(responseAllowsReuse({ ...base, headers: { "proxy-connection": "close" } }), false);
  assert.equal(responseAllowsReuse({ status: 100, reason: "Continue", headers: {} }), false);
  assert.equal(responseAllowsReuse({ status: 103, reason: "Early Hints", headers: {} }), false);
});
