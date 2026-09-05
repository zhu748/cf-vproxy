// 官方 ListModels 拉取（网络编排，Workers 侧）：
//   GET {base}/v1beta/models?pageSize=1000（x-goog-api-key 头鉴权，分页自动跟随，最多 4 页）
// 复用 dispatchUpstream：代理池为空直连（Workers 出口默认受支持地区），
// 非空则按竞速/轮换配置经代理出站。响应解析见 src/modellist.ts（纯函数）。
import { parseOfficialModelsResponse, type GModelMeta, type OfficialFetchResult } from "../modellist.ts";
import { dispatchUpstream, type ProxyPool } from "./racefetch.ts";

export async function fetchOfficialModels(
  baseUrl: string,
  apiKey: string,
  pool: ProxyPool | null,
  env: { VPROXY_KV: KVNamespace },
  waitUntil: (p: Promise<unknown>) => void,
): Promise<OfficialFetchResult> {
  if (!apiKey) throw new Error("未配置上游 Gemini API Key，无法拉取官方模型列表");
  const init: RequestInit = {
    method: "GET",
    headers: { "x-goog-api-key": apiKey, accept: "application/json" },
  };
  const models: GModelMeta[] = [];
  let pageToken = "";
  let via = "direct";
  let pages = 0;
  for (let page = 0; page < 4; page++) {
    const url =
      baseUrl + "/models?pageSize=1000" + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
    const { response, via: v } = await dispatchUpstream(url, init, pool, env, waitUntil);
    via = v;
    pages++;
    if (!response.ok) {
      let msg = "HTTP " + response.status;
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        if (body?.error?.message) msg += ": " + body.error.message;
      } catch {
        // 保留默认 message
      }
      throw new Error("官方模型列表拉取失败（" + msg + "）");
    }
    const data = (await response.json()) as unknown;
    const parsed = parseOfficialModelsResponse(data);
    models.push(...parsed.models);
    if (!parsed.nextPageToken) break;
    pageToken = parsed.nextPageToken;
  }
  return { models, via, fetched_at: new Date().toISOString(), pages };
}
