# cf-vproxy — Vertex Master 的 Cloudflare Workers 移植版

> 基于 [vertex-master](https://github.com/zhu748/vertex-master) 的 **official 单 API Key 直连模式** 精简重写，
> 专为 Cloudflare Workers（免费计划即可）设计。转换层逻辑与原项目对齐，去掉了 reCAPTCHA 突破、
> TLS 指纹伪装、mihomo 代理内核等 Workers 沙箱无法实现的部分。
>
> **v1.4.0 更新（官方模型表）**：内置模型表改为 **官方 ListModels API 实拉数据**（54 个模型，含 gemini-3.8-flash /
> gemini-3.5 系列 / gemma-4 / veo-3.1 / lyria-3 / deep-research 等），并在面板「模型」页提供
> **「从官方重新拉取」** 一键更新（用当前上游 Key 调官方 `GET /v1beta/models?pageSize=1000`，
> 结果存 KV 立即生效，可随时恢复内置表）；Gemini 原生入口新增 `:predictLongRunning` 透传；
> 模型校验、`/v1/models`、`/v1beta/models` 全部改为动态表驱动。
>
> **v1.3.0 更新（全功能对齐版）**：除「无头 Vertex 匿名端点」外，原项目所有可适配 CF 的功能已全部移植：
> ① OpenAI **n 多候选**（max_n + CompleteChatN：n 次并发上游请求合并 choices）；② **上游镜像/中转基地址**（gemini_base_url）；
> ③ **Cron Triggers 定时任务**：定时健康巡检（proxy_health_check_*）、订阅差异更新、keepalive 保活；
> ④ **请求指标**（原项目 metrics.go：总量/错误/延迟/状态分桶/协议分桶，JSON + Prometheus 双格式）；
> ⑤ **节点内重试**（parallel_pool_retry_enabled）；⑥ **Claude 提示词诊断**（推广/前言/规则命中数 + 最近记录）。
>
> **v1.2.0 更新**：移植原项目 **并发竞速（对冲延迟 race engine）**：按健康分选候选、首胜即停、429 冷却、
> 失败极速接力、粘性优选；节点健康度 KV 持久化；面板新增「竞速」页（配置/健康表/全量测速）。
>
> **v1.1.0 更新**：全新 Web 管理面板、SOCKS4/4a 代理支持、不支持代理链接（https:// 等）自动剔除、
> 上游简化为单 Gemini Key、内置请求日志。

## 它能做什么

```
Cherry Studio / ChatBox / Cline / Claude Code / curl …（OpenAI / Claude / Gemini 客户端）
        │  三种协议任选，自带客户端 Key 鉴权
        ▼
┌─────────────────────────────┐
│  cf-vproxy (Cloudflare      │  协议转换 ⇄ 用量统计 ⇄ KV 配置热更新 ⇄ Web 面板
│  Worker，免费计划可跑)        │
└─────────────────────────────┘
        │  出站：直连 / SOCKS4/4a / SOCKS5 / HTTP 代理（支持账号密码、订阅批量导入、故障接力）
        ▼
generativelanguage.googleapis.com  （Gemini 官方 API，你的单个 API Key）
```

| 能力 | 说明 |
|------|------|
| OpenAI 协议 | `POST /v1/chat/completions`（流式/非流式）、`GET /v1/models` |
| Anthropic 协议 | `POST /v1/messages`（流式/非流式）、`POST /v1/messages/count_tokens` |
| Gemini 原生 | `POST /v1beta/models/{model}:generateContent / :streamGenerateContent?alt=sse / :countTokens / :predict / :predictLongRunning`（请求体透传）、`GET /v1beta/models`（当前生效模型表，带官方元数据） |
| 对话能力 | 纯文本、图片输入（base64 / URL / data URI）、工具调用（function calling 双向转换，含流式增量）、**n 多候选**（非流式 `n>1` 并发 n 次上游请求合并 choices，受 max_n 上限保护） |
| **官方模型表** | **v1.4.0**：内置表为官方 ListModels 实拉数据（构建时生成，含 54 个模型的官方元数据）；运行时在面板「模型」页一键 **从官方重新拉取**（用当前上游 Key 调官方接口，自动分页、代理适配，KV 持久化立即生效），可一键恢复内置表；`/v1/models`、`/v1beta/models`、模型校验均动态跟随 |
| **Web 管理面板** | **浏览器打开 `/admin` 即可管理一切**：仪表盘（含请求指标）、配置（含镜像基地址/max_n）、代理（增删/测试/服务端并发测速）、**竞速（配置/健康表/全量测速/定时巡检）**、用量统计、模型表、请求日志。深色主题，token 登录，无需 curl |
| **并发竞速** | **移植原项目 race engine**：每请求按健康分选出多个候选节点，首个立即发出、每隔对冲延迟追加下一个（首胜即停，败者立即中止）；429 → 30s 冷却；连接/握手/5xx → 指数冷却 + 极速接力；胜出节点粘性优选；节点内重试（网络/5xx 同节点立即重试一次）。健康度 KV 持久化（冷启动不丢） |
| **Cron 定时任务** | **移植原项目定时健康巡检 + keepalive**：wrangler.jsonc 预置每 15 分钟一跳的 cron；实际节奏由配置控制（巡检间隔/批量/并发/超时，keepalive 间隔 5~86400s，首次立即发送），与 cron 表达式解耦；巡检结果计入健康度，订阅在每次触发时差异更新 |
| **请求指标** | **移植原项目 metrics.go**：请求总量/在飞/错误率/平均与峰值延迟/HTTP 状态分桶/协议分桶，isolate 内存计数 + KV 快照持久化（跨重启累计）；`GET /admin/metrics` 返回 JSON，`?format=prometheus` 返回 Prometheus 文本可直接接入抓取 |
| **Claude 提示词诊断** | **移植原项目 prompt_diagnostics**：Claude Code 推广片段剥离数、安全前言替换命中、自定义规则命中、注入是否生效与内容指纹（隐私安全），生成与 count_tokens 分开记录，面板可见 |
| **上游镜像/中转** | `gemini_base_url` 可填自定义基地址（裸域名自动补 `/v1beta`），留空使用官方地址，对齐原项目 gemini_api_base_url |
| 出站代理 | SOCKS4/4a（域名自动走 4a 扩展）、SOCKS5（socks5h 语义）、HTTP CONNECT；支持 `user:pass` 认证（SOCKS4 仅 userid）；健康分排序轮换 + 失败自动接力，或对冲竞速 |
| **不支持链接自动剔除** | 配置与订阅中的 `https://`、`vmess://` 等不支持协议**自动剔除并给出原因**（Workers 无法 TLS-in-TLS），面板可见剔除明细 |
| 节点导入 | 手工填 `socks4://`、`socks5://`、`http://` 链接，或订阅链接批量拉取（纯文本 / Base64 均可），缓存 KV 惰性刷新 |
| 配置管理 | 全部配置存 KV，Web 面板或 `curl` 热更新，无需重新部署 |
| **用量统计** | **KV 持久化**：每个客户端 Key 的请求数 / 输入输出 token / 按模型分桶 / 首次与最近使用时间（重启、冷启动都不丢） |
| **请求日志** | 最近 64 条请求（协议 / 路径 / 状态 / 耗时 / 出口代理），面板实时查看，辅助排查 |

> ⚠️ 原项目的 **Gemini 匿名端点模式（无 Key 白嫖）无法移植**：它依赖 TLS 指纹伪装（utls）和 reCAPTCHA 破解，
> Workers 的 fetch/Socket API 不暴露底层 TLS 栈。本项目只做 **官方 API 单 Key 直连**（official 模式），
> 稳定、合规、不会被封号。

---

## 一、准备

1. 一个 Cloudflare 账号（免费计划即可：10 万请求/天，10ms CPU/请求，纯 JSON 转换足够）；
2. 一个 Gemini 官方 API Key：https://aistudio.google.com/apikey （免费额度每分钟 10 次、每天 250 次）。

## 二、部署

### 方式 A：命令行部署（推荐，5 分钟）

```bash
# 1. 安装依赖
cd cf-vproxy
npm install

# 2. 登录 Cloudflare（浏览器授权）
npx wrangler login

# 3. 创建 KV 命名空间（记下输出的 id）
npx wrangler kv namespace create VPROXY_KV

# 4. 把输出的 id 填进 wrangler.jsonc 的 kv_namespaces[0].id

# 5. 写入初始配置（Secret，优先级低于 KV，但保证首次可用）
npx wrangler secret put GEMINI_API_KEY      # 粘贴你的 Gemini 官方 Key（单个）
npx wrangler secret put API_KEYS            # 自定义客户端 Key，如 mykey123（多个逗号分隔）
npx wrangler secret put ADMIN_TOKEN         # 管理面板/端点 token（自定义一串随机字符）

# 6. 部署
npx wrangler deploy
```

部署成功会输出 `https://cf-vproxy.<你的子域>.workers.dev`。

> 兼容说明：旧版 secret `GEMINI_API_KEYS`（复数）仍然可用（自动取第一个），
> 但推荐改用单数 `GEMINI_API_KEY`，与"单 Key 直连"语义一致。

### 方式 B：Dashboard 网页部署

1. Cloudflare Dashboard → **Workers & Pages → Create → Worker → Edit code**；
2. 本地 `npx wrangler deploy --dry-run --outdir dist` 后使用 `dist/index.js` 粘贴；
3. Settings → Bindings → 添加 **KV Namespace**，变量名 `VPROXY_KV`；
4. Settings → Variables → 添加上面三个 Secret；
5. Deploy。

## 三、Web 管理面板（推荐）

浏览器打开 `https://cf-vproxy.<你的子域>.workers.dev/admin`，输入 `ADMIN_TOKEN` 登录：

| 页签 | 功能 |
|------|------|
| **仪表盘** | 总请求 / tokens / 客户端 Key / 代理数 / 上游 Key 状态，模型调用 Top 榜，最近请求，端点速查 |
| **配置** | 上游 Gemini Key（打码显示，原样保存即不修改）、客户端 Key 增删、订阅链接与刷新间隔、模型别名、禁用模型 |
| **代理** | 代理列表（协议徽章 / 认证标识）、单条测试与批量测速、粘贴批量添加（**不支持的链接即时剔除并显示原因**）、订阅一键刷新 |
| **用量** | 按 Key 统计表格，展开查看模型分布，一键清空 |
| **模型** | 当前模型表（chat / 原生专用 / 已排除三类，含官方元数据悬浮提示），来源标识（内置 / 官方拉取时间），**一键从官方重新拉取 / 恢复内置表**，别名与禁用状态标注 |
| **日志** | 最近 64 条请求：协议、路径、状态码、耗时、出口代理、打码 Key |

token 保存在浏览器 localStorage，点「退出」即清除。

## 四、配置管理（curl 热更新，可选）

所有业务配置存放在 KV 的 `config` 键，也可用 curl 修改：

```bash
BASE="https://cf-vproxy.<你的子域>.workers.dev"
TOKEN="<你的 ADMIN_TOKEN>"

# 查看当前配置（Gemini Key 自动打码）
curl "$BASE/admin/config" -H "Authorization: Bearer $TOKEN"

# 修改配置：覆盖式保存（只传要改的字段也行）
curl -X POST "$BASE/admin/config" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "gemini_key": "AIzaSy...",
    "api_keys":   ["mykey123"],
    "proxies":    ["socks5://user:pass@1.2.3.4:1080", "socks4://5.6.7.8:5678", "http://user:pass@9.9.9.9:8080"],
    "subscription": "https://example.com/sub?token=xxx",
    "model_aliases": { "gpt-4o": "gemini-3.7-flash" },
    "disabled_models": [],
    "subscription_refresh_minutes": 30
  }'
# 返回中的 removed_proxies 字段列出被自动剔除的不支持链接及原因
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `gemini_key` | **上游 Gemini 官方 API Key（单个）**。打码值（含 `****`）原样提交表示不修改 |
| `api_keys` | **客户端鉴权 Key 列表**。客户端请求必须携带其中之一（Bearer / x-api-key / x-goog-api-key / ?key= 均可），多 Key 可区分用量统计 |
| `proxies` | 出站代理列表：`socks4://`、`socks4a://`、`socks5://`、`http://user:pass@host:port`；留空 = 直连。**保存时自动剔除 `https://` 及不支持的协议并去重** |
| `subscription` | 订阅链接。Worker 拉取解析其中 socks4/socks5/http 节点，缓存 KV，每 `subscription_refresh_minutes` 分钟（最少 5）惰性刷新；https/vmess/vless/ss 等自动跳过并计数 |
| `model_aliases` | 模型别名映射，如把客户端请求的 `gpt-4o` 映射到 `gemini-3.7-flash` |
| `disabled_models` | 禁用的模型名（命中即 403） |
| `racing` | **并发竞速配置**（面板「竞速」页可视化编辑）：`enabled`（默认开）、`top_k`（候选上限，默认 6）、`max_concurrent`（同时在飞，默认 3）、`hedge_delay_ms`（对冲延迟，默认 1000）、`dynamic_delay`（用平均延迟动态对冲）、`max_attempts`（单请求最多尝试节点数，默认 8，防子请求超限）、`node_retry`（节点内重试：网络/5xx 同节点立即重试一次，默认开；429 不重试） |
| `health_check` | **定时健康巡检**（面板「竞速」页可视化编辑，Cron Triggers 驱动）：`enabled`（默认开）、`interval_minutes`（间隔分钟，默认 15）、`batch_size`（每轮最多测试节点数，默认 40，免费计划建议 ≤40）、`concurrency`（并发，默认 5）、`timeout_seconds`（单节点超时，默认 8） |
| `gemini_base_url` | **上游镜像/中转基地址**（可选）。填裸域名自动补 `/v1beta`；仅接受 http(s)；留空使用官方地址。环境变量 `GEMINI_BASE_URL` 可作兑底 |
| `max_n` | **OpenAI n 参数上限**（默认 8，1~32）。n>1 非流式时并发 n 次上游请求合并 choices；流式 n>1 返回 400 |
| `drop_max_tokens` | 移除客户端的输出 token 上限（避免思考 token 挤占正文；Gemini 3.6+ 始终移除） |
| `max_request_mb` / `max_concurrent_requests` | 请求体大小上限（默认 64MiB）/ 全局并发门（超出 503 + Retry-After） |
| `aggregate_stream` | 聚合流：所有端点把非流式响应伪装成流式（无需 fake- 前缀） |
| `keepalive_url` / `keepalive_interval` | 部署保活地址（Cron 心跳触发 GET）/ 间隔（5~86400 秒，首次立即发送） |
| `claude_prompt` | **Claude 提示词策略**：推广片段剥离、安全前言替换、自定义字面量替换（≤32 条可按模型过滤）、额外 system 注入；处理结果可在 `/admin/prompt-diagnostics` 查看 |

### 代理与订阅管理

```bash
# 强制刷新订阅（先清缓存再拉取）
curl -X POST "$BASE/admin/proxies/refresh" -H "Authorization: Bearer $TOKEN"

# 测试某个代理的连通性与延迟（对 Gemini API 发起探测，结果写入节点健康度）
curl -X POST "$BASE/admin/proxy/test" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"proxy": "socks4://5.6.7.8:5678"}'

# 全量并发测速（服务端并发 6，可用优先 + 延迟升序返回，结果写入健康度）
curl -X POST "$BASE/admin/proxies/test-all" -H "Authorization: Bearer $TOKEN"

# 节点健康度快照（竞速/接力的打分依据）
curl "$BASE/admin/health" -H "Authorization: Bearer $TOKEN"
curl -X POST "$BASE/admin/health/reset" -H "Authorization: Bearer $TOKEN"   # 清空重建

# 最近请求日志 / 清空
curl "$BASE/admin/logs" -H "Authorization: Bearer $TOKEN"
curl -X POST "$BASE/admin/logs/clear" -H "Authorization: Bearer $TOKEN"
```

### 并发竞速与节点健康度（v1.2.0 新增）

原项目的招牌功能 **对冲延迟竞速** 已完整移植（`src/racing.ts` + `src/proxy/racefetch.ts`）：

- **候选选择**：按健康分（成功率 + 延迟 + 连败 + 粘性）对已验证节点排序取前 `top_k`，
  未测试节点最多给 2 个探索名额，冷却节点垫底兑底；总数不超过 `max_attempts`；
- **对冲发射**：首个候选立即发出，之后每隔 `hedge_delay_ms`（或动态平均延迟）追加下一个，在飞数 ≤ `max_concurrent`；
- **首胜即停**：任一候选拿到 2xx/3xx 响应头即胜出，其余候选立即 abort（底层 socket 关闭，不浪费配额）；
- **健康度记账**：429 → 固定 30s 冷却 + 限流计次降权；连接/握手失败、5xx → 连败指数冷却
  （30s·2^n 封顶 30 分钟）+ 极速接力下一候选；其它 4xx（400/401/403 等）属于请求级错误，
  直接返回且不惩罚节点（对齐原项目「非重试错误不计入代理健康」语义）；
- **粘性优选**：胜出节点标记粘性、优先复用，触发限流/连败即驱逐（原项目 StickyNodePool 语义）；
- **持久化**：健康度快照存 KV（20 秒批量刷盘，冷启动自动恢复；24 小时内有效）；
- **关闭竞速**（面板一键）：退回「健康分排序 + 轮换 + 失败接力」的顺序模式，429/5xx 同样接力。

健康分公式：未测试 80 分（探索档）；已验证 = 60 + 20×成功率 + 延迟加分(0~20) − 8×连败(封顶5) + 粘性 15；冷却中 0 分。

> ⚠️ Workers 免费计划每请求限 50 个子请求：`max_attempts`（默认 8，上限 20）即为单请求
> 出站连接数的硬上限，正常配置不会触限；代理池很大时建议保持默认。

**SOCKS4 说明**：目标是域名时自动使用 SOCKS4a 扩展（ userid 后跟域名，由代理解析 DNS）；
绝大多数现代 SOCKS4 代理（Dante、3proxy 等）支持 4a。SOCKS4 协议没有密码字段，URL 中的密码会被忽略。

### v1.3.0 新增：定时巡检 / 节点内重试 / 请求指标 / n 多候选 / 镜像基地址 / 提示词诊断

**1. Cron 定时健康巡检 + keepalive 保活**（wrangler.jsonc 已预置 `*/15 * * * *` 心跳）：

实际节奏由面板「竞速」页的巡检配置控制（KV 时间戳判重，与 cron 表达式解耦）。
巡检结果计入节点健康度（失败进入指数冷却），订阅链接在每次触发时同步差异更新：

```bash
# 手动触发一轮巡检（与定时任务同一实现，按巡检配置的批量/并发/超时执行）
curl -X POST "$BASE/admin/health/sweep" -H "Authorization: Bearer $TOKEN"

# keepalive：面板「配置页」填 keepalive_url 即启用（首次立即 GET，后续按间隔）
```

**2. 请求指标（原项目 metrics.go 语义）**：

```bash
# JSON 快照（总量/在飞/错误/平均与峰值延迟/状态分桶/协议分桶；跨重启累计）
curl "$BASE/admin/metrics" -H "Authorization: Bearer $TOKEN"

# Prometheus 文本格式（可直接被 Prometheus/VictoriaMetrics 抓取）
curl "$BASE/admin/metrics?format=prometheus" -H "Authorization: Bearer $TOKEN"
```

**3. OpenAI n 多候选**（原项目 max_n + CompleteChatN）：非流式 `"n": 3` 会并发发起 3 次上游请求，
合并为 choices[0..2]（usage 累加）；流式 `n>1` 返回 400；超过 max_n 上限（默认 8，面板可配 1~32）返回 400。

**4. 节点内重试**（原项目 parallel_pool_retry_enabled，面板「竞速」页开关）：
顺序模式下网络层错误/上游 5xx 时同一节点立即重试一次；429 不重试，直接冷却换节点。

**5. 上游镜像/中转**（配置页「上游镜像/中转基地址」或 `gemini_base_url` 字段）：
填裸域名自动补 `/v1beta`，留空使用官方地址；仅接受 http(s)。也支持环境变量 `GEMINI_BASE_URL` 兑底。

**6. Claude 提示词诊断**：

```bash
curl "$BASE/admin/prompt-diagnostics" -H "Authorization: Bearer $TOKEN"
# 返回 generate / count_tokens 两个端点最近一次 system 处理结果：
# 推广片段命中数、安全前言替换命中、自定义规则命中、注入是否生效、内容指纹（16 hex，隐私安全）
```

## 五、用量统计（持久化"记忆"）

不需要任何操作，每个请求自动记账（面板「用量」页可视化）：

```bash
curl "$BASE/admin/usage" -H "Authorization: Bearer $TOKEN"
# 返回 { "usage": {...按 Key 明细}, "totals": { requests, input_tokens, output_tokens, keys, top_models } }

curl -X POST "$BASE/admin/usage/reset" -H "Authorization: Bearer $TOKEN"   # 清空
```

```json
{
  "totals": { "requests": 128, "input_tokens": 45230, "output_tokens": 9877, "keys": 1,
              "top_models": [{ "model": "gemini-3.7-flash", "requests": 120 }] },
  "usage": {
    "mykey123": {
      "requests": 128, "input_tokens": 45230, "output_tokens": 9877,
      "first_used": "2026-09-05T03:01:22.480Z", "last_used": "2026-09-05T09:12:40.115Z",
      "models": { "gemini-3.7-flash": { "requests": 120, "input_tokens": 44000, "output_tokens": 9100 } }
    }
  }
}
```

实现说明：统计先在运行实例内存中累积，**每 25 秒批量合并写入 KV**（免费计划 KV 每天限 1000 次写入，
逐请求写会打爆额度）。极端情况下实例突然被回收，最多丢失最近 25 秒的尾巴；KV 本身是持久存储，
读到的数据不会因冷启动丢失。

## 六、客户端接入

客户端里的通用填法：API 地址 = `https://cf-vproxy.<你的子域>.workers.dev`（OpenAI 客户端通常加 `/v1`），API Key = `mykey123`（你在 `api_keys` 里配的）。

```bash
# OpenAI 协议（流式）
curl "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer mykey123" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.7-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'

# Anthropic 协议
curl "$BASE/v1/messages" \
  -H "x-api-key: mykey123" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.7-flash","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'

# Gemini 原生
curl "$BASE/v1beta/models/gemini-3.7-flash:generateContent?key=mykey123" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}'
```

### 模型表（官方 ListModels 拉取方式）

单 Key 模式下，模型列表直接来自 **官方 ListModels API**：`GET /v1beta/models?pageSize=1000`（`x-goog-api-key` 鉴权）。

- **内置表**：部署前用官方接口实拉生成（`src/models_data.ts`，54 个模型）。分类规则：
  - **chat**（methods 含 `generateContent`，三入口可用）：`gemini-2.5-*`、`gemini-3.*` 全系（含 flash-lite/pro/image）、`gemini-3.5/3.6/3.7/3.8-flash`、`gemma-4-*`、`gemini-flash/pro-latest`、`deep-research-*`、`gemini-2.5-*-tts`、`lyria-3*`、`gemini-omni-*` 等；
  - **原生专用**（仅 `:predict` / `:predictLongRunning`）：`veo-3.1-*` 三款；
  - **自动排除**（本代理不透传的端点）：仅 `embedContent`（embedding 系列）、`generateAnswer`（aqa）、`bidiGenerateContent`（实时双向流）的模型。
- **在线更新**：新模型发布后无需重新部署 —— 面板「模型」页点 **「从官方重新拉取」**，或：

```bash
# 用当前配置的上游 Key 调官方接口重新拉取（代理池非空时自动经代理出站）
curl -X POST "$BASE/admin/models/refresh" -H "Authorization: Bearer $TOKEN"
# → { ok, total, chat, native_only, excluded, pages, via, fetched_at }

# 查看当前生效表（含来源、拉取时间、逐模型元数据）
curl "$BASE/admin/models" -H "Authorization: Bearer $TOKEN"

# 恢复内置表（删除 KV 动态表）
curl -X POST "$BASE/admin/models/reset" -H "Authorization: Bearer $TOKEN"
```

拉取结果存 KV（`models:dynamic`），`/v1/models`、`/v1beta/models`、模型校验即刻跟随；KV 读失败自动回退内置表。
也可在本地重建内置表：`GEMINI_API_KEY=xx node scripts/gen-models.mjs`。不在表中的模型名返回 404 并提示，
确有其它名称需求时用 `model_aliases` 映射。

## 七、注意事项与已知限制

1. **CPU 限额**：免费计划 10ms CPU/请求。普通对话/流式转换占用极低；若频繁超限（503），升级 $5/月（30s CPU）。
2. **KV 写入额度**：免费 1000 写/天。用量统计已做 25 秒批量合并，正常个人使用远够；流量大时可调大 `FLUSH_INTERVAL_MS`（`src/usage.ts`）。
3. **代理协议**：支持 SOCKS4/4a、SOCKS5、HTTP CONNECT。**`https://` 代理在 Workers 上不可用**（startTls 无法 TLS-in-TLS）——
   配置保存、代理池构建、订阅解析三个入口都会自动剔除并注明原因；vmess/vless/trojan/ss 等同样自动剔除（订阅刷新返回 `skipped_unsupported` 计数）。
4. **流式超时**：Workers 对单个请求总时长有限制（免费约 30s CPU 但墙钟时间流式通常可维持数分钟）；超长流式若被掐断，重试即可。
5. **单连接并发**：竞速开启时单请求最多 `max_concurrent` 条在飞 socket（默认 3，限额 6 条/请求）；关闭竞速时同时只用 1 条。
6. **安全提示**：`/admin/*` 务必设置强 `ADMIN_TOKEN`；面板 HTML 本身不含敏感数据（token 登录后才拉取），但建议不要把 Worker 域名公开传播。

## 八、本地开发与测试

```bash
npm install
npm run typecheck          # tsc --noEmit
npm test                   # 88 个单元测试（协议帧/SOCKS4/代理清洗/字节流/转换层/配置兼容/竞速与健康度/n 多候选/metrics/cron 判定/官方模型表动态分类与 KV 往返）
npm run dev                # wrangler 本地 dev（代理隧道需真实出网，建议 deploy 后实测）
```

项目结构：

```
src/
  index.ts            路由 / 鉴权 / CORS / 请求日志埋点
  config.ts           KV 配置加载与保存（60s 内存缓存；单 gemini_key 兼容旧 gemini_keys）
  racing.ts           并发竞速纯逻辑：健康度/评分/冷却/粘性/候选选择 + KV 快照同步（可单测）
  usage.ts            用量统计（内存累积 + 25s 批量刷 KV + totals 聚合）
  logs.ts             最近请求日志（内存环形缓冲 64 条）
  models.ts           内置模型表分类导出（数据来自官方 ListModels 实拉，见 models_data.ts）
  models_data.ts      内置模型表数据（官方 ListModels 生成，scripts/gen-models.mjs 可重建）
  modellist.ts        动态模型表：分类规则 / 官方响应解析 / KV 动态表激活与回退（纯逻辑，可单测）
  modelresolve.ts     模型解析（fake 前缀/别名/动态表校验，纯逻辑，可单测）
  upstream.ts         上游调用 + 错误映射
  handlers/
    admin.ts          管理端点（面板路由 / 配置 / 代理 / 测速 / 健康度 / 用量 / 日志 / 模型）
    panel.ts          Web 管理面板（单文件内联 HTML/CSS/JS，无外部依赖，含竞速页）
    openai.ts / anthropic.ts / gemini.ts / sse.ts   协议处理器
  convert/            OpenAI、Anthropic ⇄ Gemini 转换与 SSE 流处理
  proxy/
    frames.ts         SOCKS4/4a、SOCKS5、HTTP CONNECT 协议帧 + 代理链接分类清洗（纯函数，可单测）
    byteio.ts         带缓冲字节流读取器（可单测）
    httpclient.ts     socket 上的 HTTP/1.1 客户端（chunked/流式，可单测）
    tunnel.ts         握手编排（SOCKS4/4a 认证 + SOCKS5 认证 + HTTP CONNECT）
    proxyfetch.ts     cloudflare:sockets 出站隧道（viaProxy 支持中止 / 订阅 / 自动剔除）
    racefetch.ts      对冲竞速编排（首胜即停 / 接力 / 全量测速）+ 健康轮换顺序模式
    modelfetch.ts     官方 ListModels 拉取编排（分页跟随，代理池适配）
```

## 九、致谢与许可

- 原项目：[zhu748/vertex-master](https://github.com/zhu748/vertex-master)（PolyForm Noncommercial License 1.0.0），本项目为其官方单 Key 模式的 Workers 移植，遵循同一非商用许可；
- 仅用于个人学习与技术研究，请遵守 Google API 服务条款。
