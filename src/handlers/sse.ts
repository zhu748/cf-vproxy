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

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

const sleep = (ms: number) => new Promise<"ping">((r) => setTimeout(r, ms));

/**
 * 把 AsyncGenerator<string> 包成 SSE Response（带 10s ping 保活）。
 * upstream 可选：客户端断开时同步中止的上游响应。
 */
export function sseResponseFromGenerator(gen: AsyncGenerator<string>, upstream?: Response | null): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const pending = gen.next();
      try {
        for (;;) {
          const winner = await Promise.race([
            pending.then((v) => ({ kind: "data" as const, v })),
            sleep(PING_INTERVAL_MS),
          ]);
          if (winner === "ping") {
            controller.enqueue(encoder.encode(ssePingFrame()));
            continue; // 继续等待同一个 next() promise
          }
          const { value, done } = winner.v;
          if (done) controller.close();
          else controller.enqueue(encoder.encode(value));
          return;
        }
      } catch (e) {
        void upstream?.body?.cancel().catch(() => {});
        try {
          controller.error(e);
        } catch {
          // 流已关闭
        }
      }
    },
    cancel() {
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
