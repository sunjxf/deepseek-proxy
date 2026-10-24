# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

把 DeepSeek Chat **网页端** API（`chat.deepseek.com`）包装成本地代理，对外暴露 OpenAI 兼容与 Anthropic 兼容两套端点。单进程 Node ESM 应用，无构建、无测试、无 linter。

## 常用命令

```bash
npm install          # 安装依赖（express、@rezaparsian/deepseek-pow-solver）
npm start            # 启动服务（node src/index.js）

# Windows 脚本（主要工作流）
run.bat              # 后台启动：PID 写 logs/proxy.pid，stdout 重定向 logs/console.log
run.bat --fg         # 前台启动（调试用）
run.bat --debug      # 后台启动且 LOG_LEVEL=debug
stop.bat             # 按 PID 文件强杀；无 PID 文件时用 wmic 匹配 src\index.js 兜底
```

`run.bat` 有两个非直观行为：PID 文件指向的 node 进程还活着时直接退出（防重复启动）；`node_modules` 缺失时自动跑 `npm install`。后台模式下 stdout/stderr 不在终端，要看 `logs/console.log`（及 `.err`）。

本仓库没有测试运行器、linter 或构建步骤。修改文件后做语法校验：

```bash
node --check src/index.js   # src/ 下其余模块、public/config/app.js、public/test/app.js 同理
```

启动后端点（端口取自 `config.json` 的 `port`，`DEFAULTS.port` 为 3001；下面按 3001 书写）：

| URL | 用途 |
|---|---|
| `http://127.0.0.1:3001/v1/chat/completions` | OpenAI 兼容 |
| `http://127.0.0.1:3001/v1/messages` | Anthropic 兼容 |
| `http://127.0.0.1:3001/api/v0/chat/completion` | DeepSeek 原生直通（透传，不做 prompt 转换） |
| `http://127.0.0.1:3001/admin` | 302 → `/admin/config/`（配置页，静态 `public/`） |
| `http://127.0.0.1:3001/test` | 302 → `/admin/test/`（对话测试页） |

调试靠日志而非调试器：启动前设 `LOG_LEVEL=debug`（`LOG_TO_FILE=0` 可只输出控制台）。每个请求有短请求 ID，会出现在该请求所有日志行前缀里。

## 架构

OpenAI / Anthropic 两个兼容端点的数据流一致（native 端点直通，见下）：

```
客户端请求
  -> throttle() + waitForInterval()       （两层限速）
  -> buildPromptFromMessages()            （把 messages 压平成单个 prompt 字符串）
  -> forwardToDeepSeek()                  （求解 PoW，然后 fetchWithRetry）
  -> iterateDeepSeekEvents()              （解析上游 SSE）
  -> extractDeepSeekText()                （从 BATCH/fragments/APPEND 事件中还原文本）
  -> ToolCallBuffer.feed()/flush()        （剥离工具标签，产出结构化调用）
  -> streamAsOpenAI() / streamAsAnthropic() / collectDeepSeek()
```

`src/routes/native.js` 是例外：它只做 `throttle()` + PoW + `fetchWithRetry()`，然后把 `req.body` 直发上游、把原始 SSE 流 pipe 回客户端，不经过 prompt 压平、不解析工具标签、不转换协议。

### 不可破坏的不变量

改 `src/tools/` 时必须保持这三条，否则模型会学坏或参数被改坏：

1. **工具标记绝不能泄漏进 prompt 历史。** `prompt.js` 内部的 `formatUserContent()`（不导出）在消息内容回到 prompt 前做清洗；否则模型会看到自己写坏的标记并模仿。
2. **不要强制转换模型未声明的类型。** `coerceDsmlValue()` 默认保留字符串，只有模型显式写了 `type="number"` 之类才转换（所以 `"007"` 仍是字符串）。
3. **转义修复只动字符串内部。** `fixInvalidJsonEscapes()` 必须在字符串状态内工作，把「反斜杠 + 非合法转义字符」补成 `\\`；结构位置（对象键、括号、逗号）不得改写。修完解析不了的仍应回退为正文，不得抛出。

### 关键约束：一切都是一条 prompt

DeepSeek 网页端 API 只接受一条扁平 `prompt` 字符串加 `chat_session_id`，没有消息数组。所以 OpenAI / Anthropic 的 `messages` 会被 `tools/prompt.js` 压平成文本转录（`[用户]` / `[助手]` / `[工具结果 ...]` 分段）。任何 prompt 格式改动会同时影响两个协议适配器。

### 工具调用是从自由文本里解析出来的

没有原生 function-calling 通道。工具通过 `formatToolsInstruction()` 写进 prompt，模型输出再由 `ToolCallBuffer` 扫描出调用标记。解析器刻意容忍畸形模型输出：两种标记方言（`&lt;tool_call&gt;` JSON 与 DeepSeek 原生 DSML，竖线全角 `｜` / 半角 `|` 混用）、括号缺失或多写（`balanceBrackets()`）、字符串内裸换行（`fixRawNewlinesInJson()`）、字符串内非法反斜杠转义（`fixInvalidJsonEscapes()`，典型是模型把 Windows 路径写成 `d:\study`，`\s` / `\l` 非法）、空白变体、跨 chunk 截断、未闭合标签。非调用文本经 `stripToolCallResidue()` 清掉残留标记后放行。

**`&lt;tool_call&gt;` 终点判定是反向扫描**：`ToolCallBuffer._findToolCallEndStrict()` 从后往前找 `&lt;/tool_call&gt;`，取**最后一个**能解析出 JSON（直接解析，或经 `balanceBrackets()` + `fixRawNewlinesInJson()` / `fixInvalidJsonEscapes()` 修复后解析）的位置。所以正文里出现的字面 `&lt;/tool_call&gt;` 不会被当成终点误切；代价是中间的可解析片段不会被选中作终点（而非被吞掉），解析范围一直延伸到最后一个合法位置。这看着像 bug，实为有意为之——改之前先想清楚模型会怎么写坏标签。

裸 DSML invoke（没有 `${PIPE}${PIPE}DSML${PIPE}${PIPE} calls` 外层包裹）由 `_consumeBareInvokes()` 通过 `scanDsmlInvokeBlocks()` 定位 invoke 块，取最后一个块的 `end` 作为消费长度（不校验块之间是否连续，中间夹的文本也会被一并消费）。

### 模块

代码在 `src/` 下按职责分层，入口是 `src/index.js`：

- **`src/index.js`** —— 入口：`startServer()` 加载配置并 `listen`；被 import 时不自动启动。
- **`src/app.js`** —— `createApp()`：中间件（`express.json` 50mb）、`set*Logger()` 注入、路由注册、`/admin` 静态资源。
- **`src/logger.js`** —— `makeLog()` 生成带作用域/请求 ID 的 logger；`writeToFile()` + `rotateIfNeeded()` 落盘、按天切分、大小轮转、过期清理；`formatExchange()` 打印清洗前后对照。
- **`src/stats.js`** —— 运行统计与 `recordError()`。
- **`src/config.js`** —— 配置加载/校验/持久化。环境变量覆盖文件值。`updateConfig()` 执行补丁规则（`null` 清空，敏感字段的 `""` 表示"不修改"）。通过临时文件 + rename 原子写入，权限 `0600`。`CONFIG_PATH` 默认指向项目根的 `config.json`。
- **`src/pow.js`** —— 获取 PoW challenge 并用懒初始化的 WASM 求解器求解；结果 base64 JSON 放进 `x-ds-pow-response` 头。PoW 失败非致命：请求会不带该头继续。
- **`src/routes/`** —— 四个端点：`openai.js`、`anthropic.js`、`native.js`、`admin.js`，各导出 `registerXxxRoutes(app)`。
- **`src/upstream/`** —— `client.js`（`buildUpstreamHeaders`、`fetchWithRetry`、`forwardToDeepSeek`）、`sse.js`（`iterateDeepSeekEvents`、`extractDeepSeekText`、`collectDeepSeek`）、`throttle.js`（`throttle`、`waitForInterval`）。
- **`src/adapters/`** —— `openai.js`（`streamAsOpenAI`）、`anthropic.js`（`streamAsAnthropic`）、`usage.js`（token 估算）。
- **`src/tools/`** —— 工具调用支持（见上）：`index.js` 聚合导出（对外 API 面刻意收窄，`parse.js` / `residue.js` 的底层函数不导出）；`residue.js` 正则常量、字符串状态机、残留清洗；`parse.js` JSON/DSML 解析；`buffer.js` `ToolCallBuffer`；`prompt.js` prompt 构造。
- **`public/`** —— `/admin` 下的静态配置页与对话测试页。

### 日志约定

所有模块走同一日志接口 —— `error` / `warn` / `info` / `debug`，带作用域和可选结构化 `extra` 对象。`config.js`、`pow.js`、`tools/index.js`、`upstream/throttle.js` 导出 `set*Logger()`，由 `src/app.js` 启动时注入统一 logger；新增模块时沿用该模式。转储模型输出的日志会打印 **清洗前 vs 清洗后** 对照（`formatExchange()`），便于发现标记剥离的 bug。

### 配置

`config.json`（路径可用 `CONFIG_PATH` 覆盖）保存凭证。`GET/PUT /admin/api/config` 在运行时读写；`authorization` 从不明文返回（只返回长度摘要）。改 `host`/`port` 需重启，PUT 响应会给出 `restartRequired`。

## 坑

- 上游是未公开的网页 API。DeepSeek 改响应结构时，修复点通常在 `extractDeepSeekText()`（事件结构）或 `pow.js`（challenge 结构），而不是适配器。
- `config.json` 含有真实 `authorization` token，已在 `.gitignore` 里（`.gitignore` 为 `node_modules`、`logs/`、`config.json`）。不要把内容回显进日志、提交或对话；如果某份克隆里它已被跟踪，需先 `git rm --cached config.json` 才会真正脱离版本库。
- `logs/` 可能包含完整请求体（受 `LOG_BODY_MAX` 限制，默认 1M 字符；设为 `0` 可关闭）。
- 服务无鉴权，仅供本机使用。