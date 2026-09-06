# cf-vproxy — Vertex Master 的 Cloudflare Workers 移植版

> 基于 [vertex-master](https://github.com/zhu748/vertex-master) 的 **official 单 API Key 直连模式** 精简重写，
> 专为 Cloudflare Workers（免费计划即可）设计。转换层逻辑与原项目对齐，去掉了 reCAPTCHA 突破、
> TLS 指纹伪装、mihomo 代理内核等 Workers 沙箱无法实现的部分。
>
> **v2.5.0 更新（429 语义修正：单 IP 滑动窗口限流轮转 + 节点池 200 上限解除 + 订阅自动拉取可观测）**：
> ✅ ① **429 分类修正（实测驱动）**：v2.4.1 把 `exceeded your current quota`/`PerProject`/`FreeTier`
> 一律判成 Key 级每日配额直接透传 —— 但该文案同时出现在**单 IP 滑动窗口限流**里
> （`Please retry in 20.46s`，~20s 即恢复，每个代理 IP 有独立 20 次/窗口），且 RPM 型
> quotaId 本身就含 PerProject。配额无限 + 多代理 IP 的部署下，本可轮转绕过的限流被
> 硬失败给客户端。现在 `classify429Body` 三级判定：**秒级 retry 提示（≤300s）→ per-ip**
> （冷却该节点 retry+2s 后换节点接力，节点池每 IP 独立窗口，轮转即解）；**PerDay/daily
> 特征 → project**（保留 v2.4.1 硬失败保护，换节点无法绕过）；其余按节点级（可用性优先）。
> 同时修复竞速模式 429 根本不记节点冷却的缺口（撞过墙的节点下个请求还会被选中）；
> ② **MAX_PROXIES 200 → 1000**：订阅源 375+ 节点被硬截断到 200 的直接原因（KV 值 25MiB
> 上限，1000 节点仅 ~50KB）；③ **订阅自动拉取可观测**：cron 每跳写心跳时间戳（KV），
> `/admin/health` 暴露订阅节点数/上次拉取/下次自动拉取倒计时 + cron 心跳，面板「代理」页
> 常驻订阅状态卡片（倒计时每秒跳动、面板数据 60s 自动刷新），新增 `POST /admin/cron/run`
> 手动执行定时任务（light 模式）免等 cron 跳验证链路；④ 订阅拉取超时 20s → 45s（Render
> 免费实例冷启动 30s+，20s 会打挂每小时首拉）。
>
> **v2.4.1 更新（Key 级配额 429 识别：免费层配额不再被竞速放大 ~8× 烧毁）**：
> ✅ 单 Key 直连架构下，上游 429 分两类：**Key/项目级配额**（如免费层
> `GenerateRequestsPerDayPerProjectPerModel-FreeTier` = 20 次/天/模型，换任何代理都无法绕过）与
> **节点级限流**（出口 IP 短期限流，换节点有效）。旧版一律按节点级处理 —— 配额耗尽时竞速引擎
> 会把 8 个候选 × 节点内重试全部撞一遍，同一把 Key 的配额计数被放大 ~8× 烧光。
> 现在 429 响应体会被读入分类（真实上游样本单测覆盖）：命中配额特征
> （`exceeded your current quota` / `PerProject` / `FreeTier`）→ 按请求级硬错误立即透传给客户端
> （Retry-After 一并带回）并中止全部在飞候选；节点级限流维持原语义（冷却节点 + 接力）。
> ⚠️ 该特征集后被实测证伪（同文案亦见于单 IP 滑动窗口限流，见 v2.5.0 修正）。
> 异常超大 429 体（>64KB，恶意代理防御）不读取、按节点级处理。
>
> **v2.4.0 更新（死隧道防护 + SSE 定时器治理 + 杂项收尾）**：
> ✅ ① **响应头等待超时（120s）**：TCP 连接、代理握手、TLS 握手、写请求此前都有超时，
> 唯独「等待服务端响应头」没有 —— 代理静默黑洞（TCP 活着但不再转发）会把请求永久挂起：
> 竞速模式靠对冲兜底，而**单代理/关闭竞速的顺序模式没有任何兜底**，客户端不断开就一直占着
> 并发闸门名额。现在 120s 无响应头即判失败进入健康度冷却（足够宽容：非流式 + 深度思考的
> 长生成通常也在 120s 内返回头部）；② **SSE ping 计时器治理**：旧版每轮 `Promise.race`
> 都新建一个 10s sleep 且数据到达时不清除 —— 长流式请求在多次 ping 循环后累积大量悬挂定时器，
> 现在数据到达立即 `clearTimeout`，ping 触发后重置单实例计时器；③ **withTimeout 败者善后**：
> 超时先到后原 promise 稍后 reject 不再成为 unhandled rejection；④ **订阅拉取超时 10s → 20s**
> （免费托管平台冷启动常态 30s+）；⑤ 共享 TextEncoder/TextDecoder 补漏（proxyfetch/frames/sse）。
>
> **v2.3.0 更新（TLS 1.3 会话恢复：冷连接握手省 1 个 RTT + 整个证书飞行段 + 验签 CPU）**：
> ✅ 本地真实 OpenSSL 服务端端到端实测通过（`scripts/tls13-resumption-test.mjs`：完整握手吸收
> NewSessionTicket → 第二次连接 PSK 恢复成功（服务端 isSessionReused=true）→ 把票据给陌生服务端
> 被拒时自动降级完整握手，证书校验仍完整）。冷连接此前每次都跑完整 TLS 1.3 握手：
> 1-2 RTT + 4-6KB 证书传输 + 2-3 次非对称验签；现在 isolate 内首次握手后缓存会话票据
> （psk_dhe_ke，前向保密保留），后续冷连接服务端只回 EncryptedExtensions + Finished ——
> 在慢速免费代理上单次省数百毫秒。连接池淘汰（45s/10min/200 次）后的重建、对冲竞速的
> 新冷候选都自动受益；票据仅在 isolate 内存（密钥材料不上 KV），带票据握手遭遇 alert
> 类失败自动作废票据回退完整握手；同票据被并发竞速重复提供时单次使用票据会让其中一个
> 自动回退完整握手，安全无副作用。
> 同轮修复与优化：① 竞速败者被主动 abort 曾被记为节点失败（连败指数冷却侵蚀健康节点
> —— 竞速越活跃全池健康度衰减越快），现被中止的候选不计失败不进冷却；② TLS 写路径
> 单缓冲区化：大请求体每记录 3 次分配/拷贝降为 2 次，峰值内存 ~2× → ~1×；
> ③ 握手完成后释放 transcript（含证书链字节 ~10KB/连接）；④ 记录层解密后 subarray
> 零拷贝、共享 TextEncoder/Decoder、暖连接排序单遍扫描。
>
> **v2.2.0 更新（HTTP/1.1 Keep-Alive 连接复用池：同代理同上游的后续请求跳过全部握手）**：
> ✅ **实测平均每请求节省约 1 秒**（8 个免费代理对 Google 实测：冷 350~3637ms → 暖 148~299ms，
> 平均节省 1048ms，慢握手代理最高节省 3430ms）。v2.1 之前每个请求都完整重跑
> 「TCP connect → SOCKS5/CONNECT 代理握手（1-2 RTT）→ TLS 1.3 完整握手（1-2 RTT + 4-6KB
> 证书传输）」，这套连接建立开销占免费代理单请求延迟的 60-80%。
> v2.2.0 的解法（`src/proxy/connpool.ts`）：按 **(代理, 目标 host:port)** 把「响应体已精确读完」的
> TLS 连接缓存进 isolate 内存复用池：
> ① **回池条件严格**：HTTP/1.1 且未收到 `Connection: close`、响应体 Content-Length/chunked 精确
> 定界并完整消费（EOF 定界不回池）；空闲 45s / 总寿命 10min / 复用 200 次即退役；池容 12 条 LRU；
> ② **死连接自愈**：免费代理静默掐断空闲隧道时，复用请求若在「未收到任何响应字节」即失败，
> 自动丢弃该连接并用冷路径重试一次（浏览器同款安全重试规则，POST 不会重复计费）；
> 收到过（哪怕不完整的）响应字节则如实上抛，绝不盲目重试；
> ③ **竞速联动**：有暖连接的节点排到候选最前（零握手成本必然最先胜出）；响应头新增
> `x-vproxy-conn: warm|cold` 便于观测；`/admin/health` 新增 `conn_pool` 字段（空闲连接数/暖代理数）；
> ④ **健壮性顺带增强**：1xx 过渡响应跳过、HEAD/204/304 空体定界（防挂起）、
> `proxy-connection: close` 同样禁复用。
>
> **v2.1.0 更新（握手与读写性能优化）**：TLS 1.3 握手中相互独立的 WebCrypto 操作全部
> Promise.all 并行化（密钥调度/证书链验签/transcript 哈希/CV+Finished 验证）；证书链验签结论
> isolate 级缓存（Google 链约 90 天不变，缓存命中握手 CPU 再降 32%）；大请求体分记录并行
> 加密 + 合并单次底层写（256 记录/批）；HTTP 头+体合并单次写。
>
> **v2.0.0 更新（TLS Handshake Failed 根因修复：纯 JS 实现 TLS 1.3，代理隧道在 Workers 上真正可用）**：
> ✅ **经代理访问 HTTPS 上游彻底打通**。v1.9.1 的结论（workerd `startTls()` 在已承载代理握手流量的
> socket 上 100% 报 `TLS Handshake Failed.`）经部署到真实边缘的诊断 Worker 分步复现确认属实：
> 同一隧道上手写 ClientHello 可正常收到 Google 的 ServerHello（字节层完全透明），**只有 startTls
> 这条路径坏死** —— 这是边缘 runtime 的平台级限制，与代理质量无关。
> v2.0.0 的解法：**绕开 startTls，在原始隧道字节流上直接运行纯 JS 实现的 TLS 1.3 客户端**（`src/proxy/tls13.ts`，约千行，RFC 8446）：
> ① **密码套件** TLS_AES_128_GCM_SHA256 + **X25519** 密钥交换 —— 全部走 WebCrypto 原生算子
> （X25519/AES-GCM/HKDF/RSA-PSS/ECDSA 在边缘实测可用），握手 CPU 约 3-8ms，免费计划 10ms/请求
> 上限内可用；流式响应按 16KB 记录增量解密（每记录约 0.1ms）；
> ② **完整密钥调度与记录层**：HKDF-Expand-Label 链（early→handshake→master→application）、
> AES-128-GCM（AAD=记录头、nonce=iv^seq）、transcript 前缀哈希（CV/Finished/App 三段各取正确前缀）；
> ③ **证书校验一样不少**：X.509 最小 DER 解析 + 逐级验签 + 信任锚 SPKI 固定（Google Trust
> Services Root R1-R4，来源 pki.goog）+ SAN 匹配 + 有效期 + CertificateVerify —— **免费代理池中
> 实测大量存在的自签证书 MITM 节点会被直接拒绝**（本地实测 114/394 可用节点中约 130 个是 MITM）；
> ④ **握手后完整语义**：NewSessionTicket 跳过、KeyUpdate 重密钥、close_notify 优雅关闭、
> 对端硬关 TCP（`Connection: close` 常见）视为正常 EOF；
> ⑤ **集成方式**：`viaProxy` 弃用 `startTls`，代理握手后的 reader/writer 直接复用（残留缓冲字节
> 不丢失），v1.9.0 的 `releaseHandshake` 释放锁逻辑不再需要；熔断器/竞速/健康度/直连兜底全部保留
> —— 现在「代理失败」都是真实节点失败（死代理/CONNECT 被拒/超时），不再是平台假故障。
> 实测：边缘部署后代理节点真实成功（200），"TLS Handshake Failed." 从错误日志中彻底消失。
>
> **v1.9.1 更新（代理池熔断 + 直连兜底：Workers 平台 TLS 过隧道的诚实适配）**：
> ⚠️ **平台限制实锤**：经分步诊断验证（手工 TLS 字节双向透传正常、workerd `startTls()` 在
> 已承载代理握手流量的 socket 上 100% 报 `TLS Handshake Failed.`，与代理质量/协议实现无关），
> **Cloudflare Workers 的 runtime 无法在 SOCKS/HTTP 代理隧道上完成 TLS 升级** —— 即
> 「经代理访问 HTTPS 上游」在 Workers 上平台级不可用（VPS/Node 上同代同代理池正常）。
> 因此 v1.9.1 给出适配而非死磕：
> ① **代理池熔断器**：全池失败（或错误聚合命中平台 TLS 签名）时立即打开熔断，后续请求
> 自动回退直连 fetch（不再「配了订阅就全站 500」）；熔断状态随健康快照持久化 KV，
> 跨 isolate 共享，冷 isolate 首个请求即跳过死代理池；10 分钟冷却后自动半开重探
> （平台修复或换可用代理时自动恢复）；
> ② **巡检选点改为「最久未测优先」轮转**：修复大池子只反复测头部节点、后 160 个
> 永远不被探索的问题；
> ③ **startTls 前释放握手读写双锁**（旧版持锁会让 TLS 升级卡死 → 线上「Stream was cancelled」
> 假超时）；`/admin/health` 新增 `pool_breaker` 字段实时可见；
> ④ 地区封锁（`User location is not supported`）的正解：**Node 中转**（仓库自带 `relay/`，同 key
> 同订阅实测 200）或 **Smart Placement**（wrangler.jsonc 已开启 `placement: smart`，把 Worker
> 执行点迁到 Google 附近），详见「注意事项」第 3 条。
>
> **v1.8.0 更新（数据保护 + 协议感知错误 + 配额节流）**：
> ① **修复管理端测速清空 KV 健康记录的破坏性 bug**——`/admin/proxies/test-all`、`/admin/proxy/test`
> 在冷启动 isolate 上直接测速，会把 KV 健康快照覆盖成"仅含本次测速节点"，其余节点的历史健康度
> （胜出记忆/冷却/延迟 EMA）全部丢失；现已先 `ensureHealthLoaded` 再写入。`/admin/health` 查询
> 同样先恢复快照（面板不再显示"暂无数据"）；
> ② **协议感知错误响应**——401/403/404/413/503/500 此前一律 OpenAI 错误格式，Claude Code 等
> Anthropic 客户端解析不到 `error.type`、Gemini SDK 解析不到 `error.status`；现按请求路径返回
> 各协议原生错误结构（Anthropic `{type:"error"}` / Gemini `{error:{code,status}}`，繁忙 503 附
> Retry-After）；
> ③ **Cron 订阅刷新按 `subscription_refresh_minutes` 节流**——此前每 15 分钟一跳都无条件拉订阅
> + 写 KV（免费计划每天白耗 ~96 次 KV 写与 96 次订阅出站请求）；cron 现在还会顺手刷
> 用量/健康度/指标三类统计；
> ④ **修复订阅强制刷新"先删后拉"的可用性回退**——拉取失败时旧缓存已丢失，代理池退回静态列表；
> 现在成功才覆盖、失败保留旧缓存；
> ⑤ **TTS 上游错误透传**（此前丢弃错误体只剩 HTTP 状态码，429 的 Retry-After 一并丢失）、
> 客户端 Key 常量时间比对（与 ADMIN_TOKEN 硬化对齐）、`POST /admin/config` 落盘前整体
> sanitize（KV 不再堆积未知脏字段）、多候选失败响应体主动 cancel（防泄漏）；新增 14 项单测（162 项全绿）。
>
> **v1.7.0 更新（思考摘要分流 + 流式基础设施统一）**：
> ① **修复思考摘要泄漏正文**——Gemini `thought:true` parts 此前被所有响应转换器当普通文本吐给客户端
> （Anthropic 路径默认开启 `includeThoughts`，Claude Code 用户会看到内部思考混入回复）；现在
> **Anthropic 端点 → Claude 原生 `thinking` 块**（流式含 `thinking_delta`/`signature_delta` 完整事件序列），
> **OpenAI 端点 → `reasoning_content` 字段**（DeepSeek R1 事实标准，无 thought 时不输出该字段），
> Responses 端点丢弃（协议无对应块）；
> ② **流式路径三统一**——Anthropic / Responses 端点此前手写 ReadableStream，现统一走
> `sseResponseFromGenerator`：补齐 **10s ping 保活**（长思考请求不再被空闲超时掐断）与
> **客户端断开时取消上游**（不再继续烧 token）；
> ③ **修复 OpenAI 真流式用量从不入账**（旧实现 onUsage 传空函数）——现在所有流式请求结束时
> （含断开/异常中断）幂等记录 token 用量；
> ④ **修复 Anthropic 流式丢图像输出**（图像模型经 Anthropic 端点流式为空，现转 markdown 文本块）、
> **OpenAI 预填充回声剥离补齐全部 4 条路径**（真流式 / aggregate 非流式此前不剥）；
> ⑤ **健壮性**：Anthropic 空响应补空 `text` 块（safety 拒答不再输出 `content:[]`）、
> 面板日志把 `/v1/responses`、`/v1/audio`、`/v1/images` 正确归入 openai 协议分桶；新增 17 项单测（148 项全绿）。
>
> **v1.6.0 更新（接线修复 + 性能与健壮性全面优化）**：
> ① **修复 5 个“实现了但从未接入路由”的端点**——`/v1/responses`（OpenAI Responses API）、
> `/v1/audio/speech`（TTS）、`/v1/images/generations|edits|variations`（图像）此前请求只会 404，
> 现已全部可达（处理器早已完整实现，v1.5.0 文档宣称的 Responses 假流式从此真正生效）；
> ② **修复 KV 读瞬时失败覆写配置的破坏性 bug**（旧版可能用默认配置覆盖已保存配置）；
> ③ **补齐 `max_request_mb` / `max_concurrent_requests` 两个配置项的实际执行**（请求体超限 413、
> 并发超限 503 + Retry-After，此前两项只有配置没有运行时逻辑）；
> ④ **接线 `count_tokens` 缓存**（single-flight + LRU + TTL，Anthropic 计数不再每次裸调上游）与
> **Gemini 原生响应规范化**（占位符清理 / 空流错误帧 / 补 STOP 帧 / RikkaHub 兼容，
> 同时修复 `generateContent`/`countTokens` 的用量双重计数 bug）；
> ⑤ **性能**：订阅缓存与代理池解析改为 30s 内存缓存（不再每请求读 KV + 全量重解析）、
> `isChatModelActive` O(n)→O(1)、删除假流式非流式路径的无用生成器消费；
> ⑥ **健壮性**：直连模式 429/5xx 按上游 Retry-After 退避重试一次、上游 Retry-After 透传、
> 图片拉取 10MiB 上限、ADMIN_TOKEN 常量时间比较、`startTls` 失败时关闭 socket、
> 新增 `GET /v1/models/{model}`（OpenAI SDK 兼容）；路由抽离为纯模块并新增 29 项单测（131 项全绿）。
>
> **v1.5.0 更新（假流式全端点对齐）**：补齐原项目假流式（fake stream）在 Gemini 原生与 Anthropic 端点的移植——
> `fake-` / `假流式-` 前缀现在在 **OpenAI chat / OpenAI responses / Anthropic / Gemini 原生** 四类端点全部生效；
> `/v1/models` 与 `/v1beta/models` 参照原项目 `ModelsWithFakeVariants` 暴露变体（每个 chat 模型展开为
> `m` / `假流式-m` / `fake-m` 三条目，便于客户端自动发现）；Gemini 原生端点帧序列严格对齐原项目
> `geminiFakeStreamFrames`（逐 part 切块、finishReason/元数据收尾、usage 收尾帧）。
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
| OpenAI 协议 | `POST /v1/chat/completions`（流式/非流式）、`GET /v1/models`、`GET /v1/models/{model}`、`POST /v1/responses`（Responses API）、`POST /v1/audio/speech`（TTS）、`POST /v1/images/generations / edits / variations`（图像） |
| Anthropic 协议 | `POST /v1/messages`（流式/非流式）、`POST /v1/messages/count_tokens`（**带 single-flight + LRU + TTL 缓存**） |
| Gemini 原生 | `POST /v1beta/models/{model}:generateContent / :streamGenerateContent?alt=sse / :countTokens / :predict / :predictLongRunning`（请求体透传 + 响应规范化）、`GET /v1beta/models`（当前生效模型表，带官方元数据） |
| **请求闸门** | **v1.6.0**：`max_concurrent_requests` 全局并发门（超出 503 + `Retry-After`）；`max_request_mb` 请求体上限（超出 413，content-length 预检 + 实测复核） |
| **思考摘要分流** | **v1.7.0**：Gemini `includeThoughts` 思考摘要在 Anthropic 端点转为 Claude 原生 `thinking` 块（流式含 thinking_delta/signature_delta 完整事件序列）、OpenAI 端点转为 `reasoning_content` 字段（DeepSeek R1 事实标准）—— 不再混入正文 |
| **流式基础设施** | **v1.7.0**：全部三协议流式路径统一 10s ping 保活（长思考请求不被空闲超时掐断）+ 客户端断开即取消上游（不烧无效 token）+ 流结束（含断开）幂等记录用量 |
| **协议感知错误** | **v1.8.0**：401/403/404/413/503/500 按请求路径返回各协议原生错误结构 —— Anthropic 客户端收到 `{type:"error", error:{type,...}}`、Gemini 客户端收到 `{error:{code,status,...}}`、OpenAI 客户端收到 `{error:{message,type,code}}`；繁忙 503 附 `Retry-After` |
| **健康数据保护** | **v1.8.0**：管理端测速/健康查询先从 KV 恢复快照再写入 —— 修复冷启动 isolate 直接测速会清空其余节点历史健康度的破坏性 bug；客户端 Key 常量时间比对 |
| **Cron 配额节流** | **v1.8.0**：订阅刷新按 `subscription_refresh_minutes` 判新鲜度（此前每跳无条件拉取+写 KV）；每跳顺手刷用量/健康度/指标统计 |
| **代理池熔断** | **v1.9.1**：全池失败或命中平台 TLS 签名时立即熔断并回退直连（状态持久化 KV 跨 isolate 共享，10 分钟半开自愈）—— 配置订阅不再导致全站 500 |

| 对话能力 | 纯文本、图片输入（base64 / URL / data URI）、工具调用（function calling 双向转换，含流式增量）、**n 多候选**（非流式 `n>1` 并发 n 次上游请求合并 choices，受 max_n 上限保护） |
| **官方模型表** | **v1.4.0**：内置表为官方 ListModels 实拉数据（构建时生成，含 54 个模型的官方元数据）；运行时在面板「模型」页一键 **从官方重新拉取**（用当前上游 Key 调官方接口，自动分页、代理适配，KV 持久化立即生效），可一键恢复内置表；`/v1/models`、`/v1beta/models`、模型校验均动态跟随 |
| **假流式** | **v1.5.0 全端点**：模型名前缀 `fake-` / `假流式-`（别名目标同样生效）→ 上游非流式请求 + 合成流式输出（OpenAI/Responses/Gemini 按码点切 ≤8 块，Anthropic 整段单 delta，与原项目逐端点对齐）；`aggregate_stream=true` 时 OpenAI/Anthropic/Responses 端点全部聚合（Gemini 原生仅认前缀，同原项目）；模型列表自动暴露三变体 |
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

> 📌 两个模型列表端点均会为每个 chat 模型暴露 **假流式变体**（`m` / `假流式-m` / `fake-m`，与原项目一致），
> 客户端从列表即可自动发现；veo 等原生专用模型不展开变体。

### 假流式（fake- / 假流式- 前缀）

部分客户端强制要求流式接口，但某些模型/网关非流式更稳。在模型名前加 `fake-` 或 `假流式-`
（例如 `fake-gemini-3.7-flash`），代理会改走非流式上游请求，拿到完整回复后模拟流式吐给客户端：

- **OpenAI chat / responses / Gemini 原生**：文本按码点边界切成 ≤8 块连续吐出（不切断 emoji/组合字符，无人为延迟）；
  工具调用、finish_reason、usage 均完整保留（Gemini 帧序列逐 part 切块 + usage 收尾帧，对齐原项目 `geminiFakeStreamFrames`）；
- **Anthropic**：整段文本作为单个 `text_delta` 输出（对齐原项目聚合语义），事件序列完整
  （message_start → content_block_* → message_delta → message_stop）；
- 前缀对**别名目标**同样生效（`fake-<别名>`、`<别名>`→`fake-目标` 均可，见 `model_aliases`）；
- 思考强度归一化同样识别 fake 变体（`fake-gemini-3.7-flash` + effort=high → HIGH），与原项目一致；
- `aggregate_stream=true`：所有请求无需前缀同样聚合（OpenAI/Anthropic/Responses；Gemini 原生仅认前缀）。

```bash
# OpenAI：假流式请求（上游非流式，客户端拿到标准流式响应）
curl "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer mykey123" -H "Content-Type: application/json" \
  -d '{"model":"fake-gemini-3.7-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'

# Gemini 原生：假流式（?alt=sse 返回合成 SSE 帧）
curl "$BASE/v1beta/models/fake-gemini-3.7-flash:streamGenerateContent?alt=sse&key=mykey123" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}'

# Anthropic：假流式 / 聚合
curl "$BASE/v1/messages" \
  -H "x-api-key: mykey123" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" \
  -d '{"model":"假流式-gemini-3.7-flash","max_tokens":1024,"stream":true,"messages":[{"role":"user","content":"你好"}]}'
```

## 七、注意事项与已知限制

1. **CPU 限额**：免费计划 10ms CPU/请求。普通对话/流式转换占用极低；若频繁超限（503），升级 $5/月（30s CPU）。
2. **KV 写入额度**：免费 1000 写/天。用量统计已做 25 秒批量合并，正常个人使用远够；流量大时可调大 `FLUSH_INTERVAL_MS`（`src/usage.ts`）。
3. **代理协议与平台限制（重要）**：支持 SOCKS4/4a、SOCKS5、HTTP CONNECT。**`https://` 代理在 Workers 上不可用**
   （startTls 无法 TLS-in-TLS）——配置保存、代理池构建、订阅解析三个入口都会自动剔除并注明原因；
   vmess/vless/trojan/ss 等同样自动剔除（订阅刷新返回 `skipped_unsupported` 计数）。
   **更根本的限制（v1.9.1 实测实锤）**：Workers runtime 的 `startTls()` 无法在已承载代理握手流量的
   socket 上完成 TLS 升级（100% 报 `TLS Handshake Failed.`，与代理质量无关；同一批代理在
   VPS/Node 上完全正常）——即 **经代理访问 HTTPS 上游（Gemini API）在 Workers 上平台级不可用**。
   代理池因此触发熔断后，所有请求自动回退**直连**。若直连被 Google 地区封锁
   （`User location is not supported`），可选方案：
   - **Node 中转（推荐，仓库自带）**：`relay/` 目录 —— 零依赖单文件 Node 服务（Render/Railway/
     fly.io/VPS 均可跑），代理池 + TLS 过隧道在 Node 上无平台限制，本机实测同 key 同订阅返回 200；
     部署后面板把 `gemini_base_url` 指向 `https://your-relay.onrender.com/v1beta` 即可（详见 `relay/README.md`）；
   - **Smart Placement**（已内置开启）：执行点迁到 Google 附近，出口换制式后可能解除封锁，
     需要少量真实流量供 Cloudflare 画像后生效；注意 Google 对数据中心 IP 段还有配额压制
     （`free_tier_requests` 限额极低），直连路线即使过了地区门也容易被限流；
   - 或继续用原项目 vertex-master 的 VPS 部署（代理链路在 Node 上无此限制）。
4. **流式超时**：Workers 对单个请求总时长有限制（免费约 30s CPU 但墙钟时间流式通常可维持数分钟）；超长流式若被掐断，重试即可。
5. **单连接并发**：竞速开启时单请求最多 `max_concurrent` 条在飞 socket（默认 3，限额 6 条/请求）；关闭竞速时同时只用 1 条。
6. **安全提示**：`/admin/*` 务必设置强 `ADMIN_TOKEN`；面板 HTML 本身不含敏感数据（token 登录后才拉取），但建议不要把 Worker 域名公开传播。

## 八、本地开发与测试

```bash
npm install
npm run typecheck          # tsc --noEmit
npm test                   # 102 个单元测试（协议帧/SOCKS4/代理清洗/字节流/转换层/配置兼容/竞速与健康度/n 多候选/metrics/cron 判定/官方模型表动态分类与 KV 往返/假流式全端点帧序列）
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
