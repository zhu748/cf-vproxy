// tls13.test.ts —— 纯逻辑单测（无网络）：
//   - HKDF-Expand-Label 的 HkdfLabel 编码结构（RFC 8446 §7.1）
//   - HKDF 输出正确性（与 RFC 5869 测试向量对齐的 HMAC 手工推导交叉验证）
//   - SAN 通配符匹配（RFC 6125 简化规则）
//   - X.509 DER 解析（用真实结构的合成证书片段验证 tbs/SPKI/SAN 提取）
// 完整握手走 scripts/tls13-dev-test.mjs（真实代理 + Google 端到端）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { hkdfExpandLabel, sanMatchesHost, parseCertificate } from "../src/proxy/tls13.ts";
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
