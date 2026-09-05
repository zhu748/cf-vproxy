// SOCKS4/4a、SOCKS5 与 HTTP CONNECT 协议帧的纯构造/解析函数 —— 无任何平台依赖，全部可单测。
// ⚠️ Workers 的 startTls 不支持 TLS-in-TLS，因此 https:// 代理一律不支持 ——
//    通过 classifyProxyLine() 在入口处自动剔除并说明原因，不会流入运行时。

// ===== SOCKS5 =====

export const SOCKS5_VER = 0x05;

export type SocksAuthMethod = 0x00 | 0x02; // 0x00 无认证 / 0x02 用户名密码

/** 构造方法协商帧：[VER, NMETHODS, METHODS...] */
export function buildSocks5Greeting(auth: SocksAuthMethod | null): Uint8Array {
  if (auth === null) return new Uint8Array([SOCKS5_VER, 1, 0x00]);
  return new Uint8Array([SOCKS5_VER, 2, 0x00, auth]);
}

/** 解析方法协商应答：[VER, METHOD] */
export function parseSocks5MethodReply(
  buf: Uint8Array,
): { value: { ver: number; method: number }; consumed: number } | null {
  if (buf.length < 2) return null;
  return { value: { ver: buf[0], method: buf[1] }, consumed: 2 };
}

/** 构造 RFC 1929 用户名密码子协商帧：[0x01, ULEN, U..., PLEN, P...] */
export function buildSocks5AuthRequest(username: string, password: string): Uint8Array {
  const enc = new TextEncoder();
  const u = enc.encode(username);
  const p = enc.encode(password);
  if (u.length > 255 || p.length > 255) throw new Error("socks5: username/password too long (max 255 bytes)");
  const out = new Uint8Array(3 + u.length + p.length);
  let off = 0;
  out[off++] = 0x01;
  out[off++] = u.length;
  out.set(u, off);
  off += u.length;
  out[off++] = p.length;
  out.set(p, off);
  return out;
}

/** 解析认证应答：[0x01, STATUS] */
export function parseSocks5AuthReply(
  buf: Uint8Array,
): { value: { status: number }; consumed: number } | null {
  if (buf.length < 2) return null;
  return { value: { status: buf[1] }, consumed: 2 };
}

/** 构造 CONNECT 请求：[VER,CMD=1,RSV,ATYP=3(域名),LEN,HOST...,PORT_HI,PORT_LO]
 *  始终发送域名（ATYP=3），由代理侧负责 DNS 解析（等价 socks5h 语义）。 */
export function buildSocks5ConnectRequest(host: string, port: number): Uint8Array {
  const enc = new TextEncoder();
  const h = enc.encode(host);
  if (h.length > 255) throw new Error("socks5: host too long");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("socks5: bad port " + port);
  const out = new Uint8Array(7 + h.length);
  out[0] = SOCKS5_VER;
  out[1] = 0x01; // CONNECT
  out[2] = 0x00; // RSV
  out[3] = 0x03; // ATYP: domain
  out[4] = h.length;
  out.set(h, 5);
  out[5 + h.length] = (port >> 8) & 0xff;
  out[6 + h.length] = port & 0xff;
  return out;
}

/** 解析 CONNECT 应答（变长）：[VER,REP,RSV,ATYP,ADDR...,PORT] */
export function parseSocks5ConnectReply(
  buf: Uint8Array,
): { value: { ver: number; rep: number }; consumed: number } | null {
  if (buf.length < 4) return null;
  const atyp = buf[3];
  let addrLen: number;
  if (atyp === 0x01) addrLen = 4; // IPv4
  else if (atyp === 0x03) addrLen = 1 + buf[4]; // domain（若长度字节还没到会误判，见下方长度保护）
  else if (atyp === 0x04) addrLen = 16; // IPv6
  else return { value: { ver: buf[0], rep: 0x08 }, consumed: 4 }; // 未知 ATYP，按失败处理
  const need = 4 + addrLen + 2;
  if (atyp === 0x03 && buf.length < 5) return null; // 域名长度字节未到达
  if (buf.length < need) return null;
  return { value: { ver: buf[0], rep: buf[1] }, consumed: need };
}

export function socks5RepMessage(rep: number): string {
  switch (rep) {
    case 0:
      return "succeeded";
    case 1:
      return "general SOCKS server failure";
    case 2:
      return "connection not allowed by ruleset";
    case 3:
      return "network unreachable";
    case 4:
      return "host unreachable";
    case 5:
      return "connection refused";
    case 6:
      return "TTL expired";
    case 7:
      return "command not supported";
    case 8:
      return "address type not supported";
    default:
      return "unknown reply " + rep;
  }
}

// ===== SOCKS4 / SOCKS4a =====

export const SOCKS4_VER = 0x04;

/** 判定 host 是否为点分 IPv4；是则返回 4 字节，否则 null */
function ipv4ToBytes(host: string): Uint8Array | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((n) => !Number.isInteger(n) || n > 255)) return null;
  return new Uint8Array(parts);
}

/**
 * 构造 SOCKS4 CONNECT 请求：
 *   - 目标是 IPv4 → 纯 SOCKS4 帧：[0x04,0x01,PORT,IP,USERID,0x00]
 *   - 目标是域名 → SOCKS4a 扩展帧：IP 用不可路由占位 0.0.0.1，
 *     USERID 后跟 NUL + 域名 + NUL（现代 SOCKS4 代理普遍支持 4a；
 *     仅支持纯 4 的老代理无法解析域名，会返回失败并由故障接力处理）。
 * SOCKS4 只有 userid 无密码：URL 中 user:pass 的 pass 会被忽略。
 */
export function buildSocks4ConnectRequest(host: string, port: number, userId?: string): Uint8Array {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("socks4: bad port " + port);
  const uid = new TextEncoder().encode(userId ?? "");
  const ip = ipv4ToBytes(host);
  if (ip) {
    const out = new Uint8Array(9 + uid.length);
    out[0] = SOCKS4_VER;
    out[1] = 0x01; // CONNECT
    out[2] = (port >> 8) & 0xff;
    out[3] = port & 0xff;
    out.set(ip, 4);
    out.set(uid, 8);
    out[8 + uid.length] = 0x00;
    return out;
  }
  const h = new TextEncoder().encode(host);
  if (h.length > 255) throw new Error("socks4a: host too long");
  const out = new Uint8Array(9 + uid.length + 1 + h.length + 1);
  let off = 0;
  out[off++] = SOCKS4_VER;
  out[off++] = 0x01;
  out[off++] = (port >> 8) & 0xff;
  out[off++] = port & 0xff;
  out[off++] = 0;
  out[off++] = 0;
  out[off++] = 0;
  out[off++] = 1; // 0.0.0.1 → 4a 标记
  out.set(uid, off);
  off += uid.length;
  out[off++] = 0x00;
  out.set(h, off);
  off += h.length;
  out[off] = 0x00;
  return out;
}

/** 解析 SOCKS4 CONNECT 应答（定长 8 字节）：[VN,REP,PORT(2),IP(4)] */
export function parseSocks4ConnectReply(
  buf: Uint8Array,
): { value: { rep: number }; consumed: 8 } | null {
  if (buf.length < 8) return null;
  // RFC 规定 VN=0x00，个别实现回显 0x04，两者都兼容；其它版本号按失败处理
  if (buf[0] !== 0x00 && buf[0] !== SOCKS4_VER) {
    return { value: { rep: 0xff }, consumed: 8 };
  }
  return { value: { rep: buf[1] }, consumed: 8 };
}

export function socks4RepMessage(rep: number): string {
  switch (rep) {
    case 0x5a:
      return "request granted";
    case 0x5b:
      return "request rejected or failed";
    case 0x5c:
      return "request rejected: identd not running on client";
    case 0x5d:
      return "request rejected: identd could not confirm the user id";
    default:
      return "unknown reply 0x" + rep.toString(16);
  }
}

// ===== HTTP CONNECT =====

/** 构造 CONNECT 请求头块（含 Proxy-Authorization 可选） */
export function buildHttpConnectRequest(host: string, port: number, username?: string, password?: string): Uint8Array {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("http-proxy: bad port " + port);
  let head =
    "CONNECT " + host + ":" + port + " HTTP/1.1\r\n" + "Host: " + host + ":" + port + "\r\n";
  if (username !== undefined) {
    const cred = btoa(username + ":" + (password ?? ""));
    head += "Proxy-Authorization: Basic " + cred + "\r\n";
  }
  head += "User-Agent: cf-vproxy\r\n" + "Proxy-Connection: keep-alive\r\n" + "\r\n";
  return new TextEncoder().encode(head);
}

/** 解析 CONNECT 应答头块，返回 {ok, status, reason} */
export function parseHttpConnectReply(block: Uint8Array): { ok: boolean; status: number; reason: string } {
  const text = new TextDecoder().decode(block);
  const lineEnd = text.indexOf("\n");
  const statusLine = (lineEnd >= 0 ? text.slice(0, lineEnd) : text).trim();
  const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (!m) return { ok: false, status: 0, reason: "malformed proxy response: " + statusLine };
  const status = Number(m[1]);
  const reason = (m[2] ?? "").trim();
  return { ok: status >= 200 && status < 300, status, reason: reason || "proxy CONNECT failed" };
}

// ===== 工具 =====

export type ProxyKind = "socks4" | "socks5" | "http";

/** 解析代理 URL → 结构化条目（socks4/socks4a/socks5/socks5h/socks/http；https 不支持，由 classifyProxyLine 报告） */
export interface ProxyEntry {
  kind: ProxyKind;
  host: string;
  port: number;
  username?: string;
  password?: string;
  raw: string;
}

export const SUPPORTED_SCHEMES = ["socks4", "socks4a", "socks5", "socks5h", "socks", "http"] as const;

export function parseProxyUrl(input: string): ProxyEntry | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "socks5://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(":", "").toLowerCase();
  let kind: ProxyKind | null = null;
  if (scheme === "socks5" || scheme === "socks5h" || scheme === "socks") kind = "socks5";
  else if (scheme === "socks4" || scheme === "socks4a") kind = "socks4";
  else if (scheme === "http") kind = "http";
  if (!kind) return null;
  const host = u.hostname;
  const port = u.port ? Number(u.port) : kind === "http" ? 80 : 1080;
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const username = u.username ? decodeURIComponent(u.username) : undefined;
  const password = u.password ? decodeURIComponent(u.password) : undefined;
  return { kind, host, port, username, password, raw: s };
}

// ===== 入口分类：自动剔除 Workers 不支持的代理链接 =====

export type ProxyLineVerdict =
  | { status: "ok"; entry: ProxyEntry }
  | { status: "unsupported"; reason: string };

/**
 * 对一行代理配置做分类：
 *   - 可用 → { status:"ok", entry }
 *   - https:// → 剔除（Workers 无法 TLS-in-TLS）
 *   - vmess/vless/ss/trojan 等 → 剔除
 *   - 无法解析 / 空行 → 剔除
 */
export function classifyProxyLine(input: string): ProxyLineVerdict {
  const s = input.trim();
  if (!s) return { status: "unsupported", reason: "空行" };
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  const scheme = (m ? m[1] : "socks5").toLowerCase();
  if (scheme === "https" || scheme === "tls" || scheme === "ssl") {
    return {
      status: "unsupported",
      reason: "https 代理在 Workers 上不可用（无法 TLS-in-TLS），已自动剔除",
    };
  }
  if (!SUPPORTED_SCHEMES.includes(scheme as (typeof SUPPORTED_SCHEMES)[number])) {
    return { status: "unsupported", reason: "不支持的协议 " + scheme + "://" };
  }
  const entry = parseProxyUrl(s);
  if (!entry) return { status: "unsupported", reason: "无法解析（缺少 host/port 或端口非法）" };
  return { status: "ok", entry };
}

/** 批量清洗代理列表：剔除不支持条目并去重，返回保留列表 + 剔除明细 */
export function cleanProxyList(list: string[]): {
  kept: string[];
  removed: Array<{ raw: string; reason: string }>;
} {
  const kept: string[] = [];
  const seen = new Set<string>();
  const removed: Array<{ raw: string; reason: string }> = [];
  for (const line of list) {
    const s = line.trim();
    if (!s) continue;
    const v = classifyProxyLine(s);
    if (v.status !== "ok") {
      removed.push({ raw: s, reason: v.reason });
      continue;
    }
    const dedup = v.entry.kind + "|" + v.entry.host + "|" + v.entry.port + "|" + (v.entry.username ?? "");
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    kept.push(v.entry.raw);
  }
  return { kept, removed };
}
