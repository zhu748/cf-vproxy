// 隧道握手编排：SOCKS4/4a、SOCKS5 / HTTP CONNECT 握手完成后，由调用方把底层 socket 升级为到目标的 TLS 连接。
// 握手协议帧来自 ./frames.ts（纯函数），字节读取来自 ./byteio.ts。
import { ByteBufReader } from "./byteio.ts";
import {
  buildSocks4ConnectRequest,
  buildSocks5AuthRequest,
  buildSocks5ConnectRequest,
  buildSocks5Greeting,
  buildHttpConnectRequest,
  parseHttpConnectReply,
  parseSocks4ConnectReply,
  parseSocks5AuthReply,
  parseSocks5ConnectReply,
  parseSocks5MethodReply,
  socks4RepMessage,
  socks5RepMessage,
  type ProxyEntry,
} from "./frames.ts";

export interface GenericIO {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export interface HandshakeResult {
  /** 握手读取器（内部可能残留缓冲字节；startTls 后由调用方重建 TLS 层 reader） */
  reader: ByteBufReader;
  /** 握手写入器（仅握手期使用；startTls 前必须释放写锁，见 releaseHandshake） */
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

/** 握手完成后释放全部流锁（读 + 写）。
 *
 * v1.9.0 修复：Workers 的 `sock.startTls()` 返回的 TLS socket **复用同一对流对象**。
 * 旧版只释放了读锁（reader.release()），握手 writer 持有的写锁一直未释放，
 * 导致升级后 `tlsSock.writable.getWriter()` 扗出
 * "This WritableStream is currently locked to a writer"——
 * **所有经代理的出站请求 100% 失败**（握手成功反而死在 TLS 写入上，握手失败的节点
 * 反而报出真实错误）。现在 startTls 前读写锁全部释放。
 */
export function releaseHandshake(hs: HandshakeResult): void {
  hs.reader.release();
  try {
    hs.writer.releaseLock();
  } catch {
    // 存在未完成写操作时 releaseLock 会拋错：保持锁不动，
    // 后续 getWriter 的报错会让本节点按失败处理并接力下一个候选
  }
}

/** SOCKS5 握手（RFC 1928 / 1929） */
export async function socks5Handshake(
  io: GenericIO,
  proxy: ProxyEntry,
  targetHost: string,
  targetPort: number,
): Promise<HandshakeResult> {
  const writer = io.writable.getWriter();
  const reader = new ByteBufReader(io.readable.getReader());

  // 1) 方法协商：配置了用户名密码则同时提供 0x00/0x02
  const wantAuth = proxy.username !== undefined;
  await writer.write(buildSocks5Greeting(wantAuth ? 0x02 : null));
  const methodReply = await reader.tryParse(parseSocks5MethodReply);
  if (methodReply.ver !== 0x05) throw new Error("socks5: bad version in method reply: " + methodReply.ver);
  if (methodReply.method === 0xff) throw new Error("socks5: no acceptable auth method offered by proxy");

  // 2) 用户名密码子协商
  if (methodReply.method === 0x02) {
    if (!wantAuth) throw new Error("socks5: proxy requires username/password auth but none configured");
    await writer.write(buildSocks5AuthRequest(proxy.username!, proxy.password ?? ""));
    const authReply = await reader.tryParse(parseSocks5AuthReply);
    if (authReply.status !== 0x00) throw new Error("socks5: auth failed (status " + authReply.status + ")");
  } else if (methodReply.method !== 0x00) {
    throw new Error("socks5: unsupported auth method " + methodReply.method);
  }

  // 3) CONNECT（域名交给代理解析 = socks5h 语义）
  await writer.write(buildSocks5ConnectRequest(targetHost, targetPort));
  const connectReply = await reader.tryParse(parseSocks5ConnectReply, 1024);
  if (connectReply.rep !== 0x00) {
    throw new Error("socks5: CONNECT failed — " + socks5RepMessage(connectReply.rep));
  }
  return { reader, writer };
}

/** SOCKS4/4a 握手（无方法协商，单帧 CONNECT；域名走 4a 扩展） */
export async function socks4Handshake(
  io: GenericIO,
  proxy: ProxyEntry,
  targetHost: string,
  targetPort: number,
): Promise<HandshakeResult> {
  const writer = io.writable.getWriter();
  const reader = new ByteBufReader(io.readable.getReader());
  // SOCKS4 只有 userid（URL 的 username），密码字段被忽略
  await writer.write(buildSocks4ConnectRequest(targetHost, targetPort, proxy.username));
  const reply = await reader.tryParse(parseSocks4ConnectReply, 256);
  if (reply.rep !== 0x5a) {
    throw new Error("socks4: CONNECT failed — " + socks4RepMessage(reply.rep));
  }
  return { reader, writer };
}

/** HTTP CONNECT 代理握手 */
export async function httpConnectHandshake(
  io: GenericIO,
  proxy: ProxyEntry,
  targetHost: string,
  targetPort: number,
): Promise<HandshakeResult> {
  const writer = io.writable.getWriter();
  const reader = new ByteBufReader(io.readable.getReader());
  await writer.write(buildHttpConnectRequest(targetHost, targetPort, proxy.username, proxy.password));
  const block = await reader.readHeaderBlock();
  const reply = parseHttpConnectReply(block);
  if (!reply.ok) {
    throw new Error(
      "http-proxy: CONNECT failed — " + (reply.status ? reply.status + " " + reply.reason : reply.reason),
    );
  }
  return { reader, writer };
}
