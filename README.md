# DeepSeek 本地代理 (deepseek-proxy)

将 DeepSeek Chat 网页端接口 (`chat.deepseek.com`) 包装成本地代理服务，对外提供 **OpenAI 兼容** 与 **Anthropic 兼容** 两套 API。

内置 PoW (Proof-of-Work) 自动求解、限速节流、指数退避重试、工具调用（Function Calling）转换、图片输入（vision）、结构化日志，以及一个可视化配置管理页面。

---

## 特性

- **双协议兼容**
  - OpenAI: `POST /v1/chat/completions`（支持 `stream`、`tools`、`tool_calls`、`image_url`）
  - Anthropic: `POST /v1/messages`（支持 `stream`、`tools`、`tool_use` / `tool_result`、`image` 块）
- **图片输入（vision）** —— 兼容端点自动提取最后一条 user 消息里的 base64 图片，上传上游换取 `file_id` 并通过 `ref_file_ids` 引用；单张失败降级为 `[图片]` 占位，不中断请求
- **PoW 自动求解** —— 基于 WASM 求解器，请求前自动获取 challenge 并生成 `x-ds-pow-response`，无需手工干预
- **原生端点透传** —— `POST /api/v0/chat/completion` 直连 DeepSeek，保留原始 SSE 事件流
- **限速与节流** —— 每分钟请求数上限 + 相邻请求最小间隔，双管齐下避免触发上游 429
- **重试机制** —— 针对 `429 / 500 / 502 / 503 / 504` 指数退避重试，尊重 `Retry-After` 响应头
- **工具调用解析** —— 兼容两种模型输出格式（自定义 `<tool_call>` 与 DeepSeek 原生 DSML），容忍格式噪声：括号缺失或多写、裸换行、单反斜杠 Windows 路径等非法转义
- **结构化日志** —— 分级别（error/warn/info/debug）、按请求 ID 串联、支持文件输出与大小轮转
- **可视化配置页** —— `/admin` 页面在线修改配置并持久化，无需重启（host/port 除外）；Tab 布局分组展示，未保存改动在对应 tab 上以小圆点提示
- **图片输入（vision）** —— 兼容端点可从最后一条 user 消息里提取 base64 图片（OpenAI `image_url` / Anthropic `image`），自动上传到 DeepSeek 换取 `file_id` 并以 `ref_file_ids` 引用；历史图片不重复上传，上传失败单张跳过
- **敏感字段保护** —— `authorization` 不会明文返回前端，仅显示长度摘要；配置文件写入权限 `0600`

---

## 快速开始

### 环境要求

- Node.js 18+（依赖内置 `fetch`、`AbortController`、`Readable.fromWeb`）
- 运行时依赖：`express`（HTTP 框架）、`@rezaparsian/deepseek-pow-solver`（WASM PoW 求解器）
- 建议在 Windows / macOS / Linux 本地运行，**不要暴露到公网**

### 安装

```bash
npm install
```

### 配置

编辑 `config.json`（不存在时以默认值运行，首次启动不会自动写文件；在 `/admin` 保存一次后才会生成）：

```json
{
  "host": "127.0.0.1",
  "port": 3001,
  "upstreamUrl": "https://chat.deepseek.com/api/v0/chat/completion",
  "requestTimeoutMs": 120000,
  "maxRetries": 4,
  "retryBaseDelayMs": 1000,
  "maxRequestsPerMinute": 30,
  "requestIntervalMs": 0,
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/155.0.0.0 Safari/537.36",
  "powEnabled": true,
  "powChallengeUrl": "https://chat.deepseek.com/api/v0/chat/create_pow_challenge",
  "powTargetPath": "/api/v0/chat/completion",
  "chatSessionId": "<你的会话 ID>",
  "sessionMaxUses": 30,
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
npm start          # 等价于 node src/index.js
```

Windows 下也可直接运行 `run.bat`，停止用 `stop.bat`。

启动后终端会打印各端点地址：

```
代理服务:   http://127.0.0.1:3001
配置页面:   http://127.0.0.1:3001/admin
测试页面:   http://127.0.0.1:3001/test
OpenAI:    http://127.0.0.1:3001/v1/chat/completions
Anthropic: http://127.0.0.1:3001/v1/messages
配置文件:   <项目根>/config.json
日志文件:   <项目根>/logs/app-YYYY-MM-DD.log
PoW 自动求解: 已开启
```

调试时可在启动前设置环境变量：

```bash
LOG_LEVEL=debug npm start   # 输出所有调试日志
LOG_TO_FILE=0 npm start     # 仅输出到控制台，不写文件
```

---

## 使用方式

### OpenAI 兼容

```bash
curl http://127.0.0.1:3001/v1/chat/completions \
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
  baseURL: 'http://127.0.0.1:3001/v1',
  apiKey: 'not-needed',
});
```

### Anthropic 兼容

```bash
curl http://127.0.0.1:3001/v1/messages \
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
  baseURL: 'http://127.0.0.1:3001',
  apiKey: 'not-needed',
});
```

### 请求参数扩展

两个兼容端点除标准字段外，还支持透传以下 DeepSeek 特性开关：

| 字段 | 类型 | 说明 |
|---|---|---|
| `thinking` | boolean | 开启深度思考模式 |
| `search` | boolean | 开启联网搜索 |

### 图片输入（vision）

两个兼容端点都接受标准协议里的图片块，代理会自动上传到 DeepSeek 并在请求中引用：

```bash
# OpenAI 风格
curl http://127.0.0.1:3001/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "stream": true,
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "描述这张图"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
      ]
    }]
  }'
```

Anthropic 风格用 `{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "..."}}`。

行为约定：

- **只处理最后一条 user 消息里的图片**——历史图片不会每轮重复上传；历史消息中的图片块在 prompt 里降级为 `[图片]` 占位，base64 数据不会写入 prompt。
- **上传失败非致命**——单张失败只记 warning 并跳过，prompt 里保留 `[图片]` 占位，请求照常发出。
- **原生端点不做图片转换**——`/api/v0/chat/completion` 是直通，需要自己先上传并填 `ref_file_ids`。
- 单张图片大小受 `express.json` 的 50MB 上限约束。

---

## 接入 Claude Code（CC Switch + VSCode 插件）

本代理暴露 Anthropic 兼容端点 `/v1/messages`，可以直接作为 Claude Code 的 API 后端，用 DeepSeek 代替 Anthropic 官方服务。配合 [CC Switch](https://github.com/farion1231/cc-switch) 管理多套配置，在 VSCode 的 Claude Code 插件里使用。

### 工作原理

```
Claude Code（CLI / VSCode 插件）
  -> ANTHROPIC_BASE_URL=http://127.0.0.1:3001
  -> POST /v1/messages          （Anthropic 协议）
  -> deepseek-proxy 压平 prompt -> chat.deepseek.com
```

Claude Code 的工具调用（Read / Edit / Bash 等）走本代理的 `tool_use` / `tool_result` 转换，由 `src/tools/` 从模型自由文本中解析出结构化调用。

### 1. 启动代理

```bash
npm start        # 或 run.bat
```

确认 `curl http://127.0.0.1:3001/admin/api/config` 能返回配置，且 `authorization` 有效。

### 2. 配置 CC Switch

CC Switch 用来在「Anthropic 官方」与「本地 DeepSeek 代理」之间一键切换，本质是改写 `~/.claude/settings.json` 的环境变量。在 CC Switch 中新增一个供应商：

| 字段 | 值 |
|---|---|
| 名称 | DeepSeek Local（随意） |
| API 地址 / Base URL | `http://127.0.0.1:3001` |
| API Key / Token | 任意非空字符串（如 `not-needed`），代理不校验 |
| 模型 | `deepseek-chat`（代理会忽略模型名，统一转发到网页端） |

保存后点击「启用」，CC Switch 会把配置写入 Claude Code 的 settings 文件，等价于：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3001",
    "ANTHROPIC_AUTH_TOKEN": "not-needed"
  }
}
```

> 部分 CC Switch 版本写入的是 `ANTHROPIC_API_KEY`，两者代理都不校验，任选其一。

### 3. 在 VSCode 中使用

1. 安装 VSCode 扩展 **Claude Code**（Anthropic 官方扩展）。
2. 确保已通过 CC Switch 切换到 DeepSeek 供应商，或手动在集成终端里导出环境变量：

   ```bash
   # Windows PowerShell
   $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3001"
   $env:ANTHROPIC_AUTH_TOKEN = "not-needed"

   # macOS / Linux
   export ANTHROPIC_BASE_URL=http://127.0.0.1:3001
   export ANTHROPIC_AUTH_TOKEN=not-needed
   ```

3. 打开命令面板（`Ctrl+Shift+P`）运行 `Claude Code: Open`，或点击侧边栏图标。
4. 首次对话若报 `401` / `403`，说明环境变量未生效——重启 VSCode 或从已设置变量的终端启动 `code`。

### 4. 注意事项

- **模型名会被忽略。** 代理把所有请求转发到 DeepSeek 网页端，`model` 字段仅用于兼容协议，实际模型由网页端会话决定。
- **上下文长度受限。** Claude Code 的 system prompt 与工具说明较长，prompt 压平后会占用较多上游 token；遇上游截断/报错可精简 `CLAUDE.md` 或减少同时开启的 MCP 工具。
- **工具调用依赖解析器容错。** DeepSeek 输出的工具标记格式不稳定，本代理已做括号修复、裸换行、非法转义等兼容处理，仍可能出现工具调用失败；开启 `LOG_LEVEL=debug` 查看清洗前后对照。
- **限速较保守。** Claude Code 一次任务可能连续发起多次请求，默认 30 次/分钟可能不够，可在 `/admin` 调高 `maxRequestsPerMinute`，遇 429 再调低。
- **随时切回官方。** 在 CC Switch 中启用「Anthropic 官方」即可，无需卸载插件。

---

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI 兼容对话端点（支持图片输入） |
| `POST` | `/v1/messages` | Anthropic 兼容对话端点（支持图片输入） |
| `POST` | `/api/v0/chat/completion` | DeepSeek 原生端点（直通，保留原始 SSE） |
| `GET` | `/admin/api/config` | 读取当前配置与运行统计（`runtime` 含 `totalRequests`、`successRequests`、`failedRequests`、`retriedRequests`、`throttledRequests`、`lastRequestAt`、`lastError`、`lastErrorAt`、`uptimeMs`、`pid`、`node`、`configPath`） |
| `PUT` | `/admin/api/config` | 更新配置并持久化 |
| `POST` | `/admin/api/test` | 测试上游连通性 |
| `GET` | `/admin` | 302 → `/admin/config/`（配置页） |
| `GET` | `/admin/config/` | 可视化配置页面（静态） |
| `GET` | `/test` | 302 → `/admin/test/`（对话测试页） |
| `GET` | `/admin/test/` | 对话测试页面（静态） |
| `GET` | `/` | 302 → `/admin/` → `/admin/config/` |

### 配置更新示例

```bash
curl -X PUT http://127.0.0.1:3001/admin/api/config \
  -H 'content-type: application/json' \
  -d '{"maxRetries": 6, "requestIntervalMs": 3000}'
```

字段规则：
- `null` → 清空该字段
- `""` 且为敏感字段（`authorization`）→ 视为「不修改」
- 其他值 → 覆盖

修改 `host` / `port` 会返回 `restartRequired: true`，需重启进程生效。

`GET /admin/api/config` 返回的 `runtime` 字段包含运行统计：`totalRequests`、`successRequests`、`failedRequests`、`retriedRequests`、`throttledRequests`、`lastRequestAt`、`lastError`、`lastErrorAt`、`uptimeMs`、`pid`、`node`、`configPath`。

---

## 日志

服务使用统一的结构化日志，格式为：

```
[2026-10-23 22:40:01.123][openai][3f-1a2b] 消息内容 {附加字段}
```

即 `[时间][作用域][请求ID] 内容`，同一请求的多行日志可用请求 ID 串联。

可用环境变量控制：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `LOG_FILE` | `<项目根>/logs/app.log` | 日志文件路径模板；实际按天写成 `app-YYYY-MM-DD.log` |
| `LOG_TO_FILE` | `1` | 设为 `0` 关闭文件日志，仅输出控制台 |
| `LOG_MAX_BYTES` | `52428800`（50MB） | 单文件上限，超过后轮转为 `app-YYYY-MM-DD.log.1` |
| `LOG_KEEP_DAYS` | `2` | 日志保留天数，过期文件自动清理；`0` 表示不清理 |
| `LOG_BODY_MAX` | `1048576` | 请求体日志的最大字符数（UTF-16 字符，非字节）；`0` 只输出 `(已关闭)`，不记录请求体 |

日志中会打印**清洗前/清洗后对照**（工具标签剥离前后），便于排查模型输出格式问题。

---

## 项目结构

```
.
├── src/
│   ├── index.js        # 入口：startServer() + 条件 listen
│   ├── app.js          # createApp()：中间件、日志注入、路由注册、静态资源
│   ├── logger.js       # 日志：makeLog / writeToFile / rotateIfNeeded / formatExchange
│   ├── stats.js        # 运行统计与 recordError
│   ├── config.js       # 配置加载 / 校验 / 持久化（含环境变量覆盖）
│   ├── pow.js          # PoW challenge 获取与求解，生成 x-ds-pow-response（支持 targetPath 覆盖）
│   ├── routes/
│   │   ├── openai.js     # OpenAI 兼容端点 /v1/chat/completions
│   │   ├── anthropic.js  # Anthropic 兼容端点 /v1/messages
│   │   ├── native.js     # DeepSeek 原生端点 /api/v0/chat/completion 透传
│   │   └── admin.js      # 配置读写与上游连通性测试接口
│   ├── upstream/
│   │   ├── client.js     # 上游请求：请求头构造、fetchWithRetry、forwardToDeepSeek
│   │   ├── sse.js        # DeepSeek SSE 解析：iterateDeepSeekEvents / extractDeepSeekText / collectDeepSeek
│   │   ├── upload.js     # 图片上传：uploadImage / uploadImages（file/upload_file 换 file_id）
│   │   └── throttle.js   # 两层限速：throttle（每分钟计数）+ waitForInterval（最小间隔）
│   ├── adapters/
│   │   ├── openai.js     # streamAsOpenAI：转为 OpenAI 流式事件（含 tool_calls 状态机）
│   │   ├── anthropic.js  # streamAsAnthropic：转为 Anthropic 流式事件（含 tool_use 状态机）
│   │   └── usage.js      # token 估算，填充 usage 字段
│   └── tools/
│       ├── index.js      # tools 层聚合入口
│       ├── prompt.js     # Prompt 构造：buildPromptFromMessages / formatToolsInstruction / extractImagesFromMessages
│       ├── buffer.js     # ToolCallBuffer：流式工具标签缓冲与切分
│       ├── parse.js      # 工具调用解析：JSON 与 DSML、balanceBrackets、fixRawNewlinesInJson、fixInvalidJsonEscapes、coerceDsmlValue
│       ├── residue.js    # 工具标签正则常量、字符串状态机、stripToolCallResidue 残留清洗
│       ├── ids.js        # 工具调用 ID 生成
│       └── log.js        # tools 层日志
├── config.json         # 运行时配置（含凭证，权限 0600，勿提交到版本库）
├── logs/
│   └── app-YYYY-MM-DD.log  # 运行日志（已 gitignore）
└── public/
    ├── common/
    │   └── base.css      # 两页共用的 CSS 变量与原子样式（按钮、圆点、代码块）
    ├── config/
    │   ├── index.html    # 配置管理页
    │   ├── app.js        # 配置页逻辑（Tab 布局、分组表单、敏感字段掩码）
    │   └── style.css     # 配置页布局样式
    └── test/
        ├── index.html    # 对话测试页
        ├── app.js        # 测试页逻辑（端点切换、图片选择、SSE 解析、消息渲染）
        └── style.css     # 测试页布局样式
```

### 核心模块说明

**`src/index.js` / `src/app.js`**
- `startServer()` —— 加载配置、`listen`，打印启动端点信息
- `createApp()` —— 组装中间件、注入模块 logger、注册路由；被 import 时不监听端口

**`src/logger.js`**
- `makeLog()` 生成带作用域/请求 ID 的 logger，`writeToFile()` + `rotateIfNeeded()` 负责落盘、按天切分与大小轮转

**`src/upstream/`**
- `throttle()` / `waitForInterval()` —— 两层限速：每分钟窗口计数 + 请求间最小间隔（Promise 链排队，保证并发下间隔有效）
- `fetchWithRetry()` —— 指数退避 + 抖动，最大 16s，支持 `Retry-After`
- `extractDeepSeekText()` —— 从 DeepSeek 的 `BATCH` / `fragments` / `APPEND` 事件中还原文本
- `collectDeepSeek()` —— 非流式场景下聚合完整响应
- `uploadImage()` / `uploadImages()` —— 图片上传到 `file/upload_file` 换取 `file_id`；批量上传单张失败只警告不中断，自建重试循环（multipart body 需每次重建）

**`src/adapters/`**
- `streamAsOpenAI()` / `streamAsAnthropic()` —— 将上游 SSE 转换为对应协议的流式事件（含 `tool_calls` / `tool_use` 状态机）

**`src/tools/`**
- `extractImagesFromMessages()` —— 从最后一条 user 消息里提取 base64 图片（兼容 OpenAI `image_url` 与 Anthropic `image` 两种块），图片块替换为 `[图片]` 占位，base64 不进入 prompt；历史消息中的图片在 `formatUserContentInner()` 里同样降级为 `[图片]`
- `buildPromptFromMessages()` —— 把 OpenAI / Anthropic 的 messages 结构压平成 DeepSeek 单条 prompt
- `formatToolsInstruction()` —— 生成工具清单与调用格式说明，注入 prompt
- `ToolCallBuffer` —— 流式增量解析器，识别 `<tool_call>` 与 DSML 两种格式，容忍跨 chunk 截断、全角/半角竖线混用、缺失外层包裹等异常；用字符串状态机保证 content 里的标签字面量不被误切
- `balanceBrackets()` —— 字符串感知的单遍括号修复，处理模型少写/多写括号、字符串未闭合
- `fixRawNewlinesInJson()` —— 修复 JSON 字符串内的裸换行，避免 `JSON.parse` 失败
- `fixInvalidJsonEscapes()` —— 只在字符串内部把非法反斜杠转义（如 Windows 路径 `d:\study` 里的 `\s` / `\l`）补成双反斜杠，避免整段 JSON 解析失败；字符串外不动
- `coerceDsmlValue()` —— 按模型显式声明的类型转换参数，默认保留字符串（避免 `"007"` 被误转数字）
- `summarizeArgs()` —— `prompt.js` 内部函数（不导出），把历史工具调用参数压成一行摘要，避免长 JSON 污染上下文

**`src/pow.js`**
- `fetchChallenge(cfg, targetPath)` —— 调用 `create_pow_challenge` 获取 challenge；`targetPath` 可覆盖 `cfg.powTargetPath`（图片上传接口的 target 与 completion 不同）
- `solveAndBuildHeader(cfg, targetPath)` —— WASM 求解后 base64 编码，作为 `x-ds-pow-response` 发送

---

## 注意事项

- ⚠️ **不要暴露到公网。** 代理持有你的 DeepSeek 凭证，且默认无鉴权。
- ⚠️ **`config.json` 含敏感凭证**，请加入 `.gitignore`，不要提交。
- `logs/` 已在 `.gitignore` 中，日志可能包含完整请求体（受 `LOG_BODY_MAX` 控制），注意脱敏。
- 会话 ID (`chatSessionId`) 作为回退值：代理会调用 `chat_session/create` 自动创建会话，并用 `sessionMaxUses` 控制复用次数（默认 30 次后重建）；创建失败时才退回 `chatSessionId`。清空该字段则完全依赖自动创建。
- `authorization` 会过期，失效时重新从浏览器抓取即可。
- 上游为网页端非公开 API，DeepSeek 可能随时调整结构，若报错请检查 `extractDeepSeekText()` 与 `pow.js` 的解析逻辑。
- 限速默认值较保守（30 次/分钟、无强制间隔），如遇 429 请调低，如追求速度可适当调高并观察稳定性。

---

## License

MIT.
