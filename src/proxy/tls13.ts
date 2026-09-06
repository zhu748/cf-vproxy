// tls13.ts —— 纯 JS 实现的 TLS 1.3 (RFC 8446) 客户端，运行在代理隧道之上。
//
// 为什么需要它（v2.0 根因修复）：
//   Cloudflare Workers 边缘的 socket.startTls() 无法在「已承载代理握手流量」的 socket 上
//   完成 TLS 升级（100% 报 "TLS Handshake Failed."，与代理质量无关——已通过部署在真实边缘的
//   诊断 Worker 分步验证：同一隧道上手写 ClientHello 可收到 Google 的 ServerHello，字节层完全
//   透明；仅 startTls 的 TLS 升级路径坏死）。因此放弃 startTls，在原始隧道字节流上直接
//   实现 TLS 1.3：
//     - 密码套件：TLS_AES_128_GCM_SHA256（0x1301，唯一实现，Google 全线支持）
//     - 密钥交换：X25519（WebCrypto 原生）
//     - 证书校验：X.509 链式验证 + 信任锚 SPKI 固定（Google Trust Services 根证书）
//       + SAN 匹配 + 有效期 + CertificateVerify（防 MITM——免费代理池中实测存在大量
//       自签证书的中间人代理，校验不可省略）
//     - 记录层：AES-128-GCM（WebCrypto 原生，AAD=记录头，nonce=iv^seq）
//     - 握手后：NewSessionTicket 跳过 / KeyUpdate 重密钥 / close_notify 优雅关闭
//
// 纯 WebCrypto + 纯逻辑：不 import "cloudflare:sockets"，Node 24+ 可直接单测
// （crypto.subtle 全平台一致）。CPU 开销：握手约 3-8ms（X25519×2 + HKDF×~14 + AES-GCM×4 +
// 证书签名验签×2-3，均为原生算子），免费计划 10ms/请求 CPU 上限内可用；长流式响应按记录
// 增量解密（每 16KB 记录约 0.1ms）。
//
// 参考：RFC 8446（TLS 1.3）、RFC 5869（HKDF）、RFC 5280（X.509）。
import { ByteBufReader } from "./byteio.ts";

// ---------------------------------------------------------------------------
// 信任锚（固定公钥）：Google Trust Services 根证书 SPKI（DER，base64）。
// 来源：https://pki.goog/roots.pem（Google 官方发布的根证书仓库）。
// Google 前端服务的证书链终止于这些根（generativelanguage.googleapis.com 当前链：
// *.googleapis.com 叶子 ← WE1/WE2 中间 ← GTS Root R4，交叉签名变体同公钥）。
// 根证书更换频率约年级；若 Google 更换信任根导致校验失败，节点按失败处理并
// 走既有熔断/直连兜底，不影响可用性。可用 /admin 面板或改此常量更新。
// ---------------------------------------------------------------------------
const GTS_ROOT_SPKI_B64: readonly string[] = [
  // GTS Root R1 (RSA 4096)
  "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAthECix7joXebO9y/lD63ladAPKH9gvl9MgaCcfb2jH/76Nu8ai6Xl6OMS/kr9rH5zoQdsfnFl97vufKj6bwSiV6nqlKr+CMny6SxnGPb15l+8Ape62im9MZaRw1NEDPjTrETo8gYbEvs/AmQ351kKSUjB6G00j0uYODP0gmHu81I8E3CwnqIiru6z1kZ1q+PsAewnjHxgsHA3y6mbWwZDrXYfiYaRQM9sHmklCitD38m5agI/pboPGiUU+6DOogrFZYJsuB6jC511pzrp1Zkj5ZPaK49l8KEj8C8QMALXL32h7M1bKwYUH+E4EzNktMg6TO8UpmvMrUpsyUqtEj5cuHKZPfmghCN6J3Cioj6OGaK/GP5Afl4/Xtcd/p2h/rs37EOeZVXtL0m79YB0esWCruOC7XFxYpVq9Os6pFLKcwZpDIlTirxZUTQAs6qzkm06p98g7BAe+dDq6dso499iYH6TKX/1Y7DzkvgtdizjkXPdsDtQCv9Uw+wp9U7DbGKogPeMa3Md+pvez7W35EiEua++tgy/BBjFFFy3l3WFpO9KWgz7zpm7AeKJt8T11dleCfeXkkUAKIAf5qoIbapsZWwpbkNFhHax2xIPEDgfg1azVY80ZcFuctL7TlLnMQ/0lUTbiSw1nH69MG6zO0b9f6BQdgAmD06yK56mDcYBZUCAwEAAQ==",
  // GTS Root R2 (RSA 4096)
  "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAzt79pvvs7BQ0PAcGWmxZ9xk13ffBnVWq0807pJNy7wr6bZ328IWAW6FIUp85xbfuKKzvy3ZoFLnfrQFsmR/EIh2f/nJ34Cxbr+QEv09yoBo0mOg5aOyVJXt2oeZpuYUZvYmM/q3tNupzvP+D4st9wdLOSrONBZ6LSZPfwVvQbl7wLjAugvz6vLQXCkjliJvFm2vesMq0A/Da9JC4ZWT3XEyt6H5mXpnXuMI+yNATna3u5EV7iVX3ih9iUoQSs8JAl+OKH0eRpnRa0vixYygQuLMJuFZ3QKImmHnG/t8l7j7loH/UYQ9RSzw/jNrhcHTYwmih+cEM6aHif7tVPHYG7mpOzJKIME2avU8LSJqEtZij1ftzwVdh3ShWdROuh47nDFEJEHWITLyN+Xs81CJIHyrc62u7RLHLM3EyRq+tSvGM6HQ6rOcaInOA0jD3JULHIjs7Eq2WLsbDdgeqILc1SVfpkknodhZyMWcrln6Ko8eUViK/akt+ASGyIzLf5JpEbVlbXfUAoBybxniXjZD/m8iqtK8RUTle2ftnrdVbEZ0ymhu91bpbpcnLJWlTVSdc4Mo2y4hh+x630MvuFvvTpkzekqXU4t/1BlTeLp1LtJMwqoHO3RrcUXMNT3Dp5bYWIRl5suaJC3VkytWrvAnBGKH/1FShhTz9FCQDsofTpLcCAwEAAQ==",
  // GTS Root R3 (ECDSA P-384)
  "MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEH08zhzMpiqGE3svHIVhBiepWnStLhcYdTCe8fyZRcm/in9ajysxFFEaLre9+hozssX4v/6lxnRiERQRBVW4r6iZ/u5AB40sZuuRUlkUJsdVskUSthBOOmowNgAwy9uAn",
  // GTS Root R4 (ECDSA P-384)
  "MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE83Rzp2iLYK5DuDXFgTB7S0md+8FhzubeRr1r1WEYNa5A3XP3iZEwWus87oV8okB2O6nGuEfYKueSkWpz6bFyOZ8pn6KY019eWIZlD6GEZQbR3IvJx3PIjGov5cSr0R2K",
];

/** 展开为 Uint8Array（惰性缓存） */
let _anchors: Uint8Array[] | null = null;
function trustAnchors(): Uint8Array[] {
  if (!_anchors) {
    _anchors = GTS_ROOT_SPKI_B64.map((b64) => {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    });
  }
  return _anchors;
}

// ---------------------------------------------------------------------------
// 基础字节工具
// ---------------------------------------------------------------------------
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function u24(n: number): Uint8Array {
  return new Uint8Array([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// WebCrypto 基元
// ---------------------------------------------------------------------------
const te = new TextEncoder();

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer));
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw", key as unknown as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as unknown as ArrayBuffer));
}

/** HKDF-Extract(salt, ikm) = HMAC(salt, ikm) */
async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(salt, ikm);
}

/** HKDF-Expand(prk, info, len)（RFC 5869） */
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const blocks: Uint8Array[] = [];
  let t: Uint8Array = new Uint8Array(0);
  let i = 1;
  let total = 0;
  while (total < length) {
    t = await hmacSha256(prk, concatBytes([t, info, new Uint8Array([i++])]));
    blocks.push(t);
    total += t.length;
  }
  const out = new Uint8Array(length);
  let off = 0;
  for (const b of blocks) {
    const take = Math.min(b.length, length - off);
    out.set(b.subarray(0, take), off);
    off += take;
    if (off >= length) break;
  }
  return out;
}

/** RFC 8446 §7.1 HKDF-Expand-Label：HkdfLabel = u16(len) || "tls13 "+label || context */
export async function hkdfExpandLabel(
  secret: Uint8Array, label: string, context: Uint8Array, length: number,
): Promise<Uint8Array> {
  const full = te.encode("tls13 " + label);
  if (full.length > 255) throw new Error("tls13: label too long");
  const info = concatBytes([u16(length), new Uint8Array([full.length]), full, new Uint8Array([context.length]), context]);
  return hkdfExpand(secret, info, length);
}

// ---------------------------------------------------------------------------
// X.509 最小 DER 解析（只为证书链验证提取所需字段）
// ---------------------------------------------------------------------------
interface DerTlv {
  tag: number;
  /** 完整 TLV 字节（含 tag+len 头）——验签时的输入必须用这个 */
  full: Uint8Array;
  content: Uint8Array;
}

function derRead(buf: Uint8Array, pos: number): DerTlv | null {
  if (pos + 2 > buf.length) return null;
  const tag = buf[pos];
  let p = pos + 1;
  let len = 0;
  const first = buf[p++];
  if (first < 0x80) {
    len = first;
  } else {
    const n = first & 0x7f;
    if (n === 0 || n > 4 || p + n > buf.length) return null;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[p++];
  }
  if (p + len > buf.length) return null;
  return { tag, full: buf.slice(pos, p + len), content: buf.slice(p, p + len) };
}

function derOid(content: Uint8Array): string {
  if (content.length === 0) return "";
  const parts: string[] = [String(Math.floor(content[0] / 40)), String(content[0] % 40)];
  let v = 0;
  for (let i = 1; i < content.length; i++) {
    v = (v << 7) | (content[i] & 0x7f);
    if ((content[i] & 0x80) === 0) {
      parts.push(String(v));
      v = 0;
    }
  }
  return parts.join(".");
}

function parseTime(content: Uint8Array): number {
  // UTCTime YYMMDDHHMMSSZ / GeneralizedTime YYYYMMDDHHMMSSZ
  const s = new TextDecoder("latin1").decode(content).replace(/[^0-9]/g, "");
  const y4 = content[0] >= 0x30 && content[0] <= 0x39 && s.length === 14;
  let year: number, rest: string;
  if (y4) {
    year = Number(s.slice(0, 4));
    rest = s.slice(4);
  } else {
    const yy = Number(s.slice(0, 2));
    year = yy < 50 ? 2000 + yy : 1900 + yy;
    rest = s.slice(2);
  }
  const mo = Number(rest.slice(0, 2)) - 1;
  const d = Number(rest.slice(2, 4));
  const h = Number(rest.slice(4, 6));
  const mi = Number(rest.slice(6, 8));
  const sec = Number(rest.slice(8, 10));
  return Date.UTC(year, mo, d, h, mi, sec);
}

export interface ParsedCert {
  /** tbsCertificate 完整 DER（签名覆盖的内容） */
  tbs: Uint8Array;
  /** 证书签名算法 OID（点分） */
  sigAlgOid: string;
  /** RSA-PSS 参数（仅 OID 1.2.840.113549.1.1.10 时解析） */
  pssParams: { hashOid: string; mgfHashOid: string; saltLength: number } | null;
  /** 签名值（BIT STRING 内容，已去掉 unused-bits 字节） */
  signature: Uint8Array;
  /** SubjectPublicKeyInfo 完整 DER（可直接 importKey("spki")） */
  spki: Uint8Array;
  /** SPKI 算法 OID：1.2.840.10045.2.1 = EC；1.2.840.113549.1.1.1 = RSA */
  spkiAlgOid: string;
  /** EC 曲线 OID（仅 EC） */
  curveOid: string | null;
  /** SAN dNSName 列表 */
  sanDns: string[];
  notBefore: number;
  notAfter: number;
}

/** 解析 X.509 证书（只提取链验证所需字段；不校验完整性之外的字段） */
export function parseCertificate(der: Uint8Array): ParsedCert {
  const cert = derRead(der, 0);
  if (!cert || cert.tag !== 0x30) throw new Error("tls13/x509: not a certificate");
  let p = 0;
  const c = cert.content;
  const tbsTlv = derRead(c, p);
  if (!tbsTlv) throw new Error("tls13/x509: bad tbs");
  p += tbsTlv.full.length;
  const sigAlgTlv = derRead(c, p);
  if (!sigAlgTlv || sigAlgTlv.tag !== 0x30) throw new Error("tls13/x509: bad sigalg");
  p += sigAlgTlv.full.length;
  const sigTlv = derRead(c, p);
  if (!sigTlv || sigTlv.tag !== 0x03) throw new Error("tls13/x509: bad signature");
  // BIT STRING：第 1 字节为 unused bits（必须为 0）
  if (sigTlv.content.length < 1 || sigTlv.content[0] !== 0) throw new Error("tls13/x509: bad sig bits");
  const signature = sigTlv.content.slice(1);

  // sigAlg = SEQ { OID, params? }
  let sa = 0;
  const oidTlv = derRead(sigAlgTlv.content, sa);
  if (!oidTlv || oidTlv.tag !== 0x06) throw new Error("tls13/x509: bad sigalg oid");
  const sigAlgOid = derOid(oidTlv.content);
  sa += oidTlv.full.length;
  let pssParams: ParsedCert["pssParams"] = null;
  if (sigAlgOid === "1.2.840.113549.1.1.10") {
    // RSASSA-PSS: SEQ { hashOID, SEQ{mgfOID, mgfHashOID}, salt INT, trailer? }
    const params = derRead(sigAlgTlv.content, sa);
    if (params && params.tag === 0x30) {
      let q = 0;
      const hashT = derRead(params.content, q);
      if (hashT && hashT.tag === 0x06) {
        q += hashT.full.length;
        const mgfSeq = derRead(params.content, q);
        if (mgfSeq && mgfSeq.tag === 0x30) {
          const inner = derRead(mgfSeq.content, 0);
          const mgfHash = inner ? derRead(mgfSeq.content, inner.full.length) : null;
          const saltT = derRead(params.content, q + mgfSeq.full.length);
          let saltLength = 32;
          if (saltT && saltT.tag === 0x02 && saltT.content.length > 0) {
            saltLength = 0;
            for (const b of saltT.content) saltLength = (saltLength << 8) | b;
          }
          pssParams = {
            hashOid: derOid(hashT.content),
            mgfHashOid: mgfHash && mgfHash.tag === 0x06 ? derOid(mgfHash.content) : derOid(hashT.content),
            saltLength,
          };
        }
      }
    }
    if (!pssParams) pssParams = { hashOid: "2.16.840.1.101.3.4.2.1", mgfHashOid: "2.16.840.1.101.3.4.2.1", saltLength: 32 };
  }

  // ---- tbs 内部走查 ----
  const t = tbsTlv.content;
  let q = 0;
  // version [0] 可选
  const first = derRead(t, q);
  if (first && first.tag === 0xa0) q += first.full.length;
  const serial = derRead(t, q); // serialNumber INT
  if (serial) q += serial.full.length;
  const tbsSig = derRead(t, q); // signature AlgorithmID SEQ（与外层一致，跳过）
  if (tbsSig) q += tbsSig.full.length;
  const issuer = derRead(t, q); // issuer Name
  if (issuer) q += issuer.full.length;
  const validity = derRead(t, q); // validity SEQ { notBefore, notAfter }
  let notBefore = 0;
  let notAfter = 0;
  if (validity && validity.tag === 0x30) {
    const nb = derRead(validity.content, 0);
    const na = nb ? derRead(validity.content, nb.full.length) : null;
    if (nb) notBefore = parseTime(nb.content);
    if (na) notAfter = parseTime(na.content);
    q += validity.full.length;
  }
  const subject = derRead(t, q); // subject Name
  if (subject) q += subject.full.length;
  const spkiTlv = derRead(t, q); // SubjectPublicKeyInfo SEQ
  if (!spkiTlv || spkiTlv.tag !== 0x30) throw new Error("tls13/x509: bad spki");
  q += spkiTlv.full.length;
  // SPKI = SEQ { AlgorithmID SEQ{OID, params}, BIT STRING }
  let spkiAlgOid = "";
  let curveOid: string | null = null;
  const spkiAlg = derRead(spkiTlv.content, 0);
  if (spkiAlg && spkiAlg.tag === 0x30) {
    const algOidT = derRead(spkiAlg.content, 0);
    if (algOidT && algOidT.tag === 0x06) {
      spkiAlgOid = derOid(algOidT.content);
      if (spkiAlgOid === "1.2.840.10045.2.1") {
        const curveT = derRead(spkiAlg.content, algOidT.full.length);
        if (curveT && curveT.tag === 0x06) curveOid = derOid(curveT.content);
      }
    }
  }

  // 剩余：issuerUniqueID [1] / subjectUniqueID [2] / extensions [3]
  const sanDns: string[] = [];
  for (;;) {
    const e = derRead(t, q);
    if (!e) break;
    q += e.full.length;
    if (e.tag === 0xa3) {
      // extensions [3] EXPLICIT SEQ OF Extension
      const extSeq = derRead(e.content, 0);
      if (extSeq && extSeq.tag === 0x30) {
        let r = 0;
        for (;;) {
          const ext = derRead(extSeq.content, r);
          if (!ext) break;
          r += ext.full.length;
          if (ext.tag !== 0x30) continue;
          const oidT = derRead(ext.content, 0);
          if (!oidT || oidT.tag !== 0x06) continue;
          if (derOid(oidT.content) === "2.5.29.17") {
            // subjectAltName：可能是 (critical BOOL, OCTET STRING) 或直接 OCTET STRING
            let w = oidT.full.length;
            const maybeBool = derRead(ext.content, w);
            if (maybeBool && maybeBool.tag === 0x01) w += maybeBool.full.length;
            const valT = derRead(ext.content, w);
            if (valT && valT.tag === 0x04) {
              const gnSeq = derRead(valT.content, 0);
              if (gnSeq && gnSeq.tag === 0x30) {
                let g = 0;
                for (;;) {
                  const gn = derRead(gnSeq.content, g);
                  if (!gn) break;
                  g += gn.full.length;
                  if (gn.tag === 0x82) sanDns.push(new TextDecoder("latin1").decode(gn.content));
                }
              }
            }
          }
        }
      }
    }
  }

  return { tbs: tbsTlv.full, sigAlgOid, pssParams, signature, spki: spkiTlv.full, spkiAlgOid, curveOid, sanDns, notBefore, notAfter };
}

// ---------------------------------------------------------------------------
// SAN 匹配（RFC 6125 简化：精确匹配或最左单标签通配）
// ---------------------------------------------------------------------------
export function sanMatchesHost(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    if (!host.endsWith(suffix)) return false;
    const label = host.slice(0, host.length - suffix.length);
    return label.length > 0 && !label.includes(".");
  }
  return false;
}

// ---------------------------------------------------------------------------
// 证书签名验签（WebCrypto）
// ---------------------------------------------------------------------------
const HASH_BY_OID: Record<string, string> = {
  "2.16.840.1.101.3.4.2.1": "SHA-256",
  "2.16.840.1.101.3.4.2.2": "SHA-384",
  "2.16.840.1.101.3.4.2.3": "SHA-512",
};
const CURVE_BY_OID: Record<string, string> = {
  "1.2.840.10045.3.1.7": "P-256",
  "1.3.132.0.34": "P-384",
};

async function importVerifyKey(spki: Uint8Array, spkiAlgOid: string, curveOid: string | null, hash: string): Promise<CryptoKey> {
  if (spkiAlgOid === "1.2.840.10045.2.1") {
    const namedCurve = curveOid ? CURVE_BY_OID[curveOid] : undefined;
    if (!namedCurve) throw new Error("tls13/x509: unsupported EC curve");
    return crypto.subtle.importKey("spki", spki as unknown as ArrayBuffer, { name: "ECDSA", namedCurve }, false, ["verify"]);
  }
  if (spkiAlgOid === "1.2.840.113549.1.1.1") {
    return crypto.subtle.importKey("spki", spki as unknown as ArrayBuffer, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
  }
  throw new Error("tls13/x509: unsupported public key type " + spkiAlgOid);
}

/** DER ECDSA 签名（SEQ{r,s}）→ WebCrypto 需要的 raw r||s（定长） */
function derSigToRaw(signature: Uint8Array, elemLen: number): Uint8Array {
  const seq = derRead(signature, 0);
  if (!seq || seq.tag !== 0x30) throw new Error("tls13/x509: bad ecdsa sig");
  const rT = derRead(seq.content, 0);
  const sT = rT ? derRead(seq.content, rT.full.length) : null;
  if (!rT || !sT) throw new Error("tls13/x509: bad ecdsa sig parts");
  const out = new Uint8Array(elemLen * 2);
  // 去掉前导零
  const r = rT.content[0] === 0 ? rT.content.slice(1) : rT.content;
  const s = sT.content[0] === 0 ? sT.content.slice(1) : sT.content;
  out.set(r, elemLen - r.length);
  out.set(s, elemLen * 2 - s.length);
  return out;
}

async function verifySignature(
  message: Uint8Array, signature: Uint8Array, cert: ParsedCert, signer: ParsedCert,
): Promise<boolean> {
  const isPss = cert.sigAlgOid === "1.2.840.113549.1.1.10";
  if (cert.sigAlgOid === "1.2.840.10045.4.3.2" || cert.sigAlgOid === "1.2.840.10045.4.3.3" || cert.sigAlgOid === "1.2.840.10045.4.3.4") {
    // ECDSA with SHA-256/384/512
    const hash = cert.sigAlgOid === "1.2.840.10045.4.3.2" ? "SHA-256" : cert.sigAlgOid === "1.2.840.10045.4.3.3" ? "SHA-384" : "SHA-512";
    const key = await importVerifyKey(signer.spki, signer.spkiAlgOid, signer.curveOid, hash);
    const elemLen = signer.curveOid === "1.3.132.0.34" ? 48 : 32;
    const raw = derSigToRaw(signature, elemLen);
    return crypto.subtle.verify({ name: "ECDSA", hash }, key, raw as unknown as ArrayBuffer, message as unknown as ArrayBuffer);
  }
  if (isPss) {
    const pss = cert.pssParams!;
    const hash = HASH_BY_OID[pss.hashOid] ?? "SHA-256";
    const key = await crypto.subtle.importKey(
      "spki", signer.spki as unknown as ArrayBuffer, { name: "RSA-PSS", hash }, false, ["verify"],
    );
    return crypto.subtle.verify(
      { name: "RSA-PSS", saltLength: pss.saltLength },
      key, signature as unknown as ArrayBuffer, message as unknown as ArrayBuffer,
    );
  }
  const hash = cert.sigAlgOid === "1.2.840.113549.1.1.12" ? "SHA-384"
    : cert.sigAlgOid === "1.2.840.113549.1.1.13" ? "SHA-512" : "SHA-256";
  const key = await importVerifyKey(signer.spki, signer.spkiAlgOid, signer.curveOid, hash);
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, signature as unknown as ArrayBuffer, message as unknown as ArrayBuffer,
  );
}

/** HKDF-Expand-Label 的十六进制工具（链验签缓存键） */
function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

// ---------------------------------------------------------------------------
// v2.1 证书链验签缓存（isolate 级）：键 = 整链 DER 的 SHA-256 hex，值 = 结论有效期（epoch ms）。
// Google 的证书链在叶子证书 ~90 天生命周期内字节不变；同链重复验签（2-3 次非对称验签，
// 约 2-4ms CPU）是握手 CPU 大头，缓存后同 isolate 的后续握手直接跳过。
// ---------------------------------------------------------------------------
const CHAIN_CACHE_MAX = 32;
const chainVerifyCache = new Map<string, number>();

// ---------------------------------------------------------------------------
// 记录层加解密（AES-128-GCM，AAD=记录头 5 字节，nonce = iv XOR seq）
// ---------------------------------------------------------------------------
class TrafficKeys {
  key: CryptoKey | null = null;
  iv: Uint8Array = new Uint8Array(12);
  seq = 0;

  async install(secret: Uint8Array): Promise<void> {
    const keyBytes = await hkdfExpandLabel(secret, "key", new Uint8Array(0), 16);
    this.iv = await hkdfExpandLabel(secret, "iv", new Uint8Array(0), 12);
    this.key = await crypto.subtle.importKey(
      "raw", keyBytes as unknown as ArrayBuffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"],
    );
    this.seq = 0;
  }

  nonce(): Uint8Array {
    const n = new Uint8Array(12);
    n.set(this.iv);
    let s = this.seq;
    for (let i = 11; i >= 4; i--) {
      n[i] ^= s & 0xff;
      s = Math.floor(s / 256);
    }
    return n;
  }
}

const REC_HDR = 5;
const MAX_RECORD = 16_384; // 明文上限（2^14）

export interface Tls13Options {
  /** SNI / 证书校验主机名 */
  serverName: string;
  /** 信任锚 SPKI DER 列表；默认 GTS 根 */
  trustAnchors?: Uint8Array[];
  /** 关闭底层连接的回调（中止/清理用） */
  onClose?: () => void;
}

/** TLS 1.3 客户端：构造于「已完成代理握手」的隧道字节流之上。 */
export class Tls13Client {
  private reader: ByteBufReader;
  private writer: { write(chunk: Uint8Array): Promise<void> };
  private opts: Tls13Options;
  private cKeys = new TrafficKeys();
  private sKeys = new TrafficKeys();
  private cSecretApp: Uint8Array | null = null;
  private sSecretApp: Uint8Array | null = null;
  /** 握手消息原始字节（含 4 字节头），按序累计，用于 transcript hash */
  private transcript: Uint8Array[] = [];
  /** 握手期解密后的握手消息缓冲（跨记录重组） */
  private hsBuf: Uint8Array = new Uint8Array(0);
  private serverKeysInstalled = false;
  private clientKeysInstalled = false;
  private appPhase = false;
  private closed = false;
  private peerClosed = false;
  /** post-handshake 消息缓冲（NST/KU 跨记录重组） */
  private postBuf: Uint8Array = new Uint8Array(0);

  constructor(reader: ByteBufReader, writer: { write(chunk: Uint8Array): Promise<void> }, opts: Tls13Options) {
    this.reader = reader;
    this.writer = writer;
    this.opts = opts;
  }

  /** v2.2：连接是否已关闭（连接池存活判定用） */
  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.opts.onClose?.();
    } catch {
      // ignore
    }
  }

  private fail(msg: string): never {
    this.close();
    throw new Error("tls13: " + msg);
  }

  // ---- 记录读写 ----

  private async readPlainRecord(): Promise<{ type: number; payload: Uint8Array }> {
    const head = await this.reader.readExact(REC_HDR);
    const len = (head[3] << 8) | head[4]; // [type(1)][version(2)][length(2)]
    if (len > MAX_RECORD + 256) this.fail("record too large: " + len);
    const payload = await this.reader.readExact(len);
    return { type: head[0], payload };
  }

  /** 读一条记录并解密（应用/握手密钥阶段） */
  private async readRecord(): Promise<{ type: number; payload: Uint8Array; inner: number }> {
    const head = await this.reader.readExact(REC_HDR);
    const len = (head[3] << 8) | head[4]; // [type(1)][version(2)][length(2)]
    if (len > MAX_RECORD + 256) this.fail("record too large: " + len);
    const body = await this.reader.readExact(len);
    const type = head[0];
    if (type === 0x14) return { type: 0x14, payload: new Uint8Array(0), inner: 0x14 }; // ChangeCipherSpec：跳过
    if (type === 0x15) {
      // 明文 alert（握手早期）
      if (body.length >= 2) {
        const code = body[1];
        if (code === 0) {
          this.peerClosed = true;
          return { type: 0x15, payload: body, inner: 0 };
        }
        this.fail("server alert: level " + body[0] + " code " + code);
      }
      this.fail("truncated alert");
    }
    if (type !== 0x16 && type !== 0x17) this.fail("unexpected record type " + type);
    if (!this.serverKeysInstalled) {
      if (type !== 0x16) this.fail("app data before keys installed");
      return { type, payload: body, inner: type };
    }
    if (type === 0x16) this.fail("plaintext handshake after keys installed");
    if (!this.sKeys.key) this.fail("no server keys");
    const nonce = this.sKeys.nonce();
    const aad = head;
    let plain: Uint8Array;
    try {
      plain = new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as unknown as ArrayBuffer, additionalData: aad as unknown as ArrayBuffer, tagLength: 128 },
        this.sKeys.key, body as unknown as ArrayBuffer,
      ));
    } catch {
      this.fail("record AEAD decryption failed (bad_record_mac)");
    }
    this.sKeys.seq++;
    // 去尾部零填充，末字节为真实内容类型
    let end = plain.length - 1;
    while (end > 0 && plain[end] === 0) end--;
    const innerType = plain[end];
    const payload = plain.slice(0, end);
    return { type, payload, inner: innerType };
  }

  /** 发送一条加密记录（握手 innerType=22 / 应用数据 innerType=23） */
  private async writeRecord(innerType: number, payload: Uint8Array): Promise<void> {
    if (!this.cKeys.key) this.fail("write before client keys installed");
    const inner = concatBytes([payload, new Uint8Array([innerType])]);
    const len = inner.length + 16;
    const head = new Uint8Array([0x17, 0x03, 0x03, (len >> 8) & 0xff, len & 0xff]);
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: this.cKeys.nonce() as unknown as ArrayBuffer, additionalData: head as unknown as ArrayBuffer, tagLength: 128 },
      this.cKeys.key, inner as unknown as ArrayBuffer,
    ));
    this.cKeys.seq++;
    await this.writer.write(concatBytes([head, ct]));
  }

  /** v2.1：批量发送加密记录 —— 多条记录并行加密（预计算 nonce）后合并为单次底层写。
   * 大请求体（如 1MB = 64 条记录）从「64 轮串行 encrypt→await write」变为
   * 「64 个并行 encrypt + 1 次写」：省去 63 次 await 往返与逐条写带来的 TCP 小包。
   * 分批上限 256 条（约 4MB 密文）以约束峰值内存。 */
  private async writeRecordsBatch(innerType: number, payloads: Uint8Array[]): Promise<void> {
    if (!this.cKeys.key) this.fail("write before client keys installed");
    // map 回调同步执行：先按当前 seq 逐条预取 nonce（每条递增），再并行加密
    const parts = await Promise.all(payloads.map((payload) => {
      const nonce = this.cKeys.nonce();
      this.cKeys.seq++;
      const inner = concatBytes([payload, new Uint8Array([innerType])]);
      const len = inner.length + 16;
      const head = new Uint8Array([0x17, 0x03, 0x03, (len >> 8) & 0xff, len & 0xff]);
      return crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce as unknown as ArrayBuffer, additionalData: head as unknown as ArrayBuffer, tagLength: 128 },
        this.cKeys.key!, inner as unknown as ArrayBuffer,
      ).then((ct) => concatBytes([head, new Uint8Array(ct)]));
    }));
    await this.writer.write(concatBytes(parts));
  }

  // ---- 握手消息重组 ----

  private feedHsBuf(data: Uint8Array): void {
    this.hsBuf = this.hsBuf.length === 0 ? data : concatBytes([this.hsBuf, data]);
  }

  private nextHsMessage(): { type: number; body: Uint8Array; raw: Uint8Array } | null {
    if (this.hsBuf.length < 4) return null;
    const type = this.hsBuf[0];
    const len = (this.hsBuf[1] << 16) | (this.hsBuf[2] << 8) | this.hsBuf[3];
    if (this.hsBuf.length < 4 + len) return null;
    const raw = this.hsBuf.slice(0, 4 + len);
    const body = this.hsBuf.slice(4, 4 + len);
    this.hsBuf = this.hsBuf.slice(4 + len);
    return { type, body, raw };
  }

  private async transcriptHash(): Promise<Uint8Array> {
    return sha256(concatBytes(this.transcript));
  }

  // ---- 握手 ----

  async handshake(): Promise<void> {
    if (this.closed) throw new Error("tls13: already closed");
    // 1. ClientHello
    const x25519 = (await crypto.subtle.generateKey(
      { name: "X25519" } as unknown as { name: string }, false, ["deriveBits"],
    )) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
    const clientPub = new Uint8Array((await crypto.subtle.exportKey("raw", x25519.publicKey)) as unknown as ArrayBuffer);
    const sessionId = crypto.getRandomValues(new Uint8Array(32));
    const chBody = this.buildClientHello(clientPub, sessionId);
    const chRaw = concatBytes([new Uint8Array([1]), u24(chBody.length), chBody]);
    this.transcript.push(chRaw);
    const chHead = new Uint8Array([0x16, 0x03, 0x01, (chRaw.length >> 8) & 0xff, chRaw.length & 0xff]);
    await this.writer.write(concatBytes([chHead, chRaw]));

    // 2. ServerHello（明文）
    let sh: { type: number; body: Uint8Array } | null = null;
    for (;;) {
      const rec = await this.readPlainRecord();
      if (rec.type === 0x14) continue; // CCS 兼容
      if (rec.type !== 0x16) this.fail("expected ServerHello, got record type " + rec.type);
      sh = { type: 0, body: rec.payload };
      break;
    }
    if (!sh) this.fail("no ServerHello received");
    // ServerHello 记录载荷 = 完整握手消息（含 4 字节头：type=2 + len24）
    if (sh.body[0] !== 2) this.fail("expected ServerHello message type 2, got " + sh.body[0]);
    const shRaw = sh.body;
    this.transcript.push(shRaw);
    const shMsg = parseServerHello(sh.body.slice(4));
    if (shMsg.helloRetry) this.fail("HelloRetryRequest not supported");
    if (shMsg.cipher !== 0x1301) this.fail("server picked unsupported cipher 0x" + shMsg.cipher.toString(16));
    if (!shMsg.serverKeyShare || shMsg.serverKeyShare.group !== 0x001d) this.fail("no x25519 key_share from server");
    if (!shMsg.tls13) this.fail("server did not negotiate TLS 1.3");

    // 3. 密钥推导（HKDF-SHA256，RFC 8446 §7.1）
    const serverPubKey = await crypto.subtle.importKey(
      "raw", shMsg.serverKeyShare.key as unknown as ArrayBuffer, { name: "X25519" } as unknown as { name: string }, false, [],
    );
    const shared = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "X25519", public: serverPubKey } as unknown as { name: string }, x25519.privateKey, 256,
    ));
    const zeros32 = new Uint8Array(32);
    // v2.1 优化：早期密钥调度与 transcript 哈希相互独立，并行执行
    // （th1 只依赖 CH..SH；early/derived/hs 链只依赖 shared secret）
    const [emptyHash, th1, earlySecret] = await Promise.all([
      sha256(new Uint8Array(0)),
      this.transcriptHash(),
      hkdfExtract(zeros32, zeros32),
    ]);
    const derived1 = await hkdfExpandLabel(earlySecret, "derived", emptyHash, 32);
    const hsSecret = await hkdfExtract(derived1, shared);
    // v2.1 优化：c/s 握手流量密钥推导并行 + 两套 TrafficKeys 安装并行
    const [cHs, sHs] = await Promise.all([
      hkdfExpandLabel(hsSecret, "c hs traffic", th1, 32),
      hkdfExpandLabel(hsSecret, "s hs traffic", th1, 32),
    ]);
    await Promise.all([this.cKeys.install(cHs), this.sKeys.install(sHs)]);
    this.serverKeysInstalled = true;
    this.clientKeysInstalled = true;

    // 4. 服务端加密飞行段：EncryptedExtensions / Certificate / CertificateVerify / Finished
    let ee: Uint8Array | null = null;
    let certMsg: { type: number; body: Uint8Array; raw: Uint8Array } | null = null;
    let cvMsg: { type: number; body: Uint8Array; raw: Uint8Array } | null = null;
    let sfMsg: { type: number; body: Uint8Array; raw: Uint8Array } | null = null;
    // transcript 前缀长度：CV 验签用 CH..Cert；server Finished 验签用 CH..CV；应用密钥用 CH..SF
    let transcriptLenBeforeCv = 0;
    let transcriptLenBeforeSf = 0;
    for (;;) {
      const rec = await this.readRecord();
      if (rec.type === 0x14) continue;
      if (rec.inner !== 0x16) {
        if (rec.inner === 0x17) this.fail("unexpected app data during handshake");
        if (rec.inner === 0x15) {
          if (rec.payload.length >= 2 && rec.payload[1] === 0) { this.peerClosed = true; this.fail("close_notify during handshake"); }
          this.fail("alert during handshake: code " + (rec.payload[1] ?? -1));
        }
        this.fail("unexpected inner type " + rec.inner + " during handshake");
      }
      this.feedHsBuf(rec.payload);
      for (;;) {
        const m = this.nextHsMessage();
        if (!m) break;
        if (m.type === 8 && !ee) {
          ee = m.raw;
          this.transcript.push(m.raw);
        } else if (m.type === 11 && !certMsg) {
          certMsg = m;
          this.transcript.push(m.raw);
        } else if (m.type === 15 && !cvMsg) {
          transcriptLenBeforeCv = this.transcript.length;
          cvMsg = m;
          this.transcript.push(m.raw);
        } else if (m.type === 20 && !sfMsg) {
          transcriptLenBeforeSf = this.transcript.length;
          sfMsg = m;
          this.transcript.push(m.raw);
        } else {
          this.fail("unexpected handshake message type " + m.type);
        }
        if (ee && certMsg && cvMsg && sfMsg) break;
      }
      if (ee && certMsg && cvMsg && sfMsg) break;
    }
    if (!ee || !certMsg || !cvMsg || !sfMsg) this.fail("incomplete server flight");

    // 5. 证书链校验 + CertificateVerify + Finished
    // v2.1 优化：链验签与 transcript 哈希/CV 内容构造完全独立，整体并行执行
    const cvAlg = (cvMsg.body[0] << 8) | cvMsg.body[1];
    const cvSigLen = (cvMsg.body[2] << 8) | cvMsg.body[3];
    const cvSig = cvMsg.body.slice(4, 4 + cvSigLen);
    const certs = parseTlsCertificate(certMsg.body);
    if (certs.length < 1) this.fail("empty certificate chain");
    const leaf = parseCertificate(certs[0]);
    const emptyU8 = new Uint8Array(0);
    // v2.1 优化：链验签与 transcript 哈希/finished 密钥推导完全独立，并行执行
    const [, thCV, thSF, sFinKey] = await Promise.all([
      this.validateChain(certs, leaf),
      sha256(concatBytes(this.transcript.slice(0, transcriptLenBeforeCv))), // CH..Certificate
      sha256(concatBytes(this.transcript.slice(0, transcriptLenBeforeSf))), // CH..CV
      hkdfExpandLabel(sHs, "finished", emptyU8, 32),
    ]);
    const cvContent = concatBytes([
      new Uint8Array(64).fill(0x20),
      te.encode("TLS 1.3, server CertificateVerify"),
      new Uint8Array([0]),
      thCV,
    ]);
    // v2.1 优化：CV 验签与 SF HMAC 并行
    const [cvOk, sfVerify] = await Promise.all([
      this.verifyTlsSignature(cvContent, cvSig, cvAlg, leaf),
      hmacSha256(sFinKey, thSF),
    ]);
    if (!cvOk) this.fail("CertificateVerify signature invalid (possible MITM)");
    const sfData = sfMsg.body.slice(0, 32);
    if (!eqBytes(sfVerify, sfData)) this.fail("server Finished verify_data mismatch");

    // 6. 应用密钥 + 客户端 Finished
    // v2.1 优化：derived2 与 th3 并行；三个应用期推导并行
    const [derived2, th3] = await Promise.all([
      hkdfExpandLabel(hsSecret, "derived", emptyHash, 32),
      sha256(concatBytes(this.transcript)), // CH..server Finished（含 SF）
    ]);
    const masterSecret = await hkdfExtract(derived2, zeros32);
    const [cAp, sAp, cFinKey] = await Promise.all([
      hkdfExpandLabel(masterSecret, "c ap traffic", th3, 32),
      hkdfExpandLabel(masterSecret, "s ap traffic", th3, 32),
      hkdfExpandLabel(cHs, "finished", new Uint8Array(0), 32),
    ]);
    const cfData = await hmacSha256(cFinKey, th3);
    const cfRaw = concatBytes([new Uint8Array([20]), u24(cfData.length), cfData]);
    await this.writeRecord(0x16, cfRaw); // 客户端 Finished（c_hs 密钥；必须在 install 覆盖 cKeys 之前完成）
    this.transcript.push(cfRaw);

    // v2.1 优化：两套应用密钥安装并行
    await Promise.all([this.cKeys.install(cAp), this.sKeys.install(sAp)]);
    this.cSecretApp = cAp;
    this.sSecretApp = sAp;
    this.appPhase = true;
  }

  // ---- 应用数据 ----

  /** 写应用数据（自动按 16KB 分片；v2.1：多分片并行加密 + 批量写） */
  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed || this.peerClosed) throw new Error("tls13: connection closed");
    if (!this.appPhase) throw new Error("tls13: handshake not completed");
    if (bytes.length <= MAX_RECORD) {
      await this.writeRecord(0x17, bytes);
      return;
    }
    const chunks: Uint8Array[] = [];
    for (let off = 0; off < bytes.length; off += MAX_RECORD) {
      chunks.push(bytes.slice(off, off + MAX_RECORD));
    }
    const BATCH = 256; // ≈4MB 密文/批，约束峰值内存
    for (let i = 0; i < chunks.length; i += BATCH) {
      await this.writeRecordsBatch(0x17, chunks.slice(i, i + BATCH));
    }
  }

  /** 读下一段应用数据（close_notify / EOF 返回 null） */
  async read(): Promise<Uint8Array | null> {
    if (this.peerClosed || this.closed) return null;
    let rec;
    try {
      rec = await this.readRecord();
    } catch (e) {
      // 对端不带 close_notify 直接关 TCP（免费代理/Connection:close 常见）→ 视作 EOF
      if (e instanceof Error && /EOF while reading/.test(e.message)) {
        this.peerClosed = true;
        return null;
      }
      throw e;
    }
    if (rec.type === 0x14) {
      return this.read();
    }
    if (rec.inner === 0x17) return rec.payload;
    if (rec.inner === 0x15) {
      if (rec.payload.length >= 2 && rec.payload[1] === 0) {
        this.peerClosed = true;
        return null;
      }
      this.fail("server alert code " + (rec.payload[1] ?? -1));
    }
    if (rec.inner === 0x16) {
      // post-handshake 握手消息：NewSessionTicket(4) 跳过；KeyUpdate(24) 重密钥
      let buf = this.postBuf.length === 0 ? rec.payload : concatBytes([this.postBuf, rec.payload]);
      this.postBuf = new Uint8Array(0);
      for (;;) {
        const m = parseHsFrame(buf);
        if (!m) break;
        buf = m.rest;
        if (m.type === 4) {
          continue; // NewSessionTicket：跳过
        }
        if (m.type === 24) {
          await this.applyKeyUpdate(m.body);
          continue;
        }
        this.fail("unexpected post-handshake message type " + m.type);
      }
      this.postBuf = buf; // 不完整帧留给下一条 0x16 记录续接
      return this.read();
    }
    this.fail("unexpected inner type " + rec.inner);
  }

  private async applyKeyUpdate(body: Uint8Array): Promise<void> {
    // request_update: 0 = update_not_requested, 1 = update_requested
    const requested = body.length > 0 && body[0] === 1;
    if (this.sSecretApp) {
      const next = await hkdfExpandLabel(this.sSecretApp, "traffic upd", new Uint8Array(0), 32);
      this.sSecretApp = next;
      await this.sKeys.install(next);
    }
    if (requested && this.cSecretApp) {
      const next = await hkdfExpandLabel(this.cSecretApp, "traffic upd", new Uint8Array(0), 32);
      // 先发我方 KeyUpdate（旧密钥），再切换
      await this.writeRecord(0x16, concatBytes([new Uint8Array([24]), u24(1), new Uint8Array([0])]));
      this.cSecretApp = next;
      await this.cKeys.install(next);
    }
  }

  // ---- 构造 ClientHello ----

  private buildClientHello(clientPub: Uint8Array, sessionId: Uint8Array): Uint8Array {
    const host = te.encode(this.opts.serverName);
    const sniData = new Uint8Array(2 + 1 + 2 + host.length);
    const listLen = 1 + 2 + host.length;
    sniData[0] = listLen >> 8;
    sniData[1] = listLen & 0xff;
    sniData[2] = 0;
    sniData[3] = host.length >> 8;
    sniData[4] = host.length & 0xff;
    sniData.set(host, 5);
    const groupsData = new Uint8Array([0x00, 0x02, 0x00, 0x1d]); // x25519
    const sigAlgs = new Uint8Array([
      0x08, 0x04, 0x08, 0x05, 0x08, 0x06, // rsa_pss_rsae_256/384/512
      0x04, 0x03, 0x05, 0x03, // ecdsa_p256/384
      0x04, 0x01, 0x05, 0x01, 0x06, 0x01, // rsa_pkcs1_256/384/512
    ]);
    const sigAlgsData = concatBytes([u16(sigAlgs.length), sigAlgs]);
    const versionsData = new Uint8Array([0x02, 0x03, 0x04]); // 1 字节数量 + 0x0304
    // KeyShareClientHello: client_shares<0..2^16-1>（u16 向量长度）+ entry(group + keylen + key)
    const keyShareData = concatBytes([u16(2 + 2 + clientPub.length), u16(0x001d), u16(clientPub.length), clientPub]);
    const exts: Array<[number, number, Uint8Array]> = [
      [0x00, 0x00, sniData],
      [0x00, 0x0a, groupsData],
      [0x00, 0x0d, sigAlgsData],
      [0x00, 0x2b, versionsData],
      [0x00, 0x33, keyShareData],
    ];
    let extsLen = 0;
    for (const [, , d] of exts) extsLen += 4 + d.length;
    const extsBlock = new Uint8Array(2 + extsLen);
    extsBlock[0] = extsLen >> 8;
    extsBlock[1] = extsLen & 0xff;
    let off = 2;
    for (const [t1, t2, d] of exts) {
      extsBlock[off++] = t1;
      extsBlock[off++] = t2;
      extsBlock[off++] = d.length >> 8;
      extsBlock[off++] = d.length & 0xff;
      extsBlock.set(d, off);
      off += d.length;
    }
    const body = new Uint8Array(2 + 32 + 1 + sessionId.length + 2 + 2 + 1 + 1 + extsBlock.length);
    let p = 0;
    body[p++] = 0x03;
    body[p++] = 0x03;
    crypto.getRandomValues(body.subarray(p, p + 32));
    p += 32;
    body[p++] = sessionId.length;
    body.set(sessionId, p);
    p += sessionId.length;
    body[p++] = 0x00;
    body[p++] = 0x02; // cipher_suites 长度（字节）
    body[p++] = 0x13;
    body[p++] = 0x01; // TLS_AES_128_GCM_SHA256
    body[p++] = 0x01; // 压缩方法数
    body[p++] = 0x00; // null
    body.set(extsBlock, p);
    return body;
  }

  // ---- 证书链校验 ----

  // v2.1：isolate 级证书链验签缓存。
  // 上游（Google）整条证书链数月不变（叶子证书有效期约 90 天），而链签名验证
  // （leaf←intermediate 的 RSA-PSS + intermediate←root 的 ECDSA/RSA，共 2-3 次非对称
  // 验签）是握手 CPU 的大头（约 2-4ms）。同一 isolate 内重复握手时按「整链 DER 的
  // SHA-256」缓存链签名+锚定结论：字节完全相同的链必然得出相同结论（签名与锚定
  // 均只由证书内容决定）；SAN 匹配与有效期（时间相关）仍每次校验。
  // 缓存条目随叶子证书 notAfter 过期自动失效，并设 24h 上限做卫生截断；容量 32 条
  // （Map 插入序即 LRU 语义，超容先删最旧）。
  private async validateChain(certs: Uint8Array[], leaf: ParsedCert): Promise<void> {
    // 1) SAN + 有效期
    let sanOk = false;
    for (const dns of leaf.sanDns) {
      if (sanMatchesHost(dns, this.opts.serverName)) {
        sanOk = true;
        break;
      }
    }
    if (!sanOk) this.fail("certificate SAN does not cover " + this.opts.serverName + " (got: " + leaf.sanDns.join(", ") + ")");
    const now = Date.now();
    if (now < leaf.notBefore - 5 * 60_000 || now > leaf.notAfter) {
      this.fail("certificate expired or not yet valid");
    }
    // 2) 缓存命中：跳过链签名 + 锚定（结论只由证书字节决定，重复计算纯属浪费）
    const cacheKey = toHex(await sha256(concatBytes(certs)));
    const cached = chainVerifyCache.get(cacheKey);
    const validUntil = Math.min(leaf.notAfter, now + 24 * 3600_000);
    if (cached && now < cached) {
      return;
    }
    // 3) 逐级验签：certs[i] 由 certs[i+1] 签发 —— 各级验证相互独立，并行执行
    const parsed = certs.map((c) => parseCertificate(c));
    const linkOks = await Promise.all(
      parsed.slice(0, -1).map((cert, i) => verifySignature(cert.tbs, cert.signature, cert, parsed[i + 1])),
    );
    for (let i = 0; i < linkOks.length; i++) {
      if (!linkOks[i]) this.fail("certificate signature verification failed at chain index " + i);
    }
    // 4) 信任锚：链尾 SPKI 直接命中；或链尾证书的签名可由锚公钥验过
    //    （覆盖「服务器只送 leaf+intermediate、不带根」和「带交叉签名根」两种链形态）
    const anchors = this.opts.trustAnchors ?? trustAnchors();
    const last = parsed[parsed.length - 1];
    let anchored = false;
    for (const a of anchors) {
      if (eqBytes(a, last.spki)) {
        anchored = true;
        break;
      }
    }
    if (!anchored) {
      // v2.1：各锚的验签尝试相互独立，并行执行
      const anchorOks = await Promise.all(
        anchors.map(async (a) => {
          const anchorInfo = parseSpki(a);
          const signer: ParsedCert = { ...last, spki: a, spkiAlgOid: anchorInfo.spkiAlgOid, curveOid: anchorInfo.curveOid };
          try {
            return await verifySignature(last.tbs, last.signature, last, signer);
          } catch {
            return false; // 该锚不适用，尝试下一个
          }
        }),
      );
      anchored = anchorOks.some((ok) => ok);
    }
    if (!anchored) this.fail("certificate chain does not terminate at a pinned trust anchor");
    // 5) 写入缓存（容量控制：插入序 LRU）
    if (chainVerifyCache.size >= CHAIN_CACHE_MAX) {
      const oldest = chainVerifyCache.keys().next().value;
      if (oldest !== undefined) chainVerifyCache.delete(oldest);
    }
    chainVerifyCache.set(cacheKey, validUntil);
  }

  private async verifyTlsSignature(
    content: Uint8Array, sig: Uint8Array, alg: number, leaf: ParsedCert,
  ): Promise<boolean> {
    try {
      if (alg === 0x0403 || alg === 0x0503) {
        const hash = alg === 0x0403 ? "SHA-256" : "SHA-384";
        const key = await importVerifyKey(leaf.spki, leaf.spkiAlgOid, leaf.curveOid, hash);
        const elemLen = leaf.curveOid === "1.3.132.0.34" ? 48 : 32;
        const raw = derSigToRaw(sig, elemLen);
        return crypto.subtle.verify({ name: "ECDSA", hash }, key, raw as unknown as ArrayBuffer, content as unknown as ArrayBuffer);
      }
      if (alg >= 0x0804 && alg <= 0x0806) {
        const hash = alg === 0x0804 ? "SHA-256" : alg === 0x0805 ? "SHA-384" : "SHA-512";
        const saltLength = alg === 0x0804 ? 32 : alg === 0x0805 ? 48 : 64;
        const key = await crypto.subtle.importKey(
          "spki", leaf.spki as unknown as ArrayBuffer, { name: "RSA-PSS", hash }, false, ["verify"],
        );
        return crypto.subtle.verify(
          { name: "RSA-PSS", saltLength }, key, sig as unknown as ArrayBuffer, content as unknown as ArrayBuffer,
        );
      }
      if (alg === 0x0401 || alg === 0x0501 || alg === 0x0601) {
        const hash = alg === 0x0401 ? "SHA-256" : alg === 0x0501 ? "SHA-384" : "SHA-512";
        const key = await importVerifyKey(leaf.spki, leaf.spkiAlgOid, leaf.curveOid, hash);
        return crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5", key, sig as unknown as ArrayBuffer, content as unknown as ArrayBuffer,
        );
      }
      return false;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// 辅助解析函数
// ---------------------------------------------------------------------------

interface ServerHelloInfo {
  tls13: boolean;
  cipher: number;
  helloRetry: boolean;
  serverKeyShare: { group: number; key: Uint8Array } | null;
}

function parseServerHello(body: Uint8Array): ServerHelloInfo {
  const HRR_RANDOM = [0xcf, 0x21, 0xad, 0x74, 0xe5, 0x9a, 0x61, 0x11, 0xbe, 0x1d, 0x8c, 0x02, 0x1e, 0x65, 0xb8, 0x91, 0xc2, 0xa2, 0x11, 0x16, 0x7a, 0xbb, 0x8c, 0x5e, 0x07, 0x9e, 0x09, 0xe2, 0xc8, 0xa8, 0x33, 0x9c];
  let p = 0;
  const legacyVersion = (body[p] << 8) | body[p + 1];
  p += 2;
  const random = body.slice(p, p + 32);
  p += 32;
  const sidLen = body[p++];
  p += sidLen;
  const cipher = (body[p] << 8) | body[p + 1];
  p += 2;
  p += 1; // compression
  const extsLen = (body[p] << 8) | body[p + 1];
  p += 2;
  const extsEnd = p + extsLen;
  let tls13 = false;
  let serverKeyShare: { group: number; key: Uint8Array } | null = null;
  const helloRetry = eqBytes(random, new Uint8Array(HRR_RANDOM));
  while (p + 4 <= extsEnd) {
    const et = (body[p] << 8) | body[p + 1];
    const el = (body[p + 2] << 8) | body[p + 3];
    p += 4;
    const ed = body.slice(p, p + el);
    p += el;
    if (et === 0x002b) {
      // ServerHello 的 supported_versions = selected_version（2 字节，无长度前缀）
      if (ed.length >= 2 && ed[0] === 0x03 && ed[1] === 0x04) tls13 = true;
    } else if (et === 0x0033) {
      // key_share：2 字节组 + 2 字节长度 + key
      if (ed.length >= 4) {
        const group = (ed[0] << 8) | ed[1];
        const klen = (ed[2] << 8) | ed[3];
        serverKeyShare = { group, key: ed.slice(4, 4 + klen) };
      }
    }
  }
  void legacyVersion;
  return { tls13, cipher, helloRetry, serverKeyShare };
}

/** TLS Certificate 消息 body → DER 证书数组
 * 结构：ctx(1+len) + certificate_list 向量长度(3) + N × entry{ cert_data_len(3) + cert + ext_len(2) + exts } */
function parseTlsCertificate(body: Uint8Array): Uint8Array[] {
  let p = 0;
  const ctxLen = body[p++];
  p += ctxLen;
  if (p + 3 > body.length) throw new Error("tls13: certificate message truncated (list header)");
  const listLen = (body[p] << 16) | (body[p + 1] << 8) | body[p + 2];
  p += 3;
  const listEnd = Math.min(p + listLen, body.length);
  const certs: Uint8Array[] = [];
  while (p + 3 <= listEnd) {
    const len = (body[p] << 16) | (body[p + 1] << 8) | body[p + 2];
    p += 3;
    const cert = body.slice(p, p + len);
    p += len;
    if (p + 2 > listEnd) {
      certs.push(cert);
      break;
    }
    const extLen = (body[p] << 8) | body[p + 1];
    p += 2 + extLen;
    certs.push(cert);
  }
  return certs;
}

function parseHsFrame(buf: Uint8Array): { type: number; body: Uint8Array; rest: Uint8Array } | null {
  if (buf.length < 4) return null;
  const type = buf[0];
  const len = (buf[1] << 16) | (buf[2] << 8) | buf[3];
  if (buf.length < 4 + len) return null;
  return { type, body: buf.slice(4, 4 + len), rest: buf.slice(4 + len) };
}

/** 解析 SPKI DER → 算法 OID / 曲线 OID（信任锚公钥类型识别） */
function parseSpki(spki: Uint8Array): { spkiAlgOid: string; curveOid: string | null } {
  const seq = derRead(spki, 0);
  if (!seq || seq.tag !== 0x30) return { spkiAlgOid: "", curveOid: null };
  const alg = derRead(seq.content, 0);
  if (!alg || alg.tag !== 0x30) return { spkiAlgOid: "", curveOid: null };
  const oidT = derRead(alg.content, 0);
  if (!oidT || oidT.tag !== 0x06) return { spkiAlgOid: "", curveOid: null };
  const spkiAlgOid = derOid(oidT.content);
  let curveOid: string | null = null;
  if (spkiAlgOid === "1.2.840.10045.2.1") {
    const curveT = derRead(alg.content, oidT.full.length);
    if (curveT && curveT.tag === 0x06) curveOid = derOid(curveT.content);
  }
  return { spkiAlgOid, curveOid };
}
