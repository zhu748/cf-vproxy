// 模型解析（纯逻辑，Node 可单测）：
//   剥 fake 前缀 → 别名解析 → 再剥一次 fake 前缀 → 当前生效模型表校验。
//   支持三种写法：fake-gemini-3.6-flash、fake-<别名>、<别名>→fake-目标。
//   模型表来源见 src/modellist.ts（内置基线 / 官方 ListModels 动态拉取）。
import type { VProxyConfig } from "./types.ts";
import { hasFakePrefix, stripOneFakePrefix } from "./fakestream.ts";
import { isChatModelActive, isKnownModelActive } from "./modellist.ts";

export interface ModelResolution {
  ok: boolean;
  model: string;
  /** 客户端看到的原始名称（含 fake- 前缀与别名，用于响应回显） */
  display?: string;
  /** 假流式：fake-/假流式- 前缀或 aggregate_stream 配置生效 */
  fake?: boolean;
  status?: number;
  message?: string;
}

export function resolveModel(cfg: VProxyConfig, requested: string, chatOnly: boolean): ModelResolution {
  const fakeRequested = hasFakePrefix(requested);
  let name = stripOneFakePrefix(requested);
  const alias = cfg.model_aliases[name] ?? name;
  name = hasFakePrefix(alias) ? stripOneFakePrefix(alias) : alias;
  if (cfg.disabled_models.includes(name) || cfg.disabled_models.includes(alias)) {
    return { ok: false, model: name, display: requested, status: 403, message: "模型 " + name + " 已被管理员禁用" };
  }
  const known = chatOnly ? isChatModelActive(name) : isKnownModelActive(name);
  if (!known) {
    return {
      ok: false,
      model: name,
      display: requested,
      status: 404,
      message:
        "模型 " +
        name +
        " 不在当前模型表中。可用模型见 GET /v1/models；新模型可在面板「模型」页从官方重新拉取，或通过 /admin/config 配置 model_aliases 映射。",
    };
  }
  return { ok: true, model: name, display: requested, fake: fakeRequested || hasFakePrefix(alias) };
}
