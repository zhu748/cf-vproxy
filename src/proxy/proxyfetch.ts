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
import { classifyProxyLine, parseProxyUrl, type ProxyEntry } from "./frames.ts";
import {
  determineBodyShape,
  makeBodyStream,
  parseResponseHeadBlock,
  readFullBody,
  writeTunnelRequest,
} from "./httpclient.ts";
import { httpConnectHandshake, socks4Handshake, socks5Handshake } from "./tunnel.ts";

const SUB_CACHE_KEY = "proxy_cache";
const MAX_PROXIES = 200;
const CONNECT_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

export class ProxyPool {
  constructor(
    readonly entries: ProxyEntry[],
    readonly removed: Array<{ raw: string; reason: string }> = [],
  ) {}

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
      signal: AbortSignal.timeout(10_000),
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
    return cache;
  } catch {
    return null;
  }
}

export async function resolveProxyPool(
  env: Env,
  cfg: VProxyConfig,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<ProxyPool> {
  const staticList = [...cfg.proxies];
  let subSkipped = 0;
  if (cfg.subscription) {
    const ttlMs = Math.max(5, cfg.subscription_refresh_minutes) * 60_000;
    let cache: SubCache | null = null;
    try {
      cache = (await env.VPROXY_KV.get(SUB_CACHE_KEY, "json")) as SubCache | null;
    } catch {
      cache = null;
    }
    const fresh = cache && Date.now() - cache.at < ttlMs;
    if (!cache) {
      // 完全没有缓存：同步拉一次（首次请求略慢）
      const got = await refreshSubscription(env, cfg.subscription);
      if (got) {
        staticList.push(...got.proxies);
        subSkipped = got.skipped;
      }
    } else {
      staticList.push(...cache.proxies);
      subSkipped = cache.skipped;
      if (!fresh) {
        // 过期：后台刷新，本次先用旧数据
        waitUntil(refreshSubscription(env, cfg.subscription));
      }
    }
  }
  void subSkipped;
  const pool = ProxyPool.fromStrings(staticList);
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

/** 经单个代理发起请求（HTTPS 上游）；signal 中止时立即关闭底层 socket（竞速败者清理用） */
export async function viaProxy(p: ProxyEntry, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  if (signal?.aborted) throw new Error("attempt aborted before connect");
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("viaProxy: only https upstream is supported");
  const targetHost = u.hostname;
  const targetPort = Number(u.port) || 443;

  const sock = connect({ hostname: p.host, port: p.port }, { secureTransport: "starttls" } as SocketOptions);
  const onAbort = () => closeQuietly(sock);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await viaProxyInner(p, url, init, sock, targetHost, targetPort, signal);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function viaProxyInner(
  p: ProxyEntry,
  url: string,
  init: RequestInit,
  sock: Socket,
  targetHost: string,
  targetPort: number,
  signal?: AbortSignal,
): Promise<Response> {
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
    closeQuietly(sock);
    throw err;
  }
  void hs.reader.release();

  const tlsSock = sock.startTls({ expectedServerHostname: targetHost });
  const onTlsAbort = () => closeQuietly(tlsSock);
  signal?.addEventListener("abort", onTlsAbort, { once: true });
  const writer = tlsSock.writable.getWriter();
  const reader = new ByteBufReader(tlsSock.readable.getReader());

  const headers: Record<string, string> = {};
  const inHeaders = new Headers(init.headers ?? {});
  inHeaders.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (["host", "content-length", "transfer-encoding", "connection", "keep-alive"].includes(lk)) return;
    headers[k] = v;
  });

  const bodyBytes = await encodeBody(init.body);
  try {
    await withTimeout(
      writeTunnelRequest(writer, { method: init.method ?? "GET", url, headers, body: bodyBytes }),
      CONNECT_TIMEOUT_MS,
      "write request timeout",
    );
    const headBlock = await reader.readHeaderBlock();
    const head = parseResponseHeadBlock(headBlock);
    const shape = determineBodyShape(head.headers);
    const outHeaders = new Headers();
    for (const [k, v] of Object.entries(head.headers)) {
      if (["content-length", "transfer-encoding", "connection", "keep-alive"].includes(k)) continue;
      outHeaders.set(k, v);
    }
    const cleanup = () => {
      signal?.removeEventListener("abort", onTlsAbort);
      closeQuietly(tlsSock);
    };
    const body = makeBodyStream(reader, shape, cleanup);
    return new Response(body, { status: head.status, statusText: head.reason, headers: outHeaders });
  } catch (err) {
    signal?.removeEventListener("abort", onTlsAbort);
    closeQuietly(tlsSock);
    throw err;
  }
}

async function encodeBody(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  // ReadableStream / FormData / URLSearchParams 等场景：当前仅内部使用 string/Uint8Array
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** 管理端点用：测试单个代理连通性（对 Gemini API 发起 GET 探测） */
export async function testProxy(proxyUrl: string): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const p = parseProxyUrl(proxyUrl);
  if (!p) return { ok: false, latency_ms: 0, error: "invalid proxy url" };
  const started = Date.now();
  try {
    const resp = await viaProxy(p, "https://generativelanguage.googleapis.com/v1beta/models", { method: "GET" });
    await resp.body?.cancel();
    return { ok: resp.status < 500, latency_ms: Date.now() - started, error: resp.status >= 500 ? "HTTP " + resp.status : undefined };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 非流式整读工具（管理端点 / countTokens 用） */
export async function responseText(resp: Response): Promise<string> {
  return await resp.text();
}

export { readFullBody };
