import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  getConfig,
  updateConfig,
  publicConfig,
  CONFIG_PATH,
  setConfigLogger,
} from './config.js';
import { solveAndBuildHeader, setPowLogger } from './pow.js';
import {
  ToolCallBuffer,
  buildPromptFromMessages,
  extractSystemText,
  formatToolsInstruction,
  newToolUseId,
  newMessageId,
  setToolLogger,
} from './tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 日志 ---------- */

// 日志级别：error < warn < info < debug，由 LOG_LEVEL 环境变量控制，默认 info
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = LOG_LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 2;

// 日志文件：默认 logs/app.log，可用 LOG_FILE 覆盖；LOG_TO_FILE=0 可关闭
const LOG_FILE =
  process.env.LOG_FILE || path.join(__dirname, 'logs', 'app.log');
const LOG_TO_FILE = String(process.env.LOG_TO_FILE ?? '1') !== '0';
// 单文件大小上限（默认 5MB），超过后轮转为 app.log.1
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES) || 5 * 1024 * 1024;

let logStream = null;
let logBytes = 0;

function openLogStream() {
  if (!LOG_TO_FILE) return null;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try {
      logBytes = fs.statSync(LOG_FILE).size;
    } catch {
      logBytes = 0;
    }
    const s = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    s.on('error', (e) => {
      // 写文件失败不能让服务崩溃，降级为仅 console
      console.error('[log] 日志文件写入失败，已降级为仅控制台：', e.message);
      logStream = null;
    });
    return s;
  } catch (e) {
    console.error('[log] 无法创建日志文件，已降级为仅控制台：', e.message);
    return null;
  }
}

logStream = openLogStream();

function rotateIfNeeded() {
  if (!logStream || logBytes < LOG_MAX_BYTES) return;
  try {
    logStream.end();
    const backup = `${LOG_FILE}.1`;
    fs.rmSync(backup, { force: true });
    fs.renameSync(LOG_FILE, backup);
    logBytes = 0;
    logStream = openLogStream();
  } catch (e) {
    console.error('[log] 日志轮转失败：', e.message);
  }
}

function writeToFile(line) {
  if (!logStream) return;
  try {
    logStream.write(line);
    logBytes += Buffer.byteLength(line);
    rotateIfNeeded();
  } catch {
    /* 忽略：日志失败不影响主流程 */
  }
}

// 日期时间（本地时区）YYYY-MM-DD HH:mm:ss.SSS
function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

// 把日志参数拼成一行可读文本（对非字符串做序列化）
function formatArgs(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function makeLog(scope, rid) {
  const prefix = () => `[${ts()}][${scope}]${rid ? `[${rid}]` : ''}`;
  const emit = (level, consoleFn, minLevel, args) => {
    if (LOG_LEVEL < minLevel) return;
    const line = `${prefix()} ${formatArgs(args)}\n`;
    consoleFn(line.trimEnd());
    writeToFile(line);
  };
  return {
    error: (...a) => emit('error', console.error, 0, a),
    warn: (...a) => emit('warn', console.warn, 1, a),
    info: (...a) => emit('info', console.log, 2, a),
    debug: (...a) => emit('debug', console.log, 3, a),
  };
}

const log = makeLog('proxy');

// 每个请求一个短 ID，便于把同一请求的多行日志串起来
let reqSeq = 0;
function newRequestId() {
  reqSeq = (reqSeq + 1) % 100000;
  return `${reqSeq.toString(36)}-${Date.now().toString(36).slice(-4)}`;
}

// 截断长文本用于日志，避免刷屏
function preview(text, len = 200) {
  if (text == null) return '';
  const s = String(text).replace(/\s+/g, ' ');
  return s.length > len ? s.slice(0, len) + `…(${s.length}字符)` : s;
}

// 把请求体序列化成一行完整 JSON 用于日志。
// 默认上限 1M 个 UTF-16 字符（不是字节；中文落盘字节约为字符数 × 3），
// 超出按字符数截断并在尾部标注完整长度；设置为 0 可完全关闭请求体日志。
const LOG_BODY_MAX = Number(process.env.LOG_BODY_MAX ?? 1024 * 1024);
function dumpBody(body) {
  if (LOG_BODY_MAX === 0) return '(已关闭)';
  let s;
  try {
    s = JSON.stringify(body);
  } catch (e) {
    return `(序列化失败：${e.message})`;
  }
  if (s == null) return '(空)';
  if (LOG_BODY_MAX > 0 && s.length > LOG_BODY_MAX) {
    return s.slice(0, LOG_BODY_MAX) + `…(截断，完整 ${s.length} 字符)`;
  }
  return s;
}

// 把统一日志注入到各模块，保证输出格式、级别、时间戳一致
const moduleLog = (scope) => (level, msg, extra) => {
  const fn = log[level] || log.info;
  fn(`[${scope}] ${msg}`, extra ?? '');
};
setConfigLogger(moduleLog('config'));
setPowLogger(moduleLog('pow'));
setToolLogger(moduleLog('tool_call'));

loadConfig();

const app = express();
app.use(express.json({ limit: '50mb' }));

const stats = {
  startedAt: Date.now(),
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  retriedRequests: 0,
  throttledRequests: 0,
  lastRequestAt: null,
  lastError: null,
  lastErrorAt: null,
};

function recordError(message) {
  stats.lastError = String(message).slice(0, 300);
  stats.lastErrorAt = Date.now();
}

/* ---------- 工具 ---------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------- 节流 ---------- */

let windowStart = Date.now();
let windowCount = 0;

async function throttle() {
  const cfg = getConfig();
  const limit = Number(cfg.maxRequestsPerMinute) || 0;
  if (limit <= 0) return;

  const now = Date.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    windowCount = 0;
  }

  if (windowCount >= limit) {
    const wait = 60_000 - (now - windowStart);
    stats.throttledRequests += 1;
    log.warn('throttle', '本机限流触发，等待后继续', {
      limit,
      count: windowCount,
      waitMs: wait,
    });
    await sleep(wait);
    windowStart = Date.now();
    windowCount = 0;
  }
  windowCount += 1;
}

/* ---------- 请求间隔 ---------- */

let lastRequestAt = 0;
let intervalChain = Promise.resolve();

// 相邻两次请求至少间隔 requestIntervalMs 毫秒，不足则等待。
// 通过 promise 链把并发请求排队，保证间隔是"发出请求"之间的间隔。
function waitForInterval() {
  const cfg = getConfig();
  const interval = Number(cfg.requestIntervalMs) || 0;
  if (interval <= 0) return Promise.resolve();

  const run = intervalChain.then(async () => {
    const now = Date.now();
    const elapsed = now - lastRequestAt;
    if (lastRequestAt && elapsed < interval) {
      const wait = interval - elapsed;
      stats.throttledRequests += 1;
      log.debug('interval', '请求间隔不足，排队等待', {
        intervalMs: interval,
        elapsedMs: elapsed,
        waitMs: wait,
      });
      await sleep(wait);
    }
    lastRequestAt = Date.now();
  });

  // 无论成功失败都让链继续，避免一个异常卡死后续请求
  intervalChain = run.catch(() => {});
  return run;
}

/* ---------- 上游请求头 ---------- */

function buildUpstreamHeaders(cfg, req, powHeader) {
  const headers = {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    origin: 'https://chat.deepseek.com',
    referer: req.headers['referer'] || 'https://chat.deepseek.com/',
    priority: 'u=1, i',
    'sec-ch-ua':
      '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': cfg.userAgent,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'zh_CN',
    'x-client-platform': 'web',
    'x-client-timezone-offset': '28800',
    'x-client-version': '2.5.0',
  };

  if (cfg.authorization) headers.authorization = cfg.authorization;

  const pow = req.headers['x-ds-pow-response'] || powHeader;
  if (pow) headers['x-ds-pow-response'] = pow;

  return headers;
}

/* ---------- 带重试的 fetch ---------- */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function calcDelay(attempt, retryAfterHeader, baseDelay) {
  if (retryAfterHeader) {
    const sec = Number(retryAfterHeader);
    if (!Number.isNaN(sec) && sec > 0) return Math.min(sec * 1000, 30_000);
  }
  const base = baseDelay * 2 ** attempt;
  const jitter = Math.random() * 500;
  return Math.min(base + jitter, 16_000);
}

async function fetchWithRetry(url, options, cfg, onRetry, lg = log) {
  const maxRetries = Number(cfg.maxRetries) || 0;
  const baseDelay = Number(cfg.retryBaseDelayMs) || 1000;
  const timeoutMs = Number(cfg.requestTimeoutMs) || 120000;
  let lastResponse = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    try {
      lg.debug('upstream', '发送上游请求', {
        url,
        attempt,
        timeoutMs,
        bodyBytes: options.body ? Buffer.byteLength(options.body) : 0,
      });

      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      lg.debug('upstream', '上游响应', {
        status: res.status,
        ms: Date.now() - started,
        attempt,
        contentType: res.headers.get('content-type'),
      });

      if (!RETRYABLE_STATUS.has(res.status) || attempt === maxRetries) {
        return res;
      }

      const delay = calcDelay(
        attempt,
        res.headers.get('retry-after'),
        baseDelay
      );
      await res.text().catch(() => {});

      stats.retriedRequests += 1;
      if (onRetry) onRetry(res.status, attempt + 1, delay);
      await sleep(delay);
      lastResponse = res;
    } catch (e) {
      clearTimeout(timer);
      const kind = e.name === 'AbortError' ? 'timeout' : e.message;
      if (attempt === maxRetries) {
        lg.error('upstream', '上游请求最终失败', {
          attempt,
          ms: Date.now() - started,
          error: kind,
        });
        throw e;
      }
      const delay = calcDelay(attempt, null, baseDelay);
      stats.retriedRequests += 1;
      lg.warn('upstream', '上游请求异常，准备重试', {
        attempt,
        ms: Date.now() - started,
        error: kind,
        delayMs: Math.round(delay),
      });
      if (onRetry) onRetry(kind, attempt + 1, delay);
      await sleep(delay);
    }
  }
  return lastResponse;
}

/* ---------- DeepSeek SSE 文本提取 ---------- */

function extractDeepSeekText(obj) {
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(extractDeepSeekText).join('');
  if (!obj || typeof obj !== 'object') return '';

  const { p, o, v } = obj;

  if (o === 'BATCH' && Array.isArray(v)) {
    return v.map(extractDeepSeekText).join('');
  }

  if (
    v &&
    typeof v === 'object' &&
    v.response &&
    Array.isArray(v.response.fragments)
  ) {
    return v.response.fragments
      .map((f) => (typeof f.content === 'string' ? f.content : ''))
      .join('');
  }

  if (typeof v === 'string' && typeof p === 'string') {
    if (p.endsWith('/content') || p === 'response/content') {
      return o === 'APPEND' || o === 'SET' ? v : '';
    }
    return '';
  }

  if (typeof v === 'string' && p === undefined) {
    return v;
  }

  return '';
}

/* ---------- 转发到 DeepSeek ---------- */

async function forwardToDeepSeek(cfg, req, prompt, opts = {}, lg = log) {
  const body = {
    chat_session_id: opts.chatSessionId || cfg.chatSessionId,
    parent_message_id: null,
    model_type: 'default',
    prompt,
    ref_file_ids: [],
    thinking_enabled: !!opts.thinking,
    search_enabled: !!opts.search,
    action: null,
    preempt: false,
  };


  let powHeader = null;
  if (cfg.powEnabled !== false && !req.headers['x-ds-pow-response']) {
    const powStarted = Date.now();
    try {
      lg.debug('pow', '开始求解 PoW');
      powHeader = await solveAndBuildHeader(cfg);
      lg.info('pow', 'PoW 求解成功', { ms: Date.now() - powStarted });
    } catch (e) {
      lg.warn('pow', 'PoW 求解失败，将以无 PoW 头继续', {
        ms: Date.now() - powStarted,
        error: e.message,
      });
      recordError(`PoW 求解失败：${e.message}`);
    }
  } else if (req.headers['x-ds-pow-response']) {
    lg.debug('pow', '复用客户端提供的 PoW 头');
  }

  return fetchWithRetry(
    cfg.upstreamUrl,
    {
      method: 'POST',
      headers: buildUpstreamHeaders(cfg, req, powHeader),
      body: JSON.stringify(body),
    },
    cfg,
    (status, attempt, delay) => {
      lg.warn('forward', '上游可重试状态，等待后重试', {
        status,
        attempt,
        delayMs: Math.round(delay),
      });
      recordError(`上游 ${status}，已触发重试`);
    },
    lg
  );
}

/* ---------- 读取上游 SSE 事件流 ---------- */

async function* iterateDeepSeekEvents(upstream) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).replace(/^ /, '');
          if (!data) continue;
          try {
            yield JSON.parse(data);
          } catch {
            /* skip */
          }
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const chunk = buffer.replace(/\r\n/g, '\n');
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).replace(/^ /, '');
        if (!data) continue;
        try {
          yield JSON.parse(data);
        } catch {
          /* skip */
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/* ---------- OpenAI 兼容：流式 ---------- */

async function streamAsOpenAI(upstream, res, model, lg = log) {
  const id = 'chatcmpl-' + Date.now().toString(36);
  const created = Math.floor(Date.now() / 1000);
  const actualModel = model || 'deepseek-chat';

  const writeChunk = (delta, finishReason) => {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: actualModel,
      choices: [
        { index: 0, delta, finish_reason: finishReason ?? null },
      ],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  writeChunk({ role: 'assistant', content: '' }, null);

  const toolBuf = new ToolCallBuffer();
  const toolCallsOut = [];
  let toolCallIndex = 0;

  try {
    for await (const obj of iterateDeepSeekEvents(upstream)) {
      const text = extractDeepSeekText(obj);
      if (!text) continue;

      const { text: clean, toolCalls } = toolBuf.feed(text);

      if (clean) writeChunk({ content: clean }, null);

      for (const call of toolCalls) {
        toolCallsOut.push(call);
        writeChunk(
          {
            tool_calls: [
              {
                index: toolCallIndex++,
                id: 'call_' + Math.random().toString(36).slice(2, 10),
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              },
            ],
          },
          null
        );
      }
    }

    const tail = toolBuf.flush();
    if (tail.text) writeChunk({ content: tail.text }, null);
    for (const call of tail.toolCalls) {
      toolCallsOut.push(call);
      writeChunk(
        {
          tool_calls: [
            {
              index: toolCallIndex++,
              id: 'call_' + Math.random().toString(36).slice(2, 10),
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            },
          ],
        },
        null
      );
    }

    lg.info('openai-stream', '流式输出完成', {
      toolCalls: toolCallsOut.length,
    });
    writeChunk({}, toolCallsOut.length > 0 ? 'tool_calls' : 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    lg.error('openai-stream', '流式输出中断', { error: e.message });
    writeChunk({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

/* ---------- Anthropic 兼容：流式 ---------- */

async function streamAsAnthropic(upstream, res, model, lg = log) {
  const msgId = newMessageId();
  const actualModel = model || 'deepseek-chat';

  const writeEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  writeEvent('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: actualModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  // 状态机
  const toolBuf = new ToolCallBuffer();
  let blockIndex = 0;
  let currentType = null; // 'text' | 'tool_use'
  let textBlockOpen = false;
  let hasToolCall = false;
  let finished = false;

  const openTextBlock = () => {
    if (currentType === 'text' && textBlockOpen) return;
    if (currentType) {
      writeEvent('content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex,
      });
      blockIndex++;
    }
    writeEvent('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    });
    currentType = 'text';
    textBlockOpen = true;
  };

  const closeCurrentBlock = () => {
    if (currentType) {
      writeEvent('content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex,
      });
      blockIndex++;
      currentType = null;
      textBlockOpen = false;
    }
  };

  const emitTextDelta = (text) => {
    if (!text) return;
    openTextBlock();
    writeEvent('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'text_delta', text },
    });
  };

  const emitToolUse = (call) => {
    hasToolCall = true;
    closeCurrentBlock();
    const toolId = newToolUseId();

    writeEvent('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: toolId,
        name: call.name,
        input: {},
      },
    });

    writeEvent('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(call.arguments ?? {}),
      },
    });

    writeEvent('content_block_stop', {
      type: 'content_block_stop',
      index: blockIndex,
    });
    blockIndex++;
    currentType = null;
  };

  try {
    for await (const obj of iterateDeepSeekEvents(upstream)) {
      const text = extractDeepSeekText(obj);
      if (!text) continue;

      const { text: clean, toolCalls } = toolBuf.feed(text);

      if (clean) emitTextDelta(clean);
      for (const call of toolCalls) emitToolUse(call);
    }

    const tail = toolBuf.flush();
    if (tail.text) emitTextDelta(tail.text);
    for (const call of tail.toolCalls) emitToolUse(call);

    closeCurrentBlock();

    writeEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: hasToolCall ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: 0 },
    });

    writeEvent('message_stop', { type: 'message_stop' });
    res.end();
    finished = true;
    lg.info('anthropic-stream', '流式输出完成', {
      blocks: blockIndex,
      toolCalls: hasToolCall,
      stopReason: hasToolCall ? 'tool_use' : 'end_turn',
    });
  } catch (e) {
    lg.error('anthropic-stream', '流式输出异常', {
      error: e.message,
      stack: e.stack?.split('\n').slice(0, 4).join(' | '),
    });
    if (!finished) {
      writeEvent('error', {
        type: 'error',
        error: { type: 'api_error', message: e.message },
      });
      res.end();
    }
  }
}

/* ---------- 非流式收集 ---------- */

async function collectDeepSeek(upstream) {
  const toolBuf = new ToolCallBuffer();
  let acc = '';

  for await (const obj of iterateDeepSeekEvents(upstream)) {
    const text = extractDeepSeekText(obj);
    if (!text) continue;
    const { text: clean, toolCalls } = toolBuf.feed(text);
    acc += clean;
    if (toolCalls.length > 0) {
      // 非流式下也累积到 buffer，最后一起解析
      // 为简化，把 toolCalls 拼回 buffer（不会发生，因为已解析）
    }
  }

  const tail = toolBuf.flush();
  acc += tail.text;

  return { text: acc, toolCalls: tail.toolCalls };
}

/* ---------- 配置管理 API ---------- */

app.get('/admin/api/config', (req, res) => {
  res.json({
    config: publicConfig(),
    runtime: {
      ...stats,
      uptimeMs: Date.now() - stats.startedAt,
      pid: process.pid,
      node: process.version,
      configPath: CONFIG_PATH,
    },
  });
});

app.put('/admin/api/config', (req, res) => {
  try {
    const before = getConfig();
    const beforeAddr = `${before.host}:${before.port}`;

    updateConfig(req.body || {});

    const after = getConfig();
    const restartRequired = `${after.host}:${after.port}` !== beforeAddr;

    res.json({ ok: true, config: publicConfig(), restartRequired });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/admin/api/test', async (req, res) => {
  const cfg = getConfig();
  const started = Date.now();

  try {
    const upstream = await forwardToDeepSeek(cfg, req, 'ping', {
      chatSessionId: cfg.chatSessionId || crypto.randomUUID(),
    });

    const text = await upstream.text();
    res.json({
      ok: upstream.ok,
      status: upstream.status,
      ms: Date.now() - started,
      preview: text.slice(0, 800),
    });
  } catch (e) {
    res.json({
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: e.name === 'AbortError' ? '请求超时' : e.message,
    });
  }
});

/* ---------- 原生端点（保留，直连 DeepSeek） ---------- */

app.post('/api/v0/chat/completion', async (req, res) => {
  const cfg = getConfig();
  const rid = newRequestId();
  const lg = makeLog('native', rid);
  const started = Date.now();
  stats.totalRequests += 1;
  stats.lastRequestAt = Date.now();
  lg.info('native', '收到请求', {
    ip: req.ip,
    stream: true,
    sessionId: req.body?.chat_session_id || cfg.chatSessionId || '(空)',
    body: dumpBody(req.body),
  });

  try {
    await throttle();
    await waitForInterval();

    const body = { ...req.body };
    if (!body.chat_session_id && cfg.chatSessionId) {
      body.chat_session_id = cfg.chatSessionId;
    }

    let powHeader = null;
    if (cfg.powEnabled !== false && !req.headers['x-ds-pow-response']) {
      const powStarted = Date.now();
      try {
        powHeader = await solveAndBuildHeader(cfg);
        lg.debug('pow', 'PoW 求解成功', { ms: Date.now() - powStarted });
      } catch (e) {
        lg.warn('pow', 'PoW 求解失败，将以无 PoW 头继续', {
          ms: Date.now() - powStarted,
          error: e.message,
        });
        recordError(`PoW 求解失败：${e.message}`);
      }
    }

    const upstream = await fetchWithRetry(
      cfg.upstreamUrl,
      {
        method: 'POST',
        headers: buildUpstreamHeaders(cfg, req, powHeader),
        body: JSON.stringify(body),
      },
      cfg,
      (status, attempt, delay) => {
        lg.warn('native', '上游可重试状态，等待后重试', {
          status,
          attempt,
          delayMs: Math.round(delay),
        });
      },
      lg
    );

    if (!upstream) throw new Error('上游无响应');

    res.status(upstream.status);

    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);

    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');

    if (!upstream.body) {
      const text = await upstream.text();
      if (upstream.ok) stats.successRequests += 1;
      else {
        stats.failedRequests += 1;
        recordError(`上游 HTTP ${upstream.status}`);
      }
      res.end(text);
      return;
    }

    if (upstream.ok) stats.successRequests += 1;
    else {
      stats.failedRequests += 1;
      recordError(`上游 HTTP ${upstream.status}`);
    }

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    stats.failedRequests += 1;
    const msg = e.name === 'AbortError' ? '请求超时' : e.message;
    recordError(msg);
    if (!res.headersSent) res.status(502).json({ error: msg });
    else res.end();
  }
});

/* ---------- OpenAI 兼容端点 ---------- */

app.post('/v1/chat/completions', async (req, res) => {
  const cfg = getConfig();
  const rid = newRequestId();
  const lg = makeLog('openai', rid);
  const started = Date.now();
  stats.totalRequests += 1;
  stats.lastRequestAt = Date.now();
  lg.info('收到请求', {
    model: req.body?.model,
    stream: !!req.body?.stream,
    messages: req.body?.messages?.length ?? 0,
    tools: req.body?.tools?.length ?? 0,
    body: dumpBody(req.body),
  });

  try {
    await throttle();
    await waitForInterval();

    const prompt = buildPromptFromMessages(
      req.body.messages,
      extractSystemText(req.body.system),
      formatToolsInstruction(req.body.tools)
    );

    if (!prompt) {
      lg.warn('请求缺少用户消息', { body: preview(dumpBody(req.body), 300) });
      res.status(400).json({
        error: {
          message: 'no user message found',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const stream = !!req.body.stream;

    const upstream = await forwardToDeepSeek(
      cfg,
      req,
      prompt,
      {
        thinking: !!req.body.thinking,
        search: !!req.body.search,
      },
      lg
    );

    if (!upstream) throw new Error('上游无响应');

    if (!upstream.ok) {
      const text = await upstream.text();
      stats.failedRequests += 1;
      recordError(`上游 HTTP ${upstream.status}`);
      lg.warn('上游返回错误', {
        status: upstream.status,
        body: preview(text, 300),
      });
      res.status(upstream.status).json({
        error: {
          message: text.slice(0, 800) || `upstream ${upstream.status}`,
          type: 'upstream_error',
        },
      });
      return;
    }

    stats.successRequests += 1;

    if (stream) {
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      await streamAsOpenAI(upstream, res, req.body.model, lg);
    } else {
      const { text, toolCalls } = await collectDeepSeek(upstream);
      const toolCallsOut =
        toolCalls.length > 0
          ? toolCalls.map((c, i) => ({
              index: i,
              id: 'call_' + Math.random().toString(36).slice(2, 10),
              type: 'function',
              function: {
                name: c.name,
                arguments: JSON.stringify(c.arguments),
              },
            }))
          : undefined;

      res.json({
        id: 'chatcmpl-' + Date.now().toString(36),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: req.body.model || 'deepseek-chat',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text || (toolCallsOut ? null : ''),
              tool_calls: toolCallsOut,
            },
            finish_reason: toolCallsOut ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  } catch (e) {
    stats.failedRequests += 1;
    const msg = e.name === 'AbortError' ? '请求超时' : e.message;
    recordError(msg);
    lg.error('请求处理失败', { error: msg, ms: Date.now() - started });
    if (!res.headersSent) {
      res.status(502).json({ error: { message: msg, type: 'proxy_error' } });
    } else {
      res.end();
    }
  }
});

/* ---------- Anthropic 兼容端点 ---------- */

app.post('/v1/messages', async (req, res) => {
  const cfg = getConfig();
  const rid = newRequestId();
  const lg = makeLog('anthropic', rid);
  stats.totalRequests += 1;
  stats.lastRequestAt = Date.now();
  lg.info('收到请求', {
    model: req.body?.model,
    stream: req.body?.stream !== false,
    messages: req.body?.messages?.length ?? 0,
    tools: req.body?.tools?.length ?? 0,
    body: dumpBody(req.body),
  });

  try {
    await throttle();
    await waitForInterval();

    const prompt = buildPromptFromMessages(
      req.body.messages,
      extractSystemText(req.body.system),
      formatToolsInstruction(req.body.tools)
    );

    if (!prompt) {
      res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'no user message found',
        },
      });
      return;
    }

    const stream = req.body.stream !== false;

    const upstream = await forwardToDeepSeek(
      cfg,
      req,
      prompt,
      {
        thinking: !!req.body.thinking,
        search: !!req.body.search,
      },
      lg
    );

    if (!upstream) throw new Error('上游无响应');

    if (!upstream.ok) {
      const text = await upstream.text();
      stats.failedRequests += 1;
      recordError(`上游 HTTP ${upstream.status}`);
      lg.warn('上游返回错误', {
        status: upstream.status,
        body: preview(text, 300),
      });
      res.status(upstream.status).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: text.slice(0, 800) || `upstream ${upstream.status}`,
        },
      });
      return;
    }

    stats.successRequests += 1;

    if (stream) {
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      lg.info('开始流式输出', { model: req.body.model });
      await streamAsAnthropic(upstream, res, req.body.model, lg);
    } else {
      const { text, toolCalls } = await collectDeepSeek(upstream);

      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const call of toolCalls) {
        content.push({
          type: 'tool_use',
          id: newToolUseId(),
          name: call.name,
          input: call.arguments ?? {},
        });
      }

      res.json({
        id: newMessageId(),
        type: 'message',
        role: 'assistant',
        model: req.body.model || 'deepseek-chat',
        content,
        stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    }
  } catch (e) {
    stats.failedRequests += 1;
    const msg = e.name === 'AbortError' ? '请求超时' : e.message;
    recordError(msg);
    if (!res.headersSent) {
      res.status(502).json({
        type: 'error',
        error: { type: 'api_error', message: msg },
      });
    } else {
      res.end();
    }
  }
});

/* ---------- 页面路由 ---------- */

app.get('/test', (req, res) => res.redirect('/admin/test.html'));
app.use('/admin', express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/admin/'));

/* ---------- 启动 ---------- */

const cfg = getConfig();

app.listen(cfg.port, cfg.host, () => {
  log.info(`代理服务:   http://${cfg.host}:${cfg.port}`);
  log.info(`配置页面:   http://${cfg.host}:${cfg.port}/admin`);
  log.info(`测试页面:   http://${cfg.host}:${cfg.port}/test`);
  log.info(`OpenAI:    http://${cfg.host}:${cfg.port}/v1/chat/completions`);
  log.info(`Anthropic: http://${cfg.host}:${cfg.port}/v1/messages`);
  log.info(`配置文件:   ${CONFIG_PATH}`);
  log.info(`日志文件:   ${LOG_TO_FILE ? LOG_FILE : '(已关闭)'}`);
  log.info(`PoW 自动求解: ${cfg.powEnabled !== false ? '已开启' : '已关闭'}`);
});