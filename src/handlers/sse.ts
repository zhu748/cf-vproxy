// 流式输出工具：SSE 响应封装 + Gemini SSE 字节流 → GResponse 对象流
import type { GResponse } from "../types.ts";
import { parseSseStream } from "../convert/common.ts";

/** 把 AsyncGenerator<string> 包成 SSE Response */
export function sseResponseFromGenerator(gen: AsyncGenerator<string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await gen.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
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
