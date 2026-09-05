// 请求闸门 —— max_concurrent_requests / max_request_mb 两个配置项的实际执行层。
//
// 此前这两项配置只在类型/面板里存在、运行时零 enforcement（文档却承诺 503 + Retry-After），
// 本模块补齐：
//   - acquireSlot(max)：isolate 内存计数闸门，超出上限返回 acquired=false（调用方回 503 + Retry-After）；
//     release() 幂等，防 finally 与异常路径重复归还。
//   - bodyLimitViolation(...)：请求体上限判定（content-length 预检 + 实际字节数复核）。
//
// ⚠️ 纯内存/纯逻辑文件：无 KV、无运行时依赖，可在 Node 单测中直接运行。

let inFlight = 0;

export interface GateSlot {
  acquired: boolean;
  /** 归还名额（幂等；未获准时调用是 no-op） */
  release(): void;
}

/** 尝试占用一个并发名额；成功后必须在请求结束时调用 release()（try/finally 保证） */
export function acquireSlot(max: number): GateSlot {
  const cap = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  if (inFlight >= cap) {
    return {
      acquired: false,
      release() {
        /* 未获准，无需归还 */
      },
    };
  }
  inFlight += 1;
  let released = false;
  return {
    acquired: true,
    release() {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
    },
  };
}

/** 当前在飞业务请求数（诊断/测试用） */
export function inFlightCount(): number {
  return inFlight;
}

/** 重置计数（仅测试用） */
export function resetGateForTest(): void {
  inFlight = 0;
}

/**
 * 请求体上限判定：
 *   - content-length 头存在且超限 → 返回错误文案（调用方直接 413，无需读 body）；
 *   - 实际字节数（无头/分块场景已读出后）超限 → 返回错误文案；
 *   - 合法返回 null。
 */
export function bodyLimitViolation(
  contentLengthHeader: string | null,
  actualBytes: number,
  maxBytes: number,
): string | null {
  if (maxBytes <= 0) return null; // 0 = 不限制（配置层钳位后不会出现，防御）
  if (contentLengthHeader !== null) {
    const cl = Number(contentLengthHeader);
    if (Number.isFinite(cl) && cl > maxBytes) {
      return `请求体过大：content-length ${cl} 字节超过上限 ${maxBytes} 字节（max_request_mb）`;
    }
  }
  if (actualBytes > maxBytes) {
    return `请求体过大：${actualBytes} 字节超过上限 ${maxBytes} 字节（max_request_mb）`;
  }
  return null;
}
