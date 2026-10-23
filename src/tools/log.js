/**
 * log.js - tools 层日志
 *
 * 从原 tools.js 拆出：可注入的日志回调 + 截断辅助 + 转换对照日志。
 * 由调用方（server 启动时）通过 setToolLogger 注入统一 logger；
 * 未注入时全部静默，日志本身不能影响解析。
 */

/* ---------- 日志 ---------- */

// 可选的日志回调，由调用方注入（如 server.js 的 makeLog），默认静默
let logger = null;
export function setToolLogger(fn) {
  logger = typeof fn === 'function' ? fn : null;
}
export function tlog(level, msg, extra) {
  if (!logger) return;
  try {
    logger(level, msg, extra);
  } catch {
    /* 日志本身不能影响解析 */
  }
}

// 截断长文本用于日志
export function tp(text, len = 160) {
  if (text == null) return '';
  const s = String(text).replace(/\s+/g, ' ');
  return s.length > len ? s.slice(0, len) + `…(${s.length}字符)` : s;
}

/* ---------- 转换前后日志 ---------- */

// 输出转换前/转换后的摘要，只在内容真的变化时才打。
// 完整内容只在 debug 级别输出，避免默认日志被长对话刷屏。
// 只用于请求级别的转换点（消息格式化、prompt 构造），
// 不用于流式 chunk 路径，避免刷屏。
export function logTransform(label, before, after) {
  const b = before == null ? '' : String(before);
  const a = after == null ? '' : String(after);
  if (b === a) return;

  tlog('info', `${label} 转换：${summarizeText(b)} -> ${summarizeText(a)}`);

  // 完整对照仅在 debug 级别输出
  tlog(
    'debug',
    `\n----- ${label} 转换前 (${b.length} 字符) -----\n` +
      (b || '(空)') +
      `\n----- ${label} 转换后 (${a.length} 字符) -----\n` +
      (a || '(空)') +
      `\n----- 结束 -----`
  );
}

// 把一段文本压成一行摘要：字符数、行数、首行预览
function summarizeText(text) {
  const s = text == null ? '' : String(text);
  if (!s) return '(空)';
  const lines = s.split('\n').length;
  const firstLine = s.split('\n').find((l) => l.trim()) || '';
  const preview = firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;
  return `${s.length}字符/${lines}行 「${preview}」`;
}

/* ---------- 工具调用日志格式化 ---------- */

// 把解析后的工具调用格式化成多行文本，用于 debug 日志。
// 每个调用一行：序号 名字 完整参数 JSON。
export function formatCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return '';
  return calls
    .map((c, i) => {
      let args;
      try {
        args = JSON.stringify(c.arguments ?? {});
      } catch {
        args = String(c.arguments);
      }
      return `\n  [${i + 1}] ${c.name} ${args}`;
    })
    .join('');
}