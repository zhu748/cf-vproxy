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
  /** 握手读取器（内部可能残留缓冲字节，必须继续复用，不能丢弃） */
  reader: ByteBufReader;
  /** 握手后的写入器（继续用它写 HTTP 请求） */
  writer: WritableStreamDefaultWriter<Uint8Array>;
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
