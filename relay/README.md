# cf-vproxy-relay — Node 出口中转

**为什么需要它**：Cloudflare Workers runtime 的 `startTls()` 无法在代理隧道上完成 TLS 升级
（平台级限制，100% 复现 `TLS Handshake Failed.`，与代理质量无关），因此「经代理访问 Google」
在 Workers 上不可行；同时 Google 对 Cloudflare / 数据中心出口 IP 段做了地区封锁与配额压制，
直连也不可用。而 **Node 的 `tls.connect()` 可以在任意 `net.Socket` 之上完成 TLS**——本中转
把代理出口搬回 Node，与 Workers 上的 cf-vproxy 组成完整链路：

```
客户端(OpenAI/Anthropic/Gemini 协议)
        │
        ▼
cf-vproxy (Cloudflare Workers)：协议转换 / Web 面板 / 鉴权 / 熔断
        │  gemini_base_url 指向本中转（普通 HTTPS，无平台限制）
        ▼
cf-vproxy-relay (本服务，Node)：代理池 + TLS 过隧道
        │  HTTP CONNECT / SOCKS5 / SOCKS4a → 订阅节点
        ▼
generativelanguage.googleapis.com
```

零 npm 依赖，单文件 `index.js`，Node 18+ 即可运行。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `PORT` | 否 | 监听端口（Render 等平台自动注入；默认 8787） |
| `ALLOWED_API_KEY` | **是** | 允许的 Gemini Key（= cf-vproxy 里配置的那把；其他 key 一律 401） |
| `SUBSCRIPTION_URL` | 推荐 | 代理订阅，`type://host:port` 纯文本或整段 base64（同 cf-vproxy 格式） |
| `STATIC_PROXIES` | 否 | 逗号分隔静态代理列表，与订阅合并 |
| `TARGET_HOST` | 否 | 上游主机，默认 `generativelanguage.googleapis.com` |
| `REFRESH_MINUTES` | 否 | 订阅刷新间隔，默认 30 |
| `DIRECT_FALLBACK` | 否 | 代理全失败时是否直连兜底，默认 `true`（数据中心 IP 常被地区封锁，仅作保命） |

## 部署

### Render（推荐，与代理订阅同平台）

1. New → Web Service → 连接仓库 → Runtime 选 **Native Node**（或 Docker）
2. Build Command：留空；Start Command：`node relay/index.js`
3. Environment 填：
   ```
   ALLOWED_API_KEY     = <你的 Gemini Key>
   SUBSCRIPTION_URL    = https://youhua.onrender.com/api/latest/txt
   ```
4. 部署后记下服务地址，例如 `https://your-relay.onrender.com`

### fly.io / Railway / 任意 VPS

同样只需 Node 18+：`PORT=8787 ALLOWED_API_KEY=... SUBSCRIPTION_URL=... node relay/index.js`
（VPS 上可用 `pm2 start relay/index.js --name cf-vproxy-relay`）

## 接入 cf-vproxy

在 cf-vproxy 的 Web 面板（`/admin`）「配置」页把 **上游基地址**（`gemini_base_url`）设置为：

```
https://your-relay.onrender.com/v1beta
```

或用 curl：

```bash
curl -X POST "$BASE/admin/config" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"gemini_key":"<不打码带回原值>","gemini_base_url":"https://your-relay.onrender.com/v1beta"}'
```

此后 cf-vproxy 的全部上游请求（对话 / 流式 / 模型表 / countTokens）都会经中转的代理池出站，
三种协议（OpenAI / Anthropic / Gemini）的客户端行为不变。

## 行为说明

- **鉴权**：只转发 `x-goog-api-key`（或 `?key=`）等于 `ALLOWED_API_KEY` 的请求，其余 401
  （错误结构与 Google 一致，cf-vproxy 无感透传）；
- **节点选择**：成功率优先 + 未测试节点探索；失败连败指数冷却（30s→30min）；
- **接力**：单请求最多尝试 4 个节点，全部失败按 `DIRECT_FALLBACK` 决定是否直连；
- **流式**：响应原样 pipe（SSE 逐块转发），客户端断开即终止上游；
- **健康检查**：`GET /healthz`（无需鉴权）返回池子规模，适合平台存活探针；
- **订阅格式**：`http://` `socks5://` `socks4://` 支持；`https://` 及 vmess/vless/ss 等自动忽略。
