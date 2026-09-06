// 基于 socket 的 HTTP/1.1 客户端：在 Cloudflare Workers 的 TCP 隧道（SOCKS5/HTTP CONNECT + 纯 JS TLS 1.3）
// 之上发送请求，并解析响应。支持 chunked / content-length / EOF 三种响应体形态，
// 流式响应以 ReadableStream 透出，供 SSE 转换层消费。
// 解析函数均为纯函数，可在 Node 下单测。
import { ByteBufReader, concatBytes } from "./byteio.ts";

// v2.3：共享编解码器（无状态、非流式模式可安全复用；旧版每请求/每响应头各 new 一次）
const TE = new TextEncoder();
const HEAD_TD = new TextDecoder();

export interface TunnelRequest {
  method: string;
  /** 完整 URL（仅用于拆 path/host） */
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface ResponseHead {
  status: number;
  reason: string;
  headers: Record<string, string>;
}

/** 写出 HTTP/1.1 请求（Content-Length 固定，body 必须已知长度）
 * v2.0：writer 放宽为结构性接口 —— 既接受 WritableStreamDefaultWriter，也接受
 * tls13 客户端的 write 适配器（代理隧道上的纯 JS TLS 层）。
 * v2.2：默认 Connection: keep-alive（连接复用池的请求侧前提）；服务器若不支持
 * 会回 Connection: close，响应侧据此不回池，行为与 v2.1 及更早完全兼容。 */
export async function writeTunnelRequest(
  writer: { write(chunk: Uint8Array): Promise<void> },
  req: TunnelRequest,
): Promise<void> {
  const u = new URL(req.url);
  const path = u.pathname + u.search;
  const lines: string[] = [];
  lines.push(req.method + " " + path + " HTTP/1.1");
  lines.push("Host: " + u.host);
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "content-length" || lk === "transfer-encoding" || lk === "connection") continue;
    if (seen.has(lk)) continue;
    seen.add(lk);
    lines.push(k + ": " + v);
  }
  lines.push("Content-Length: " + req.body.length);
  lines.push("Connection: keep-alive");
  const head = TE.encode(lines.join("\r\n") + "\r\n\r\n");
  // v2.1：头+体合并为单次 write —— tls13 层对单次写入做单缓冲区加密，
  // 少一次底层写调用，TCP 打包也更好（头体常落在同一批次）
  // v2.3：预分配单缓冲区替代 concatBytes —— 少一次分配与拷贝
  if (req.body.length === 0) {
    await writer.write(head);
    return;
  }
  const out = new Uint8Array(head.length + req.body.length);
  out.set(head, 0);
  out.set(req.body, head.length);
  await writer.write(out);
}

/** 解析响应头块（含 \r\n\r\n 的完整字节块）→ 状态/原因/头部 */
export function parseResponseHeadBlock(block: Uint8Array): ResponseHead {
  const text = HEAD_TD.decode(block);
  const sep = text.indexOf("\r\n\r\n");
  const headText = sep >= 0 ? text.slice(0, sep) : text;
  const lines = headText.split(/\r?\n/);
  const statusLine = (lines.shift() ?? "").trim();
  const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (!m) throw new Error("httpclient: malformed status line: " + statusLine);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    headers[k] = headers[k] ? headers[k] + ", " + v : v;
  }
  return { status: Number(m[1]), reason: (m[2] ?? "").trim(), headers };
}

export interface BodyShape {
  chunked: boolean;
  contentLength: number | null; // null = 读到 EOF
}

export function determineBodyShape(headers: Record<string, string>): BodyShape {
  const te = (headers["transfer-encoding"] ?? "").toLowerCase();
  if (te.includes("chunked")) return { chunked: true, contentLength: null };
  const cl = headers["content-length"];
  if (cl !== undefined && /^\d+$/.test(cl.trim())) return { chunked: false, contentLength: Number(cl.trim()) };
  return { chunked: false, contentLength: null };
}

/** 无响应体语义：HEAD 响应与 204/304 状态码（RFC 9110：无论是否存在 Content-Length 都没有 body） */
export function isBodylessStatus(method: string, status: number): boolean {
  return method.toUpperCase() === "HEAD" || status === 204 || status === 304;
}

/** 响应是否允许连接复用：非 1xx 终态、HTTP/1.1+、未声明 Connection: close
 * v2.2：连接池的响应侧判定 */
export function responseAllowsReuse(head: ResponseHead): boolean {
  if (head.status >= 100 && head.status < 200) return false;
  const conn = (head.headers["connection"] ?? "").toLowerCase();
  if (conn.includes("close")) return false;
  const proxyConn = (head.headers["proxy-connection"] ?? "").toLowerCase();
  if (proxyConn.includes("close")) return false;
  return true;
}

/** 构造响应体流：从 ByteBufReader 读取（reader 中可能已缓冲头部之后的剩余字节）
 * v2.2：cleanup 回调携带 reusable 标志 —— 响应体被完整消费且定界精确（CL/chunked
 * 自然终止）时为 true，调用方可据此把连接归还复用池；中途出错/取消/EOF 定界为 false。 */
export function makeBodyStream(
  reader: ByteBufReader,
  shape: BodyShape,
  cleanup: (reusable: boolean) => void,
): ReadableStream<Uint8Array> {
  let finished = false;
  let chunkRemaining = 0;
  let readSoFar = 0;

  const finishOnce = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (finished) return;
    finished = true;
    try {
      controller.close();
    } catch {
      // already closed
    }
    cleanup(shape.contentLength !== null || shape.chunked);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        if (shape.chunked) {
          if (chunkRemaining === 0) {
            const line = (await reader.readLine()).split(";")[0].trim();
            const size = parseInt(line, 16);
            if (!Number.isFinite(size) || size < 0) throw new Error("httpclient: bad chunk size: " + line);
            if (size === 0) {
              // 吃掉 trailer 头块（可能为空 \r\n 或若干 trailer 行直到空行）
              for (;;) {
                const t = await reader.readLine();
                if (t === "") break;
              }
              finishOnce(controller);
              return;
            }
            chunkRemaining = size;
          }
          const take = Math.min(chunkRemaining, 16384);
          const data = await reader.readExact(take);
          chunkRemaining -= data.length;
          if (chunkRemaining === 0) {
            const crlf = await reader.readExact(2); // 每个数据块后的 CRLF
            if (!(crlf[0] === 13 && crlf[1] === 10)) throw new Error("httpclient: bad chunk terminator");
          }
          controller.enqueue(data);
          return;
        }

        if (shape.contentLength !== null) {
          const remain = shape.contentLength - readSoFar;
          if (remain <= 0) {
            finishOnce(controller);
            return;
          }
          const take = Math.min(remain, 16384);
          const data = await reader.readExact(take);
          readSoFar += data.length;
          controller.enqueue(data);
          if (readSoFar >= shape.contentLength) finishOnce(controller);
          return;
        }

        // EOF 形态：读到即发
        const data = await reader.readAvailable(16384);
        if (data === null) {
          finishOnce(controller);
          return;
        }
        readSoFar += data.length;
        controller.enqueue(data);
      } catch (err) {
        finished = true;
        cleanup(false);
        try {
          controller.error(err);
        } catch {
          // ignore
        }
      }
    },
    cancel() {
      cleanup(false);
    },
  });
}

/** 完整读取一个响应（非流式场景） */
export async function readFullBody(reader: ByteBufReader, shape: BodyShape): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  if (shape.chunked) {
    const stream = makeBodyStream(reader, shape, () => {});
    const r = stream.getReader();
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      if (value) parts.push(value);
    }
  } else if (shape.contentLength !== null) {
    let remain = shape.contentLength;
    while (remain > 0) {
      const take = Math.min(remain, 65536);
      const data = await reader.readExact(take);
      parts.push(data);
      remain -= data.length;
    }
  } else {
    for (;;) {
      const data = await reader.readAvailable(65536);
      if (data === null) break;
      parts.push(data);
    }
  }
  return concatBytes(parts);
}
