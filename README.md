# DeepSeek 本地代理 (deepseek-proxy)

将 DeepSeek Chat 网页端接口 (`chat.deepseek.com`) 包装成本地代理服务，对外提供 **OpenAI 兼容** 与 **Anthropic 兼容** 两套 API。

内置 PoW (Proof-of-Work) 自动求解、限速节流、指数退避重试、工具调用（Function Calling）转换，以及一个可视化配置管理页面。

---

## 特性

- **双协议兼容**
  - OpenAI: `POST /v1/chat/completions`（支持 `stream`、`tools`、`tool_calls`）
  - Anthropic: `POST /v1/messages`（支持 `stream`、`tools`、`tool_use` / `tool_result`）
- **PoW 自动求解** —— 基于 WASM 求解器，请求前自动获取 challenge 并生成 `x-ds-pow-response`，无需手工干预
- **原生端点透传** —— `POST /api/v0/chat/completion` 直连 DeepSeek，保留原始 SSE 事件流
- **限速与节流** —— 每分钟请求数上限 + 相邻请求最小间隔，双管齐下避免触发上游 429
- **重试机制** —— 针对 `429 / 500 / 502 / 503 / 504` 指数退避重试，尊重 `Retry-After` 响应头
- **工具调用解析** —— 兼容两种模型输出格式（自定义 `<tool_call>` 与 DeepSeek 原生 DSML），容忍格式噪声
- **可视化配置页** —— `/admin` 页面在线修改配置并持久化，无需重启（host/port 除外）
- **敏感字段保护** —— `authorization` 不会明文返回前端，仅显示长度摘要；配置文件写入权限 `0600`

---

## 快速开始

### 环境要求

- Node.js 18+（依赖内置 `fetch`、`AbortController`、`Readable.fromWeb`）
- 建议在 Windows / macOS / Linux 本地运行，**不要暴露到公网**

### 安装

```bash
npm install
```

### 配置

编辑 `config.json`（首次启动会自动生成默认配置）：

```json
{
  "host": "127.0.0.1",
  "port": 3000,
  "upstreamUrl": "https://chat.deepseek.com/api/v0/chat/completion",
  "requestTimeoutMs": 120000,
  "maxRetries": 4,
  "retryBaseDelayMs": 1000,
  "maxRequestsPerMinute": 20,
  "requestIntervalMs": 5000,
  "powEnabled": true,
  "chatSessionId": "<你的会话 ID>",
  "authorization": "Bearer <你的 Token>"
}
```

> **如何获取 `authorization` 与 `chatSessionId`：**
> 1. 浏览器打开 `https://chat.deepseek.com` 并登录
> 2. 打开开发者工具 → Network，发送一条消息
> 3. 找到 `completion` 请求，复制请求头里的 `authorization`，以及请求体里的 `chat_session_id`

也可以通过环境变量覆盖（优先级高于配置文件）：

| 环境变量 | 对应配置 |
|---|---|
| `HOST` | `host` |
| `PORT` | `port` |
| `DEEPSEEK_UPSTREAM_URL` | `upstreamUrl` |
| `DEEPSEEK_AUTHORIZATION` | `authorization` |
| `DEEPSEEK_CHAT_SESSION_ID` | `chatSessionId` |
| `MAX_REQUESTS_PER_MINUTE` | `maxRequestsPerMinute` |
| `REQUEST_INTERVAL_MS` | `requestIntervalMs` |
| `POW_ENABLED` | `powEnabled` |
| `CONFIG_PATH` | 配置文件路径（默认 `./config.json`） |

### 启动

```bash
npm start
```

启动后终端会打印各端点地址：

```
代理服务:  http://127.0.0.1:3000
配置页面:  http://127.0.0.1:3000/admin
测试页面:  http://127.0.0.1:3000/test
OpenAI:   http://127.0.0.1:3000/v1/chat/completions
Anthropic:http://127.0.0.1:3000/v1/messages
配置文件:  <项目根>/config.json
PoW 自动求解: 已开启
```

---

## 使用方式

### OpenAI 兼容

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "stream": true,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

可作为 OpenAI SDK 的 `baseURL`：

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:3000/v1',
  apiKey: 'not-needed',
});
```

### Anthropic 兼容

```bash
curl http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

可作为 Anthropic SDK 的 `baseURL`：

```js
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'http://127.0.0.1:3000',
  apiKey: 'not-needed',
});
```

### 请求参数扩展

两个兼容端点除标准字段外，还支持透传以下 DeepSeek 特性开关：

| 字段 | 类型 | 说明 |
|---|---|---|
| `thinking` | boolean | 开启深度思考模式 |
| `search` | boolean | 开启联网搜索 |

---

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI 兼容对话端点 |
| `POST` | `/v1/messages` | Anthropic 兼容对话端点 |
| `POST` | `/api/v0/chat/completion` | DeepSeek 原生端点（直通） |
| `GET` | `/admin/api/config` | 读取当前配置与运行统计 |
| `PUT` | `/admin/api/config` | 更新配置并持久化 |
| `POST` | `/admin/api/test` | 测试上游连通性 |
| `GET` | `/admin` | 可视化配置页面 |
| `GET` | `/test` | 对话测试页面 |

### 配置更新示例

```bash
curl -X PUT http://127.0.0.1:3000/admin/api/config \
  -H 'content-type: application/json' \
  -d '{"maxRetries": 6, "requestIntervalMs": 3000}'
```

字段规则：
- `null` → 清空该字段
- `""` 且为敏感字段（`authorization`）→ 视为「不修改」
- 其他值 → 覆盖

修改 `host` / `port` 会返回 `restartRequired: true`，需重启进程生效。

---

## 项目结构

```
.
├── server.js      # Express 服务：路由、限速、重试、SSE 转换、协议适配
├── config.js      # 配置加载 / 校验 / 持久化（含环境变量覆盖）
├── pow.js         # PoW challenge 获取与求解，生成 x-ds-pow-response
├── tools.js       # 工具调用支持：Prompt 构造、流式标签缓冲、DSML/JSON 解析
├── config.json    # 运行时配置（含凭证，权限 0600，勿提交到版本库）
└── public/
    ├── index.html # 配置管理页
    ├── app.js     # 配置页逻辑（表单分组、敏感字段掩码）
    ├── style.css  # 配置页样式
    └── test.html  # 对话测试页
```

### 核心模块说明

**`server.js`**
- `throttle()` / `waitForInterval()` —— 两层限速：每分钟窗口计数 + 请求间最小间隔（Promise 链排队，保证并发下间隔有效）
- `fetchWithRetry()` —— 指数退避 + 抖动，最大 16s，支持 `Retry-After`
- `extractDeepSeekText()` —— 从 DeepSeek 的 `BATCH` / `fragments` / `APPEND` 事件中还原文本
- `streamAsOpenAI()` / `streamAsAnthropic()` —— 将上游 SSE 转换为对应协议的流式事件（含 `tool_calls` / `tool_use` 状态机）
- `collectDeepSeek()` —— 非流式场景下聚合完整响应

**`tools.js`**
- `buildPromptFromMessages()` —— 把 OpenAI / Anthropic 的 messages 结构压平成 DeepSeek 单条 prompt
- `ToolCallBuffer` —— 流式增量解析器，识别 `<tool_call>` 与 DSML 两种格式，容忍跨 chunk 截断、全角/半角竖线混用、缺失外层包裹等异常
- `coerceDsmlValue()` —— 按模型显式声明的类型转换参数，默认保留字符串（避免 `"007"` 被误转数字）

**`pow.js`**
- `fetchChallenge()` —— 调用 `create_pow_challenge` 获取 challenge
- `solveAndBuildHeader()` —— WASM 求解后 base64 编码，作为 `x-ds-pow-response` 发送

---

## 注意事项

- ⚠️ **不要暴露到公网。** 代理持有你的 DeepSeek 凭证，且默认无鉴权。
- ⚠️ **`config.json` 含敏感凭证**，请加入 `.gitignore`，不要提交。
- 会话 ID (`chatSessionId`) 决定上下文归属。若要开启新会话，清空该字段，代理会自动生成随机 UUID。
- `authorization` 会过期，失效时重新从浏览器抓取即可。
- 上游为网页端非公开 API，DeepSeek 可能随时调整结构，若报错请检查 `extractDeepSeekText()` 与 `pow.js` 的解析逻辑。
- 限速默认值较保守（20 次/分钟、5 秒间隔），如遇 429 请调低，如追求速度可适当调高并观察稳定性。

---

## License

Private.
