/**
 * sse.js - DeepSeek SSE 解析
 *
 * 原样取自 server.js 的 iterateDeepSeekEvents() / extractDeepSeekText()。
 */

import { ToolCallBuffer } from '../tools/buffer.js';

/* ---------- DeepSeek SSE 文本提取 ---------- */

export function extractDeepSeekText(obj) {
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

/* ---------- 读取上游 SSE 事件流 ---------- */

export async function* iterateDeepSeekEvents(upstream) {
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

/* ---------- 非流式收集 ---------- */

// 原样取自 server.js 的 collectDeepSeek()。
// ToolCallBuffer 是纯逻辑模块，不反向依赖 sse 层，这里直接 import。
export async function collectDeepSeek(upstream, lg) {
  const toolBuf = new ToolCallBuffer();
  let rawAll = '';
  let acc = '';

  for await (const obj of iterateDeepSeekEvents(upstream)) {
    const text = extractDeepSeekText(obj);
    if (!text) continue;
    const { text: clean } = toolBuf.feed(text);
    rawAll += text;
    acc += clean;
  }

  const tail = toolBuf.flush();
  acc += tail.text;

  lg?.debug(
    'collect',
    `原始 ${rawAll.length} 字符，正文 ${acc.length} 字符，工具调用 ${tail.toolCalls.length}`
  );

  return { text: acc, toolCalls: tail.toolCalls, rawAll };
}
