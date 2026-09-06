// 出站隧道层：
//   - 走 cloudflare:sockets 建立 SOCKS4/4a、SOCKS5 或 HTTP CONNECT 隧道 + startTls + HTTP/1.1；
//   - 支持"原项目式"订阅链接拉取：纯文本 / Base64 的 socks4/socks5/http 节点列表，
//     结果缓存 KV，按 subscription_refresh_minutes 惰性刷新；
//   - https://、vmess/vless/ss 等不支持的代理链接在入口处自动剔除并计数（Workers 无法 TLS-in-TLS）。
//   - 轮换/接力/对冲竞速编排已上移至 racefetch.ts（含节点健康度记录）。
// ⚠️ 本文件 import "cloudflare:sockets"，只能在 Workers 运行时加载（不在 Node 单测范围）。
import { connect } from "cloudflare:sockets";
import type { Env } from "../config.ts";
import type { VProxyConfig } from "../types.ts";
import { ByteBufReader } from "./byteio.ts";
import { connPool, type PooledConn } from "./connpool.ts";
import { classifyProxyLine, parseProxyUrl, type ProxyEntry } from "./frames.ts";
import {
  determineBodyShape,
  isBodylessStatus,
  makeBodyStream,
  parseResponseHeadBlock,
  readFullBody,
  responseAllowsReuse,
  writeTunnelRequest,
  type ResponseHead,
} from "./httpclient.ts";
import { httpConnectHandshake, socks4Handshake, socks5Handshake } from "./tunnel.ts";
import { Tls13Client, invalidateSessionTicket } from "./tls13.ts";

const SUB_CACHE_KEY = "proxy_cache";
const MAX_PROXIES = 200;
const CONNECT_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const TLS13_HANDSHAKE_TIMEOUT_MS = 12_000;
// v2.4：响应头等待上限。connect/代理握手/TLS 握手/写请求都有超时，唯独「等服务端响应头」
// 此前没有 —— 代理静默黑洞（TCP 活着但不转发了）会把请求永久挂起：竞速模式靠对冲兜底，
// 顺序模式（单节点 / 关竞速）没有任何兜底，客户端不断开就一直挂着。
// 120s 足够宽容：Gemini 非流式 + 深度思考的长生成通常也在 120s 内返回头部。
const RESPONSE_HEAD_TIMEOUT_MS = 120_000;
// v2.4：订阅拉取超时 10s → 20s：免费托管平台（Render 等）冷启动常态 30s+，
// 10s 必失败；20s 至少能在实例温热时一次成功（cron 每 15 分钟一跳会持续保温）。
const SUB_FETCH_TIMEOUT_MS = 20_000;

// v2.4：共享编码器（补漏：encodeBody 此前每请求 new 一个 TextEncoder）
const TE = new TextEncoder();

// v1.6.0：订阅缓存与代理池的 isolate 内存缓存 ——
// 此前每个业务请求都读一次 KV 订阅缓存 + 全量重新解析/去重代理 URL（免费计划 10 万读/天的
// 额度会被高频流量打爆，且每请求多一次 KV 往返延迟）。现在：
//   - 订阅缓存命中后 30 秒内不再读 KV（KV 读失败时回退到内存旧值）；
//   - ProxyPool 解析结果按「静态列表+订阅列表」拼串做键缓存，未变直接复用。

export class ProxyPool {
  // 注意：不用 TS 参数属性（Node strip-types 模式不支持）
  readonly entries: ProxyEntry[];
  readonly removed: Array<{ raw: string; reason: string }>;

  constructor(entries: ProxyEntry[], removed: Array<{ raw: string; reason: string }> = []) {
    this.entries = entries;
    this.removed = removed;
  }

  get size(): number {
    return this.entries.length;
  }

  static fromStrings(strs: string[]): ProxyPool {
    const seen = new Set<string>();
    const entries: ProxyEntry[] = [];
    const removed: Array<{ raw: string; reason: string }> = [];
    for (const s of strs) {
      const v = classifyProxyLine(s);
      if (v.status !== "ok") {
        removed.push({ raw: s.trim(), reason: v.reason });
        continue;
      }
      const p = v.entry;
      const dedup = p.kind + "|" + p.host + "|" + p.port + "|" + (p.username ?? "");
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      entries.push(p);
    }
    return new ProxyPool(entries, removed);
  }
}

// ===== 订阅解析 =====

interface SubCache {
  at: number; // epoch ms
  proxies: string[];
  skipped: number;
}

export function decodeSubscription(text: string): string[] {
  let content = text.trim();
  // 典型订阅是整段 Base64；无 "://" 且像 base64 时先解码
  if (!content.includes("://")) {
    try {
      const bin = atob(content.replace(/\s+/g, ""));
      if (bin.includes("://")) content = bin;
    } catch {
      // 不是 base64，按纯文本处理
    }
  }
  return content
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

export async function refreshSubscription(env: Env, url: string): Promise<SubCache | null> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "cf-vproxy/1.1" },
      signal: AbortSignal.timeout(SUB_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const lines = decodeSubscription(await resp.text());
    const proxies: string[] = [];
    let skipped = 0;
    for (const line of lines) {
      const v = classifyProxyLine(line); // https:// 及 vmess 等一律计入 skipped
      if (v.status === "ok") {
        proxies.push(v.entry.raw);
        if (proxies.length >= MAX_PROXIES) break;
      } else if (line.includes("://")) {
        skipped += 1;
      }
    }
    const cache: SubCache = { at: Date.now(), proxies, skipped };
    await env.VPROXY_KV.put(SUB_CACHE_KEY, JSON.stringify(cache));
    subMem = { at: Date.now(), cache }; // 拉取成功同步刷新内存缓存
    return cache;
  } catch {
    return null;
  }
}

// 订阅内存缓存（30s TTL；KV 读失败时回退旧值）与代理池解析缓存
const SUB_MEM_TTL_MS = 30_000;
let subMem: { at: number; cache: SubCache } | null = null;
let poolCache: { key: string; pool: ProxyPool } | null = null;

/** v1.8.0：读取 KV 订阅缓存的原始时间戳（epoch ms，无缓存/读失败返回 0）—— cron 判新鲜度用 */
export async function subscriptionCachedAt(env: Env): Promise<number> {
  try {
    const cache = (await env.VPROXY_KV.get(SUB_CACHE_KEY, "json")) as SubCache | null;
    return cache && typeof cache.at === "number" ? cache.at : 0;
  } catch {
    return 0;
  }
}

export async function resolveProxyPool(
  env: Env,
  cfg: VProxyConfig,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<ProxyPool> {
  const staticList = [...cfg.proxies];
  if (cfg.subscription) {
    const ttlMs = Math.max(5, cfg.subscription_refresh_minutes) * 60_000;
    let cache: SubCache | null = null;
    const memFresh = subMem !== null && Date.now() - subMem.at < Math.min(SUB_MEM_TTL_MS, ttlMs);
    if (memFresh) {
      cache = subMem!.cache; // 命中内存缓存：不再读 KV
    } else {
      let kvReadOk = true;
      try {
        cache = (await env.VPROXY_KV.get(SUB_CACHE_KEY, "json")) as SubCache | null;
      } catch {
        cache = null;
        kvReadOk = false;
      }
      if (cache) {
        subMem = { at: Date.now(), cache };
      } else if (!kvReadOk && subMem) {
        cache = subMem.cache; // KV 读失败：回退内存旧值（可用性优先）
      }
    }
    const fresh = cache && Date.now() - cache.at < ttlMs;
    if (!cache) {
      // 完全没有缓存：同步拉一次（首次请求略慢）
      const got = await refreshSubscription(env, cfg.subscription);
      if (got) staticList.push(...got.proxies);
    } else {
      staticList.push(...cache.proxies);
      if (!fresh) {
        // 过期：后台刷新，本次先用旧数据
        waitUntil(refreshSubscription(env, cfg.subscription));
      }
    }
  }
  // 代理池解析缓存：列表未变时直接复用（省去每请求的 parse + 去重 + 剔除）
  const poolKey = staticList.join("\n");
  if (poolCache && poolCache.key === poolKey) return poolCache.pool;
  const pool = ProxyPool.fromStrings(staticList);
  poolCache = { key: poolKey, pool };
  if (pool.removed.length > 0) {
    console.log("[proxy] auto-removed unsupported proxy links:", JSON.stringify(pool.removed));
  }
  return pool;
}

// ===== 单代理隧道 =====

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(msg)), ms);
  });
  // v2.4：败者善后 —— 超时先到时，p 稍后 reject（socket 已被关闭）会成为
  // unhandled rejection（workerd 会记入异常日志）。这里给 p 挂一个 no-op 吸收器。
  p.catch(() => {});
  return Promise.race([p, t]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function closeQuietly(sock: Socket | { close(): Promise<void> }): void {
  try {
    void sock.close();
  } catch {
    // ignore
  }
}

/** 经单个代理发起请求（HTTPS 上游）；signal 中止时立即关闭底层 socket（竞速败者清理用）。
 * v2.2：优先复用池内暖连接（跳过 TCP+代理握手+TLS 握手全部开销）；暖连接在「未收到
 * 任何响应字节」即失败时自动丢弃并冷路径重试一次（浏览器同款安全重试规则）。 */
export async function viaProxy(p: ProxyEntry, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  if (signal?.aborted) throw new Error("attempt aborted before connect");
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("viaProxy: only https upstream is supported");
  const targetHost = u.hostname;
  const targetPort = Number(u.port) || 443;
  const target = targetHost + ":" + targetPort;

  // ---- v2.2 暖连接优先 ----
  const warm = connPool.acquire(p.raw, target);
  if (warm) {
    let sawResponseBytes = false;
    const markBytes = () => {
      sawResponseBytes = true;
    };
    try {
      return await sendRequestOnConn(warm, url, init, signal, true, markBytes);
    } catch (err) {
      connPool.discard(warm);
      // 安全重试规则：请求已完整写出但未收到任何响应字节 → 请求大概率未被上游处理，
      // 重试不会造成重复副作用；收到过（哪怕不完整的）响应字节则必须上抛不重试。
      if (sawResponseBytes || warm.reader.buffered > 0 || signal?.aborted) throw err;
    }
  }
  if (signal?.aborted) throw new Error("attempt aborted before connect");
  return await viaProxyCold(p, url, init, targetHost, targetPort, target, signal);
}

/** v2.2：冷路径 —— 新建 TCP + 代理握手 + TLS 1.3 握手，成功后同样交给连接池管理 */
async function viaProxyCold(
  p: ProxyEntry,
  url: string,
  init: RequestInit,
  targetHost: string,
  targetPort: number,
  target: string,
  signal?: AbortSignal,
): Promise<Response> {
  // v2.0：纯 TCP（不再用 secureTransport:"starttls" —— startTls 已被 TLS 1.3 客户端替代）
  const sock = connect({ hostname: p.host, port: p.port });
  const onAbort = () => closeQuietly(sock);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await withTimeout(sock.opened, CONNECT_TIMEOUT_MS, "proxy connect timeout (" + p.host + ":" + p.port + ")");

    let hs: Awaited<ReturnType<typeof socks5Handshake>>;
    try {
      const io = { readable: sock.readable, writable: sock.writable };
      hs =
        p.kind === "socks5"
          ? await withTimeout(socks5Handshake(io, p, targetHost, targetPort), HANDSHAKE_TIMEOUT_MS, "socks5 handshake timeout")
          : p.kind === "socks4"
            ? await withTimeout(socks4Handshake(io, p, targetHost, targetPort), HANDSHAKE_TIMEOUT_MS, "socks4 handshake timeout")
            : await withTimeout(httpConnectHandshake(io, p, targetHost, targetPort), HANDSHAKE_TIMEOUT_MS, "http-proxy handshake timeout");
    } catch (err) {
      closeQuietly(sock); // 握手失败/超时：立即释放底层 socket
      throw err;
    }

    // v2.0（TLS Handshake Failed 根因修复）：
    //   边缘的 socket.startTls() 无法在承载过代理握手流量的 socket 上完成 TLS 升级
    //   （部署在真实边缘的诊断 Worker 分步实测 100% 复现；同一隧道上手写 ClientHello
    //   可正常收到 Google 的 ServerHello —— 字节层完全透明，仅 startTls 路径坏死）。
    //   因此弃用 startTls，改为在隧道字节流上直接运行纯 JS 实现的 TLS 1.3 客户端
    //   （X25519 + AES-128-GCM + HKDF 全部走 WebCrypto 原生算子；证书链固定 GTS 根 +
    //   SAN + CertificateVerify 完整校验，免费代理池中的 MITM 节点会被直接拒绝）。
    //   握手读写直接复用代理握手期的 reader/writer（残留缓冲字节不丢失），
    //   也不再需要 v1.9.0 的 releaseHandshake 释放锁逻辑。
    const tls = new Tls13Client(hs.reader, hs.writer, {
      serverName: targetHost,
      onClose: () => closeQuietly(sock),
    });
    try {
      await withTimeout(tls.handshake(), TLS13_HANDSHAKE_TIMEOUT_MS, "tls13 handshake timeout (" + p.host + ":" + p.port + ")");
    } catch (err) {
      // v2.3：带 PSK 的握手遭遇 alert/解密/Finished 校验类失败 → 票据大概率失效
      //（过期/轮换/状态失配），从会话缓存移除，后续冷连接直接回退完整握手，
      // 避免反复撞死票浪费一次竞速候选；纯网络类错误（超时/EOF）不动票据
      if (tls.pskOffered && err instanceof Error && /alert|bad_record_mac|Finished verify|decrypt/i.test(err.message)) {
        invalidateSessionTicket(targetHost);
      }
      closeQuietly(sock); // 超时时握手 promise 仍悬挂：必须显式关 socket（协议错误路径已由 tls.close→onClose 关闭）
      throw err;
    }
    const now = Date.now();
    const conn: PooledConn = {
      proxyRaw: p.raw,
      target,
      tls,
      reader: new ByteBufReader({
        read: () => tls.read().then((v) => (v === null ? { done: true, value: undefined } : { done: false, value: v })),
        releaseLock: () => {},
      }),
      writer: { write: (chunk: Uint8Array) => tls.write(chunk) },
      created: now,
      lastUsed: now,
      uses: 0,
    };
    return await sendRequestOnConn(conn, url, init, signal, false);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** v2.2：在已建立的 TLS 连接上发送 HTTP/1.1 请求并构造响应。
 * 响应体流完整消费后按「可复用判定」把连接归还 connPool；中途出错/取消则废弃连接。 */
async function sendRequestOnConn(
  conn: PooledConn,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  warm: boolean,
  markBytes?: () => void,
): Promise<Response> {
  const { tls, reader, writer } = conn;
  const onTlsAbort = () => tls.close();
  signal?.addEventListener("abort", onTlsAbort, { once: true });
  try {
    const headers: Record<string, string> = {};
    const inHeaders = new Headers(init.headers ?? {});
    inHeaders.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (["host", "content-length", "transfer-encoding", "connection", "keep-alive"].includes(lk)) return;
      headers[k] = v;
    });

    const bodyBytes = await encodeBody(init.body);
    await withTimeout(
      writeTunnelRequest(writer, { method: init.method ?? "GET", url, headers, body: bodyBytes }),
      CONNECT_TIMEOUT_MS,
      "write request timeout",
    );
    // 响应头：1xx 过渡响应跳过（未用 Expect: 100-continue，仅防御性兼容）
    // v2.4：等响应头加上限（见 RESPONSE_HEAD_TIMEOUT_MS 注释）—— 死隧道 120s 内
    // 必失败并进入健康度/冷却，而不是把请求与并发闸门名额永久占死。
    let head: ResponseHead;
    for (;;) {
      const headBlock = await withTimeout(
        reader.readHeaderBlock(),
        RESPONSE_HEAD_TIMEOUT_MS,
        "no response head within " + RESPONSE_HEAD_TIMEOUT_MS / 1000 + "s (dead tunnel?)",
      );
      markBytes?.();
      head = parseResponseHeadBlock(headBlock);
      if (head.status < 100 || head.status >= 200) break;
    }
    const method = init.method ?? "GET";
    const shape = isBodylessStatus(method, head.status)
      ? { chunked: false, contentLength: 0 }
      : determineBodyShape(head.headers);
    const allowsReuse = responseAllowsReuse(head) && (shape.chunked || shape.contentLength !== null);
    const outHeaders = new Headers();
    for (const [k, v] of Object.entries(head.headers)) {
      if (["content-length", "transfer-encoding", "connection", "keep-alive", "proxy-connection"].includes(k)) continue;
      outHeaders.set(k, v);
    }
    outHeaders.set("x-vproxy-conn", warm ? "warm" : "cold");

    let settled = false; // 防止 finish/cancel 双重触发导致连接被二次处置
    const cleanup = (bodyReusable: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onTlsAbort);
      const reusable = bodyReusable && allowsReuse && !signal?.aborted;
      connPool.release(conn, reusable);
    };
    const body = makeBodyStream(reader, shape, cleanup);
    return new Response(body, { status: head.status, statusText: head.reason, headers: outHeaders });
  } catch (err) {
    signal?.removeEventListener("abort", onTlsAbort);
    connPool.discard(conn);
    throw err;
  }
}

async function encodeBody(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  if (typeof body === "string") return TE.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  // ReadableStream / FormData / URLSearchParams 等场景：当前仅内部使用 string/Uint8Array
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** 管理端点/健康巡检用：测试单个代理连通性（对 Gemini API 发起 GET 探测）。
 * v2.2：探测目标改为 ?pageSize=1（响应体 ~1KB）并完整读取 —— 响应体精确消费后
 * 连接归还复用池，紧随其后的探测/业务请求即可暖连接命中（runs=2 连测即验证）。 */
export async function testProxy(proxyUrl: string, timeoutMs = 10_000): Promise<{ ok: boolean; latency_ms: number; error?: string; body_bytes?: number }> {
  const p = parseProxyUrl(proxyUrl);
  if (!p) return { ok: false, latency_ms: 0, error: "invalid proxy url" };
  const started = Date.now();
  try {
    const resp = await viaProxy(
      p,
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
      { method: "GET" },
      AbortSignal.timeout(timeoutMs),
    );
    const body = await resp.text(); // 完整消费 → 连接回池（复用判定生效）
    return { ok: resp.status < 500, latency_ms: Date.now() - started, error: resp.status >= 500 ? "HTTP " + resp.status : undefined, body_bytes: body.length };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 非流式整读工具（管理端点 / countTokens 用） */
export async function responseText(resp: Response): Promise<string> {
  return await resp.text();
}

export { readFullBody };
