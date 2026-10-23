# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

把 DeepSeek Chat **网页端** API（`chat.deepseek.com`）包装成本地代理，对外暴露 OpenAI 兼容与 Anthropic 兼容两套端点。单进程 Node ESM 应用，无构建、无测试、无 linter。

## 常用命令

```bash
npm install          # 安装依赖（express、@rezaparsian/deepseek-pow-solver）
npm start            # 启动服务（node server.js）
```

本仓库没有测试运行器、linter 或构建步骤。修改文件后做语法校验：

```bash
node --check server.js   # config.js、pow.js、tools.js、public/app.js 同理
```

启动后默认端点：

| URL | 用途 |
|---|---|
| `http://127.0.0.1:3000/v1/chat/completions` | OpenAI 兼容 |
| `http://127.0.0.1:3000/v1/messages` | Anthropic 兼容 |
| `http://127.0.0.1:3000/api/v0/chat/completion` | DeepSeek 原生直通 |
| `http://127.0.0.1:3000/admin` | 配置页面（静态 `public/`） |

调试靠日志而非调试器：启动前设 `LOG_LEVEL=debug`（`LOG_TO_FILE=0` 可只输出控制台）。每个请求有短请求 ID，会出现在该请求所有日志行前缀里。

## 架构

三个对话端点的数据流一致：

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

### 关键约束：一切都是一条 prompt

DeepSeek 网页端 API 只接受一条扁平 `prompt` 字符串加 `chat_session_id`，没有消息数组。所以 OpenAI / Anthropic 的 `messages` 会被 `tools.js` 压平成文本转录（`[用户]` / `[助手]` / `[工具结果 ...]` 分段）。任何 prompt 格式改动会同时影响两个协议适配器。

### 工具调用是从自由文本里解析出来的

没有原生 function-calling 通道。工具通过 `formatToolsInstruction()` 写进 prompt，模型输出再由 `ToolCallBuffer` 扫描出调用标记。解析器刻意容忍畸形模型输出：两种标记方言（`<tool_call>` JSON 与 DeepSeek 原生 DSML，竖线全角 `｜` / 半角 `|` 混用）、括号缺失或多写（`balanceBrackets()`）、空白变体、跨 chunk 截断、未闭合标签。非调用文本经 `stripToolCallResidue()` 清掉残留标记后放行。

改 `tools.js` 时必须保持两条不变量：

1. **工具标记绝不能泄漏进 prompt 历史。** `formatUserContent()` 在消息内容回到 prompt 前做清洗；否则模型会看到自己写坏的标记并模仿。
2. **不要强制转换模型未声明的类型。** `coerceDsmlValue()` 默认保留字符串，只有模型显式写了 `type="number"` 之类才转换（所以 `"007"` 仍是字符串）。

### 模块

- **`server.js`** —— 所有服务端逻辑：日志（`makeLog`/`writeToFile`/`rotateIfNeeded`）、限速（`throttle`、`waitForInterval`）、重试（`fetchWithRetry`）、上游请求构造（`buildUpstreamHeaders`、`forwardToDeepSeek`）、SSE 解析（`iterateDeepSeekEvents`、`extractDeepSeekText`）、协议适配（`streamAsOpenAI`、`streamAsAnthropic`、`collectDeepSeek`）、admin API、路由注册。文件大但刻意保持扁平。
- **`config.js`** —— 配置加载/校验/持久化。环境变量覆盖文件值。`updateConfig()` 执行补丁规则（`null` 清空，敏感字段的 `""` 表示"不修改"）。通过临时文件 + rename 原子写入，权限 `0600`。
- **`pow.js`** —— 获取 PoW challenge 并用懒初始化的 WASM 求解器求解；结果 base64 JSON 放进 `x-ds-pow-response` 头。PoW 失败非致命：请求会不带该头继续。
- **`tools.js`** —— prompt 构造与工具调用解析（见上）。
- **`public/`** —— `/admin` 下的静态配置页与对话测试页。

### 日志约定

所有模块走同一日志接口 —— `error` / `warn` / `info` / `debug`，带作用域和可选结构化 `extra` 对象。`config.js`、`pow.js`、`tools.js` 导出 `set*Logger()`，由 `server.js` 启动时注入统一 logger；新增模块时沿用该模式。转储模型输出的日志会打印 **清洗前 vs 清洗后** 对照（`formatRawClean`），便于发现标记剥离的 bug。

### 配置

`config.json`（路径可用 `CONFIG_PATH` 覆盖）保存凭证。`GET/PUT /admin/api/config` 在运行时读写；`authorization` 从不明文返回（只返回长度摘要）。改 `host`/`port` 需重启，PUT 响应会给出 `restartRequired`。

## 坑

- 上游是未公开的网页 API。DeepSeek 改响应结构时，修复点通常在 `extractDeepSeekText()`（事件结构）或 `pow.js`（challenge 结构），而不是适配器。
- `config.json` 含有真实 `authorization` token，且目前**不在** `.gitignore` 里。不要提交它；不要把内容回显进日志、提交或对话。
- `logs/` 可能包含完整请求体（受 `LOG_BODY_MAX` 限制，默认 1M 字符；设为 `0` 可关闭）。
- 服务无鉴权，仅供本机使用。