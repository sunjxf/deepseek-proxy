/**
 * client.js - 上游请求
 *
 * 原样取自 server.js：buildUpstreamHeaders / fetchWithRetry / forwardToDeepSeek。
 * 依赖 pow.js（PoW 求解）、stats.js（错误记录）。
 */

import { solveAndBuildHeader } from '../pow.js';
import { recordError, stats } from '../stats.js';
import { makeLog } from '../logger.js';

const log = makeLog('proxy');

/* ---------- 上游请求头 ---------- */

export function buildUpstreamHeaders(cfg, req, powHeader) {
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
    'x-client-version': '2.7.0',
  };

  if (cfg.authorization) headers.authorization = cfg.authorization;

  const pow = req.headers['x-ds-pow-response'] || powHeader;
  if (pow) headers['x-ds-pow-response'] = pow;

  return headers;
}

/* ---------- 带重试的 fetch ---------- */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * 估算请求体字节数用于日志。
 *
 * options.body 可能是 string / Buffer / FormData / ReadableStream；
 * Buffer.byteLength() 只接受前两者，对其他类型会抛 TypeError，
 * 所以这里按类型分派，拿不到大小时返回 undefined。
 */
function bodyByteLength(body) {
  if (!body) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body) || ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  // FormData / ReadableStream 等：大小由 fetch 内部序列化时才知道
  return undefined;
}

function calcDelay(attempt, retryAfterHeader, baseDelay) {
  if (retryAfterHeader) {
    const sec = Number(retryAfterHeader);
    if (!Number.isNaN(sec) && sec > 0) return Math.min(sec * 1000, 30_000);
  }
  const base = baseDelay * 2 ** attempt;
  const jitter = Math.random() * 500;
  return Math.min(base + jitter, 16_000);
}

export async function fetchWithRetry(url, options, cfg, onRetry, lg = log) {
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
        bodyBytes: bodyByteLength(options.body),
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

/* ---------- 转发到 DeepSeek ---------- */

export async function forwardToDeepSeek(cfg, req, prompt, opts = {}, lg = log) {
  const body = {
    chat_session_id: opts.sessionId || opts.chatSessionId || cfg.chatSessionId,
    parent_message_id: null,
    model_type: 'default',
    prompt,
    ref_file_ids: Array.isArray(opts.refFileIds) ? opts.refFileIds : [],
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

  lg.debug('forward', '上游请求参数', {
    sessionId: body.chat_session_id,
    promptChars: prompt.length,
    refFileIds: body.ref_file_ids.length,
    thinking: body.thinking_enabled,
    search: body.search_enabled,
  });

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

/* ---------- 工具 ---------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
