// 流式输出工具：SSE 响应封装 + Gemini SSE 字节流 → GResponse 对象流
//
// SSE 保活（移植自原项目 keepalive/假流式协同行为）：
//   - 等待上游首字节/帧间隙超过 10s 时写入 ": ping" 注释帧，
//     重置 CF/中间代理/聊天客户端的空闲计时器（合规 SSE 客户端会忽略注释帧）；
//   - 客户端断开（stream.cancel 或 enqueue 失败）→ 立即 cancel 上游响应体
//     并 return 掉生成器（对齐原项目「ping 写失败即取消上游」语义）。
import type { GResponse } from "../types.ts";
import { parseSseStream } from "../convert/common.ts";
import { ssePingFrame } from "../fakestream.ts";

const PING_INTERVAL_MS = 10_000;

// v2.4：共享编码器（旧版每流 new 一个；ping/数据帧编码无状态可安全复用）
const TE = new TextEncoder();

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

// v2.4：sleep 工具已内联为可清除的 armPing（见上），不再需要模块级 sleep。

/**
 * 把 AsyncGenerator<string> 包成 SSE Response（带 10s ping 保活）。
 * upstream 可选：客户端断开时同步中止的上游响应。
 * onDone 可选（v1.7.0）：流正常结束 / 异常中断 / 客户端断开时各调用一次
 * （幂等性由调用方闭包保证）—— 用于流式请求的用量记录等收尾动作。
 */
export function sseResponseFromGenerator(
  gen: AsyncGenerator<string>,
  upstream?: Response | null,
  onDone?: () => void,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const pending = gen.next();
      // v2.4：可清除的单实例 ping 计时器。旧版每轮 Promise.race 都新建一个 10s sleep，
      // 数据先到时旧计时器不被清除地悬挂着（长流式请求在多次 ping 循环后累积大量
      // 待触发定时器，每个都存活到自然到期）。现在：数据到达立即 clearTimeout，
      // ping 触发后重置一个新计时器继续等待同一次 next()。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const armPing = () =>
        new Promise<"ping">((res) => {
          timer = setTimeout(() => res("ping"), PING_INTERVAL_MS);
        });
      const clearTimer = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      let ping = armPing();
      try {
        for (;;) {
          const winner = await Promise.race([
            pending.then((v) => ({ kind: "data" as const, v })),
            ping,
          ]);
          if (winner === "ping") {
            controller.enqueue(TE.encode(ssePingFrame()));
            ping = armPing(); // 重置计时器，继续等待同一个 next() promise
            continue;
          }
          clearTimer();
          const { value, done } = winner.v;
          if (done) {
            try {
              onDone?.();
            } catch {
              // 收尾回调失败不影响流关闭
            }
            controller.close();
          } else {
            controller.enqueue(TE.encode(value));
          }
          return;
        }
      } catch (e) {
        clearTimer();
        try {
          onDone?.();
        } catch {
          // 忽略收尾回调异常
        }
        void upstream?.body?.cancel().catch(() => {});
        try {
          controller.error(e);
        } catch {
          // 流已关闭
        }
      } finally {
        clearTimer();
      }
    },
    cancel() {
      try {
        onDone?.();
      } catch {
        // 忽略收尾回调异常
      }
      void gen.return(undefined as unknown as string).catch(() => {});
      void upstream?.body?.cancel().catch(() => {});
    },
  });
  return new Response(stream, { status: 200, headers: { ...SSE_HEADERS } });
}

/** Gemini 官方 SSE（data: {JSON}）→ GResponse 异步序列 */
export async function* geminiJsonChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<GResponse> {
  for await (const { data } of parseSseStream(body)) {
    if (!data || data === "[DONE]") continue;
    try {
      yield JSON.parse(data) as GResponse;
    } catch {
      // 跳过无法解析的帧
    }
  }
}

/** 直接透传字节流的 Response（Gemini 原生流式用） */
export function passthroughResponse(upstream: Response): Response {
  const headers = new Headers();
  for (const h of ["content-type", "cache-control"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has("content-type")) headers.set("content-type", "text/event-stream; charset=utf-8");
  return new Response(upstream.body, { status: upstream.status, headers });
}
