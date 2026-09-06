// connpool.ts —— v2.2.0：代理隧道的 HTTP/1.1 Keep-Alive 连接复用池。
//
// 为什么需要它：
//   v2.1 之前每个出站请求都完整走一遍冷路径：TCP connect → SOCKS5/CONNECT 代理握手
//   （1-2 RTT）→ TLS 1.3 完整握手（1-2 RTT + ~4-6KB 证书飞行段传输）→ 请求 → 响应
//   → 拆连接。实测免费代理单请求 800~1900ms，其中 60-80% 是连接建立开销。
//   Google 上游支持 HTTP/1.1 持久连接（默认语义），因此把「已完整读完上一个响应体」
//   的 TLS 连接按 (代理, 目标 host:port) 缓存在 isolate 内存中，下一个同目标请求
//   直接跳过全部握手，只剩请求本身的应用层延迟。
//
// 复用安全规则（全部满足才回池）：
//   1. HTTP/1.1 响应且服务器未声明 Connection: close；
//   2. 响应体边界可精确定界（Content-Length 或 chunked 读到终止块）——EOF 定界
//      的连接必然已死，不回池；
//   3. 响应体被调用方完整消费（读到自然结束，未中途 error/cancel）；
//   4. 连接空闲 < 45s、总寿命 < 10min、复用 < 200 次（防记录序号长期漂移风险
//      与内存碎片累积，也贴近常见服务端/代理侧空闲超时）。
//
// 死连接自愈：
//   免费代理可能静默掐断空闲隧道。复用失败（写请求或读响应头失败且未收到任何
//   响应字节）时，proxyfetch 会丢弃该连接并自动用冷路径重试一次（浏览器同款
//   规则：无响应字节 = 请求大概率未被处理，重试安全）。竞速模式下挂死的复用
//   尝试与普通失败候选同待遇，由对冲兜底，不拖慢整体。
//
// 纯逻辑 + 类型导入：不 import "cloudflare:sockets"，Node 下可单测。
import type { Tls13Client } from "./tls13.ts";
import type { ByteBufReader } from "./byteio.ts";

export interface PooledConn {
  /** 所属代理原始 URL（健康度/竞速的 key） */
  proxyRaw: string;
  /** 目标 host:port */
  target: string;
  /** TLS 客户端（close() 会经 onClose 关闭底层 socket） */
  tls: Tls13Client;
  /** TLS 层之上的 HTTP 字节读取器（持有残留缓冲，必须随连接整体复用） */
  reader: ByteBufReader;
  /** TLS 层写适配器 */
  writer: { write(chunk: Uint8Array): Promise<void> };
  /** 建立时间（epoch ms） */
  created: number;
  /** 最近一次归还时间（epoch ms） */
  lastUsed: number;
  /** 已完成的请求数（含首次） */
  uses: number;
}

export interface ConnPoolOptions {
  /** 空闲多久后驱逐（ms） */
  maxIdleMs: number;
  /** 连接最长总寿命（ms） */
  maxAgeMs: number;
  /** 池内空闲连接总数上限 */
  maxConns: number;
  /** 单连接最大复用次数 */
  maxUses: number;
}

export const DEFAULT_CONN_POOL_OPTIONS: ConnPoolOptions = {
  maxIdleMs: 45_000,
  maxAgeMs: 600_000,
  maxConns: 12,
  maxUses: 200,
};

export interface ConnPoolStats {
  idleConns: number;
  warmProxies: number;
  /** 各空闲连接的描述（观测用） */
  conns: Array<{ proxy: string; target: string; uses: number; idleMs: number }>;
}

export class ConnPool {
  private opts: ConnPoolOptions;
  private now: () => number;
  /** key = proxyRaw \u0000 target → 空闲连接（数组尾为最新归还） */
  private buckets = new Map<string, PooledConn[]>();
  private idleCount = 0;

  constructor(opts: Partial<ConnPoolOptions> = {}, now: () => number = Date.now) {
    this.opts = { ...DEFAULT_CONN_POOL_OPTIONS, ...opts };
    this.now = now;
  }

  private key(proxyRaw: string, target: string): string {
    return proxyRaw + "\u0000" + target;
  }

  private alive(c: PooledConn): boolean {
    return !c.tls.isClosed;
  }

  private kill(c: PooledConn): void {
    try {
      c.tls.close(); // 经 onClose 关闭底层 socket
    } catch {
      // ignore
    }
  }

  private expired(c: PooledConn): boolean {
    const t = this.now();
    return t - c.lastUsed >= this.opts.maxIdleMs || t - c.created >= this.opts.maxAgeMs || c.uses >= this.opts.maxUses;
  }

  /** 驱逐全部过期/死亡连接（acquire 时自动调用，摊销开销） */
  sweep(): void {
    if (this.idleCount === 0) return;
    for (const [k, list] of this.buckets) {
      const keep: PooledConn[] = [];
      for (const c of list) {
        if (this.alive(c) && !this.expired(c)) keep.push(c);
        else this.kill(c);
      }
      if (keep.length === 0) this.buckets.delete(k);
      else this.buckets.set(k, keep);
    }
    this.recount();
  }

  private recount(): void {
    let n = 0;
    for (const list of this.buckets.values()) n += list.length;
    this.idleCount = n;
  }

  /** 取出一个空闲连接（若无可用返回 null）。取出后连接归调用方独占，直到 release/discard。 */
  acquire(proxyRaw: string, target: string): PooledConn | null {
    this.sweep();
    const list = this.buckets.get(this.key(proxyRaw, target));
    if (!list) return null;
    while (list.length > 0) {
      const c = list.pop()!; // 后进先出：刚用过的连接最可能是热且未过期的
      this.idleCount--;
      if (this.alive(c) && !this.expired(c)) {
        if (list.length === 0) this.buckets.delete(this.key(proxyRaw, target));
        return c;
      }
      this.kill(c);
    }
    this.buckets.delete(this.key(proxyRaw, target));
    return null;
  }

  /** 归还连接：reusable=false（或已死/超限）直接关闭，否则入池等待复用。 */
  release(c: PooledConn, reusable: boolean): void {
    if (!reusable || !this.alive(c) || this.expired(c)) {
      this.kill(c);
      return;
    }
    c.lastUsed = this.now();
    c.uses++;
    // 容量控制：池满时驱逐最旧空闲连接
    if (this.idleCount >= this.opts.maxConns) {
      let oldest: PooledConn | null = null;
      let oldestKey = "";
      for (const [k, list] of this.buckets) {
        if (list.length > 0 && (oldest === null || list[0].lastUsed < oldest.lastUsed)) {
          oldest = list[0];
          oldestKey = k;
        }
      }
      if (oldest) {
        const list = this.buckets.get(oldestKey)!;
        const idx = list.indexOf(oldest);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) this.buckets.delete(oldestKey);
        this.kill(oldest);
        this.idleCount--;
      }
    }
    const k = this.key(c.proxyRaw, c.target);
    let list = this.buckets.get(k);
    if (!list) {
      list = [];
      this.buckets.set(k, list);
    }
    list.push(c);
    this.idleCount++;
  }

  /** 直接废弃连接（复用失败/中止路径） */
  discard(c: PooledConn): void {
    this.kill(c);
  }

  /** 该代理是否有任一目标的空闲连接（竞速 warm 排序用） */
  isWarm(proxyRaw: string): boolean {
    for (const [k, list] of this.buckets) {
      if (list.length > 0 && k.startsWith(proxyRaw + "\u0000")) {
        // 存在即返回，但顺手确认未整体过期
        const c = list[list.length - 1];
        if (this.alive(c) && !this.expired(c)) return true;
      }
    }
    return false;
  }

  /** 观测快照（/admin/health 展示用） */
  stats(): ConnPoolStats {
    const conns: ConnPoolStats["conns"] = [];
    const warmProxies = new Set<string>();
    for (const list of this.buckets.values()) {
      for (const c of list) {
        conns.push({ proxy: c.proxyRaw, target: c.target, uses: c.uses, idleMs: this.now() - c.lastUsed });
        warmProxies.add(c.proxyRaw);
      }
    }
    return { idleConns: conns.length, warmProxies: warmProxies.size, conns };
  }

  /** 清空池（测试用） */
  clear(): void {
    for (const list of this.buckets.values()) {
      for (const c of list) this.kill(c);
    }
    this.buckets.clear();
    this.idleCount = 0;
  }
}

/** 全局单例（isolate 内存级） */
export const connPool = new ConnPool();
