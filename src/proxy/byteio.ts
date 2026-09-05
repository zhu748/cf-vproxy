// 带缓冲的字节流读取器：在 ReadableStreamDefaultReader<Uint8Array> 之上提供
//   - readLine()            读取一行（CRLF 结尾）
//   - readExact(n)          精确读取 n 字节
//   - readHeaderBlock()     读取直到 \r\n\r\n（含）——HTTP 头 / SOCKS 应答场景
//   - readAvailable()       尽量读一些（EOF 返回 null）
//   - tryParse(fn)          基于缓冲区的探测式解析（SOCKS 变长应答）
// 纯运行时逻辑、无平台依赖，可在 Node 下直接单测。
export class ByteBufReader {
  private buf: Uint8Array = new Uint8Array(0);
  private eof = false;
  private reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  get buffered(): number {
    return this.buf.length;
  }

  async fill(): Promise<boolean> {
    if (this.eof) return false;
    const { value, done } = await this.reader.read();
    if (done) {
      this.eof = true;
      return false;
    }
    if (value && value.length > 0) {
      if (this.buf.length === 0) {
        this.buf = value;
      } else {
        const merged = new Uint8Array(this.buf.length + value.length);
        merged.set(this.buf, 0);
        merged.set(value, this.buf.length);
        this.buf = merged;
      }
    }
    return true;
  }

  private take(n: number): Uint8Array {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  private find(hay: Uint8Array, needle: number[]): number {
    outer: for (let i = 0; i + needle.length <= hay.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  /** 读取一行，返回不含行尾 CRLF 的 ASCII 文本（兼容仅 \n 结尾） */
  async readLine(maxLen = 8192): Promise<string> {
    for (;;) {
      const cr = this.find(this.buf, [13, 10]);
      if (cr >= 0) {
        const line = new TextDecoder().decode(this.take(cr));
        this.take(2);
        return line;
      }
      const lf = this.buf.indexOf(10);
      if (lf >= 0) {
        let line = new TextDecoder().decode(this.take(lf));
        this.take(1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        return line;
      }
      if (this.buf.length > maxLen) throw new Error("byteio: line too long");
      if (!(await this.fill())) throw new Error("byteio: EOF while reading line");
    }
  }

  /** 精确读取 n 字节 */
  async readExact(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      if (!(await this.fill())) throw new Error("byteio: EOF while reading " + n + " bytes");
    }
    return this.take(n);
  }

  /** 读取直到出现连续 CRLFCRLF，返回含定界符的完整块（HTTP 头部块） */
  async readHeaderBlock(maxLen = 64 * 1024): Promise<Uint8Array> {
    for (;;) {
      const idx = this.find(this.buf, [13, 10, 13, 10]);
      if (idx >= 0) return this.take(idx + 4);
      // 兼容裸 \n\n
      const idx2 = this.find(this.buf, [10, 10]);
      if (idx2 >= 0) return this.take(idx2 + 2);
      if (this.buf.length > maxLen) throw new Error("byteio: header block too large");
      if (!(await this.fill())) throw new Error("byteio: EOF while reading headers");
    }
  }

  /** 尽量读一段可用数据（最多 max 字节）；已 EOF 且无数据返回 null */
  async readAvailable(max = 16384): Promise<Uint8Array | null> {
    while (this.buf.length === 0) {
      if (!(await this.fill())) return null;
    }
    if (this.buf.length <= max) return this.take(this.buf.length);
    return this.take(max);
  }

  /** 探测式解析：fn 能从当前缓冲解析出值则消费并返回，否则等待更多数据 */
  async tryParse<T>(fn: (buf: Uint8Array) => { value: T; consumed: number } | null, maxLen = 1024): Promise<T> {
    for (;;) {
      const r = fn(this.buf);
      if (r) {
        this.take(r.consumed);
        return r.value;
      }
      if (this.buf.length > maxLen) throw new Error("byteio: reply too large to parse");
      if (!(await this.fill())) throw new Error("byteio: EOF while parsing reply");
    }
  }

  /** 释放底层 reader（不关闭流本身） */
  release(): void {
    try {
      this.reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/** 将多个 Uint8Array 拼接为一个 */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
