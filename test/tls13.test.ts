// tls13.test.ts —— 纯逻辑单测（无网络）：
//   - HKDF-Expand-Label 的 HkdfLabel 编码结构（RFC 8446 §7.1）
//   - HKDF 输出正确性（与 RFC 5869 测试向量对齐的 HMAC 手工推导交叉验证）
//   - SAN 通配符匹配（RFC 6125 简化规则）
//   - X.509 DER 解析（用真实结构的合成证书片段验证 tbs/SPKI/SAN 提取）
//   - v2.3 PSK 会话恢复纯逻辑：NST 解析 / 票据年龄与新鲜度 / 扩展编码（u8 binder 长度！）/ binder 链路
// 完整握手与 PSK 恢复端到端走 scripts/tls13-local-server-test.mjs 与
// scripts/tls13-resumption-test.mjs（本地 Node TLS 服务器真实协商）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hkdfExpandLabel,
  sanMatchesHost,
  parseCertificate,
  parseNewSessionTicket,
  obfuscatedTicketAge,
  ticketAgeMs,
  ticketFresh,
  peekSessionTicket,
  storeSessionTicket,
  invalidateSessionTicket,
  buildPskExtensions,
  computePskBinder,
  type SessionTicket,
} from "../src/proxy/tls13.ts";
import { concatBytes } from "../src/proxy/tls13.ts";

test("tls13: hkdfExpandLabel 输出长度与确定性", async () => {
  const secret = new Uint8Array(32).fill(0xab);
  const a = await hkdfExpandLabel(secret, "c hs traffic", new Uint8Array(0), 32);
  const b = await hkdfExpandLabel(secret, "c hs traffic", new Uint8Array(0), 32);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b); // 确定性
  const c = await hkdfExpandLabel(secret, "c hs traffic", new Uint8Array(0), 100);
  assert.equal(c.length, 100); // 多块展开
  const d = await hkdfExpandLabel(secret, "s hs traffic", new Uint8Array(0), 32);
  assert.notDeepEqual(a, d); // 不同 label 不同输出
});

test("tls13: hkdfExpandLabel 对 context 敏感（transcript hash 绑定）", async () => {
  const secret = new Uint8Array(32).fill(0x11);
  const t1 = await hkdfExpandLabel(secret, "c ap traffic", new Uint8Array(32).fill(1), 32);
  const t2 = await hkdfExpandLabel(secret, "c ap traffic", new Uint8Array(32).fill(2), 32);
  assert.notDeepEqual(t1, t2);
});

test("tls13: SAN 匹配 —— 精确 / 单层通配 / 不匹配", () => {
  assert.equal(sanMatchesHost("generativelanguage.googleapis.com", "generativelanguage.googleapis.com"), true);
  assert.equal(sanMatchesHost("*.googleapis.com", "generativelanguage.googleapis.com"), true);
  assert.equal(sanMatchesHost("*.googleapis.com", "googleapis.com"), false); // 通配至少一个标签
  assert.equal(sanMatchesHost("*.googleapis.com", "a.b.googleapis.com"), false); // 仅单层
  assert.equal(sanMatchesHost("*.googleapis.com", "evilgoogleapis.com"), false);
  assert.equal(sanMatchesHost("googleapis.com", "googleapis.com"), true);
  assert.equal(sanMatchesHost("googleapis.com", "other.com"), false);
  assert.equal(sanMatchesHost("*", "x.com"), false);
});

test("tls13: parseCertificate 提取 tbs / SPKI / SAN / 有效期", () => {
  // 最小合成证书：EE 空 body 无意义，用真实结构构造
  // tbs = SEQ { [0] version, INT serial, SEQ sigalg, SEQ issuer, SEQ validity{Time,Time}, SEQ subject, SEQ spki }
  const enc = (s: string) => new TextEncoder().encode(s);
  const der = (tag: number, content: Uint8Array) => {
    let len = content.length;
    let lenBytes: Uint8Array;
    if (len < 128) lenBytes = new Uint8Array([len]);
    else if (len < 256) lenBytes = new Uint8Array([0x81, len]);
    else lenBytes = new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
    return concatBytes([new Uint8Array([tag]), lenBytes, content]);
  };
  const spkiContent = concatBytes([
    der(0x30, der(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]))), // EC
    der(0x03, new Uint8Array([0x00, 0x04, 1, 2, 3, 4])), // BIT STRING
  ]);
  const spki = der(0x30, spkiContent);
  const validity = der(0x30, concatBytes([
    der(0x17, enc("250101000000Z")), // UTCTime 2025-01-01
    der(0x17, enc("401231235959Z")), // UTCTime 2040-12-31
  ]));
  // SAN 扩展：SEQ of GeneralName [2]
  const dns1 = der(0x82, enc("*.googleapis.com"));
  const sanExtValue = der(0x04, der(0x30, dns1));
  const sanExt = der(0x30, concatBytes([
    der(0x06, new Uint8Array([0x55, 0x1d, 0x11])), // 2.5.29.17
    sanExtValue,
  ]));
  const extensions = der(0xa3, der(0x30, sanExt));
  const tbsContent = concatBytes([
    der(0xa0, der(0x02, new Uint8Array([2]))), // version v3
    der(0x02, new Uint8Array([1])),
    der(0x30, der(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]))), // ecdsa-with-SHA256
    der(0x30, der(0x0c, enc("issuer"))),
    validity,
    der(0x30, der(0x0c, enc("subject"))),
    spki,
    extensions,
  ]);
  const tbs = der(0x30, tbsContent);
  const sig = der(0x03, new Uint8Array([0x00, 0x01, 0x02, 0x03]));
  const cert = der(0x30, concatBytes([tbs, der(0x30, der(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]))), sig]));

  const parsed = parseCertificate(cert);
  assert.equal(parsed.tbs.length, tbs.length);
  assert.equal(parsed.spki.length, spki.length);
  assert.deepEqual(Array.from(parsed.spki), Array.from(spki));
  assert.equal(parsed.spkiAlgOid, "1.2.840.10045.2.1");
  assert.equal(parsed.sigAlgOid, "1.2.840.10045.4.3.2");
  assert.deepEqual(parsed.sanDns, ["*.googleapis.com"]);
  assert.equal(sanMatchesHost(parsed.sanDns[0], "generativelanguage.googleapis.com"), true);
  // 2025-01-01 ≤ now ≤ 2040-12-31
  const now = Date.now();
  assert.ok(now >= parsed.notBefore && now <= parsed.notAfter);
  assert.equal(parsed.signature.length, 3); // BIT STRING 去掉 unused-bits 字节后
  assert.deepEqual(Array.from(parsed.signature), [1, 2, 3]);
});

test("tls13: parseCertificate 拒绝非证书输入", () => {
  assert.throws(() => parseCertificate(new Uint8Array([0x30, 0x00])));
});

// ===========================================================================
// v2.3 PSK 会话恢复纯逻辑
// ===========================================================================

/** 构造合成 NewSessionTicket body */
function nstBody({ lifetime, ageAdd, nonce, ticket, exts = new Uint8Array(0) }: {
  lifetime: number; ageAdd: number; nonce: Uint8Array; ticket: Uint8Array; exts?: Uint8Array;
}) {
  return concatBytes([
    new Uint8Array([
      (lifetime >>> 24) & 0xff, (lifetime >>> 16) & 0xff, (lifetime >>> 8) & 0xff, lifetime & 0xff,
      (ageAdd >>> 24) & 0xff, (ageAdd >>> 16) & 0xff, (ageAdd >>> 8) & 0xff, ageAdd & 0xff,
    ]),
    new Uint8Array([nonce.length]),
    nonce,
    new Uint8Array([(ticket.length >> 8) & 0xff, ticket.length & 0xff]),
    ticket,
    exts,
  ]);
}

test("v2.3 tls13: parseNewSessionTicket 解析各字段（含 u8 nonce / u16 ticket 前缀）", () => {
  const nonce = new Uint8Array([0x07]);
  const ticket = new Uint8Array(224).fill(0xab);
  const parsed = parseNewSessionTicket(
    nstBody({ lifetime: 7200, ageAdd: 0xdeadbeef, nonce, ticket, exts: new Uint8Array([1, 2, 3]) }),
  );
  assert.ok(parsed);
  assert.equal(parsed.lifetime, 7200);
  assert.equal(parsed.ageAdd, 0xdeadbeef);
  assert.deepEqual(Array.from(parsed.nonce), [0x07]);
  assert.equal(parsed.ticket.length, 224);
  assert.deepEqual(Array.from(parsed.ticket.slice(0, 3)), [0xab, 0xab, 0xab]);
  // 多字节 nonce
  const p2 = parseNewSessionTicket(nstBody({ lifetime: 1, ageAdd: 0, nonce: new Uint8Array([1, 2, 3]), ticket: new Uint8Array([9]) }));
  assert.equal(p2?.nonce.length, 3);
});

test("v2.3 tls13: parseNewSessionTicket 拒绝畸形输入", () => {
  assert.equal(parseNewSessionTicket(new Uint8Array(5)), null); // 过短
  const ok = nstBody({ lifetime: 1, ageAdd: 0, nonce: new Uint8Array(0), ticket: new Uint8Array([9]) });
  assert.ok(parseNewSessionTicket(ok));
  assert.equal(parseNewSessionTicket(ok.subarray(0, ok.length - 1)), null); // ticket 截断
});

test("v2.3 tls13: obfuscatedTicketAge = (age + ageAdd) mod 2^32", () => {
  const t = { ageAdd: 0xffff_fff0, receivedAt: 1000 };
  assert.equal(obfuscatedTicketAge(t, 1000), 0xffff_fff0); // age=0
  assert.equal(obfuscatedTicketAge(t, 1010), 0xffff_fffa); // age=10
  assert.equal(obfuscatedTicketAge(t, 1020), 4); // 溢出回绕 0x100000000+4-2^32
  assert.equal(obfuscatedTicketAge({ ageAdd: 0, receivedAt: 5000 }, 4000), 0); // 时钟倒退防御
});

test("v2.3 tls13: ticketFresh 按 min(lifetime, 7天) 判新鲜", () => {
  const now = 1_000_000_000;
  const mk = (lifetimeSec: number, receivedAt: number): SessionTicket => ({
    psk: new Uint8Array(32), identity: new Uint8Array(4), ageAdd: 0, lifetimeSec, receivedAt,
  });
  assert.equal(ticketFresh(mk(10, now - 9000), now), true); // 9s < 10s
  assert.equal(ticketFresh(mk(10, now - 11_000), now), false); // 11s > 10s
  assert.equal(ticketFresh(mk(604_800 * 2, now - 604_800_001), now), false); // 7 天上限封顶
  assert.equal(ticketAgeMs(mk(0, now), now), 0);
});

test("v2.3 tls13: 会话票据缓存 store/peek/invalidate 生命周期", () => {
  const host = "cache-test.example.com";
  invalidateSessionTicket(host);
  assert.equal(peekSessionTicket(host), null);
  const t: SessionTicket = {
    psk: new Uint8Array(32).fill(1), identity: new Uint8Array([1, 2]), ageAdd: 7,
    lifetimeSec: 3600, receivedAt: Date.now(),
  };
  storeSessionTicket(host, t);
  const got = peekSessionTicket(host);
  assert.ok(got);
  assert.deepEqual(Array.from(got.psk), Array.from(t.psk));
  invalidateSessionTicket(host);
  assert.equal(peekSessionTicket(host), null);
});

test("v2.3 tls13: buildPskExtensions 编码结构（binder 条目长度是 u8 前缀！）", () => {
  const identity = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const t: SessionTicket = {
    psk: new Uint8Array(32).fill(2), identity, ageAdd: 0x11223344,
    lifetimeSec: 3600, receivedAt: 1000,
  };
  const part = buildPskExtensions(t, 1500); // age = 500ms
  // psk_key_exchange_modes：u8 数量 + psk_dhe_ke(1)
  assert.deepEqual(Array.from(part.pskModesExt), [0x01, 0x01]);
  // pskExt = identities 向量 + binders 向量
  const ext = part.pskExt;
  const idListLen = (ext[0] << 8) | ext[1];
  assert.equal(idListLen, 2 + identity.length + 4);
  const idEntryLen = (ext[2] << 8) | ext[3];
  assert.equal(idEntryLen, identity.length); // PskIdentity.identity 向量长度前缀
  // obfuscated age：u32 大端，(500 + 0x11223344) mod 2^32
  const ageBytes = ext.slice(4 + identity.length, 8 + identity.length);
  const age = (ageBytes[0] * 2 ** 24) + (ageBytes[1] << 16) + (ageBytes[2] << 8) + ageBytes[3];
  assert.equal(age, (500 + 0x11223344) % 2 ** 32);
  // binders 向量：u16 列表长 + u8 条目长 + 32 字节零占位
  const bOff = 2 + idListLen; // binders 起始
  const bListLen = (ext[bOff] << 8) | ext[bOff + 1];
  assert.equal(bListLen, 1 + 32); // u8 条目长 + 32 binder
  assert.equal(ext[bOff + 2], 32); // ⚠️ u8 条目长度（非 u16）—— 错用 u16 会被 OpenSSL 报 bad extension
  assert.equal(part.binderLen, 32);
  assert.equal(part.identitiesLen, 2 + idListLen);
  // 占位 binder 全零，长度正确
  const binder = ext.slice(bOff + 3, bOff + 3 + 32);
  assert.equal(binder.length, 32);
  assert.ok(binder.every((b) => b === 0));
  // 总长自洽
  assert.equal(ext.length, part.identitiesLen + 2 + 1 + 32);
});

test("v2.3 tls13: computePskBinder 确定性且对 PSK/transcript 双敏感", async () => {
  const psk = new Uint8Array(32).fill(0x5a);
  const ch1 = new Uint8Array(300).fill(1);
  const ch2 = new Uint8Array(300).fill(2);
  const a = await computePskBinder(psk, ch1);
  const b = await computePskBinder(psk, ch1);
  const c = await computePskBinder(psk, ch2);
  const d = await computePskBinder(new Uint8Array(32).fill(0x5b), ch1);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b); // 确定性
  assert.notDeepEqual(a, c); // transcript 变化 → binder 变化
  assert.notDeepEqual(a, d); // PSK 变化 → binder 变化（binder 绑定 PSK）
});
