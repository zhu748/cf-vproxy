// 最近请求日志：isolate 内存环形缓冲（不落 KV，避免占用写入额度）。
// 用途：Web 面板「日志」页实时观察请求流量、出口代理与耗时，辅助排查代理/协议问题。
// ⚠️ 仅用于排障观察，冷启动后清空；持久统计请看 /admin/usage（KV）。

export interface LogEntry {
  at: string; // ISO 时间
  protocol: string; // openai / anthropic / gemini / admin / other
  method: string;
  path: string;
  model: string; // 尽力提取（gemini 原生路径 / openai 请求体不解析时为 "-"）
  status: number;
  ms: number;
  via: string; // direct / 代理地址 / "-"
  key: string; // 打码后的客户端 Key
  ok: boolean;
}

const RING_MAX = 64;
const ring: LogEntry[] = [];

export function pushLog(entry: LogEntry): void {
  ring.push(entry);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

export function listLogs(): LogEntry[] {
  // 最新的在前
  return [...ring].reverse();
}

export function clearLogs(): void {
  ring.length = 0;
}

/** 从路径推断协议分类 */
export function protocolOf(path: string): string {
  if (path.startsWith("/admin")) return "admin";
  if (path.startsWith("/v1/chat")) return "openai";
  if (path.startsWith("/v1/models")) return "openai";
  if (path.startsWith("/v1/messages")) return "anthropic";
  if (path.startsWith("/v1beta")) return "gemini";
  if (path === "/" || path === "/healthz" || path === "/readyz") return "health";
  return "other";
}

/** 客户端 Key 打码（日志展示用） */
export function maskClientKey(key: string): string {
  if (!key) return "-";
  if (key.length <= 6) return key.slice(0, 2) + "***";
  return key.slice(0, 3) + "***" + key.slice(-3);
}
