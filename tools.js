/**
 * tools.js - 工具调用支持
 *
 * 支持两种工具调用格式：
 *   1. 我们要求的：<tool_call>[{"name": "Bash", "arguments": {...}}]</tool_call>
 *   2. DeepSeek 原生：<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="Bash">...</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>
 *
 * 模型输出格式不稳定，解析器需要容忍：
 *   - 竖线与标签名之间空白数不定（无空格 / 一个 / 多个）
 *   - 全角竖线 U+FF5C 与半角竖线 | 混用
 *   - <tool_call> 开头却用 DSML 标签收尾
 *   - 没有 <｜｜DSML｜｜ calls> 外层包裹的裸 invoke
 *   - 正文中残留的孤立 DSML 开/闭标签（含只有关闭标签的情况）
 *   - < 与 / 或 DSML 之间出现空白（如 </ ｜｜DSML｜｜ invoke>、< / ｜｜DSML｜｜ calls>）
 *   - 正文中残留的孤立 <tool_call> / </tool_call> 标签
 *   - 正文中残留的 <tool_result>...</result> / <tool_result> 标签
 *   - JSON 括号少写/多写一层（balanceBrackets 兜底）
 */

/* ---------- 日志 ---------- */

// 可选的日志回调，由调用方注入（如 server.js 的 makeLog），默认静默
let logger = null;
export function setToolLogger(fn) {
  logger = typeof fn === 'function' ? fn : null;
}
function tlog(level, msg, extra) {
  if (!logger) return;
  try {
    logger(level, msg, extra);
  } catch {
    /* 日志本身不能影响解析 */
  }
}

// 截断长文本用于日志
function tp(text, len = 160) {
  if (text == null) return '';
  const s = String(text).replace(/\s+/g, ' ');
  return s.length > len ? s.slice(0, len) + `…(${s.length}字符)` : s;
}

/* ---------- 转换前后日志 ---------- */

// 输出转换前/转换后的摘要，只在内容真的变化时才打。
// 完整内容只在 debug 级别输出，避免默认日志被长对话刷屏。
// 只用于请求级别的转换点（消息格式化、prompt 构造），
// 不用于流式 chunk 路径，避免刷屏。
function logTransform(label, before, after) {
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
function formatCalls(calls) {
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

// 全角竖线 U+FF5C，DeepSeek 的 DSML 使用它
const PIPE = '\uFF5C';

// 竖线字符类：全角或半角
const PIPE_CLASS = `[${PIPE}|]`;
// DSML 标记片段：两个竖线 + DSML + 两个竖线
const DSML = `${PIPE_CLASS}{2}DSML${PIPE_CLASS}{2}`;

export const TOOL_CALL_START = '<tool_call>';
export const TOOL_CALL_END = '</tool_call>';

// 快速定位用的字面量（保留最常见形式，供外部兼容）
export const DSML_CALLS_START = `<${PIPE}${PIPE}DSML${PIPE}${PIPE} calls>`;
export const DSML_CALLS_END = `</${PIPE}${PIPE}DSML${PIPE}${PIPE} calls>`;

// 解析用正则（对空白宽容）
const RE_CALLS_START = new RegExp(`<${DSML}\\s*calls\\s*>`);
const RE_CALLS_END = new RegExp(`</${DSML}\\s*calls\\s*>`);
const RE_INVOKE_OPEN = new RegExp(`<${DSML}\\s*invoke\\s+name\\s*=\\s*"([^"]+)"[^>]*>`, 'g');
const RE_INVOKE_OPEN_ANCHORED = new RegExp(`^<${DSML}\\s*invoke\\s+name\\s*=`);
const RE_INVOKE_CLOSE = new RegExp(`</${DSML}\\s*invoke\\s*>`, 'g');
const RE_PARAM_OPEN = new RegExp(`<${DSML}\\s*parameter\\s+name\\s*=\\s*"([^"]+)"([^>]*)>`, 'g');
const RE_PARAM_CLOSE = new RegExp(`</${DSML}\\s*parameter\\s*>`, 'g');

// 任意 DSML 标签（开或关），用于清理残留。
// 关键：< 与 / 与 DSML 之间允许空白，容忍：
//   </｜｜DSML｜｜ invoke>
//   </ ｜｜DSML｜｜ invoke>
//   < / ｜｜DSML｜｜ calls>
//   <｜｜DSML｜｜ invoke>
const RE_DSML_ANY_TAG = new RegExp(`<\\s*/?\\s*${DSML}\\s*\\w+[^>]*>`, 'g');
// DSML 关闭标签序列（parameter / invoke / calls 连续出现），同样容忍空白
const RE_DSML_CLOSE_SEQ = new RegExp(
  `(?:<\\s*/\\s*${DSML}\\s*\\w+\\s*>\\s*)+`,
  'g'
);
// 任意 <tool_call> / </tool_call> 标签（含带属性、大小写混用、带空白），用于清理残留
const RE_TOOL_CALL_ANY_TAG = /<\s*\/?\s*tool_call\b[^>]*>/gi;

// <tool_result>...</result> / <tool_result>...</tool_result> 成块删除
const RE_TOOL_RESULT_BLOCK =
  /<\s*tool_result\b[^>]*>[\s\S]*?<\s*\/\s*(?:tool_result|result)\s*>/gi;
// 孤立的 <tool_result> / </tool_result> / </result> 标签
const RE_TOOL_RESULT_TAG = /<\s*\/?\s*(?:tool_result|result)\b[^>]*>/gi;

function findDsmlCallsStart(haystack, fromIndex = 0) {
  const re = new RegExp(RE_CALLS_START.source, 'g');
  re.lastIndex = fromIndex;
  const m = re.exec(haystack);
  return m ? { index: m.index, length: m[0].length } : null;
}

function findDsmlCallsEnd(haystack, fromIndex = 0) {
  const re = new RegExp(RE_CALLS_END.source, 'g');
  re.lastIndex = fromIndex;
  const m = re.exec(haystack);
  return m ? { index: m.index, length: m[0].length } : null;
}

function isPartialDsmlCallsStart(s) {
  if (!s.startsWith('<')) return false;
  if (s.includes('>')) return false;
  if (s.length === 1) return true;
  // 跳过 < 之后可能出现的 / 与空白，看是否正在形成 DSML：
  //   "< / "、"</"、"<" 都算前缀
  let i = 1;
  if (s[i] === '/') i++;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (i >= s.length) return true; // 还在空白里，继续等
  const ch = s[i];
  return ch === PIPE || ch === '|';
}

/**
 * 剥离正文里残留的 DSML 标签。
 *
 * 注意：该函数在流式路径上每个 chunk 都会调用一次，不打日志。
 */
function stripDsmlResidue(text) {
  if (!text || text.indexOf('DSML') === -1) return text;
  return text.replace(RE_DSML_ANY_TAG, '');
}

/**
 * 剥离正文里残留的 <tool_result>...</result> 标签。
 * 模型会把 [工具结果 ...] 学成这种伪标签，必须清掉以免下一轮继续模仿。
 *
 * 注意：该函数在流式路径上每个 chunk 都会调用一次（经 sanitizeText），不打日志。
 */
function stripToolResultResidue(text) {
  if (!text) return text;
  if (!/<\s*\/?\s*(?:tool_result|result)\b/i.test(text)) return text;
  return text
    .replace(RE_TOOL_RESULT_BLOCK, '')
    .replace(RE_TOOL_RESULT_TAG, '');
}

// 组合清洗：DSML + tool_result
function sanitizeText(text) {
  return stripToolResultResidue(stripDsmlResidue(text));
}

/**
 * 剥离正文里残留的 DSML 标签 + tool_result 标签 + 孤立的 <tool_call> / </tool_call> 标签。
 *
 * 注意：该函数在流式路径上每个 chunk 都会调用一次（经 ToolCallBuffer._finish），
 * 不打日志，避免刷屏。
 */
function stripToolCallResidue(text) {
  if (!text) return text;
  let s = sanitizeText(text);
  if (/tool_call/i.test(s)) {
    s = s.replace(RE_TOOL_CALL_ANY_TAG, '');
  }
  return s;
}

/* ---------- Prompt 构造 ---------- */

export function formatToolsInstruction(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';

  const simplified = tools.map((t) => {
    const name = t.name || t.function?.name || 'unknown';
    const description = t.description || t.function?.description || '';
    const schema = t.input_schema || t.function?.parameters || {};
    return { name, description, parameters: schema };
  });

  return [
    '# 可用工具',
    JSON.stringify(simplified, null, 2),
    '',
    '# 工具调用格式',
    '需要调用工具时，严格按以下格式输出（不要有任何额外说明文字）：',
    `${TOOL_CALL_START}[{"name": "工具名", "arguments": {"参数名": "值"}}]${TOOL_CALL_END}`,
    '',
    '规则：',
    '1. arguments 必须是合法 JSON 对象，不能是字符串',
    '2. 可以一次输出多个工具调用，放在同一个 JSON 数组里',
    '3. 不需要调用工具时，直接正常回复文本',
    '4. 不要自己编造工具执行结果，工具结果会由系统返回',
    '5. 输出 JSON 前请自检括号是否一一对应，尤其是嵌套的对象和数组',
  ].join('\n');
}

/* ---------- messages / system 处理 ---------- */

export function extractSystemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === 'string' ? b : b?.text || ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

export function buildPromptFromMessages(messages, systemText, toolsInstruction) {
  const parts = [];
  if (systemText) parts.push(systemText);
  if (toolsInstruction) parts.push(toolsInstruction);

  const history = formatHistory(messages);
  if (history) parts.push(history);

  const prompt = parts.filter(Boolean).join('\n\n');

  logTransform(
    'buildPromptFromMessages',
    JSON.stringify({ system: systemText, toolsInstruction, messages }),
    prompt
  );

  return prompt;
}

function formatHistory(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const lines = [];
  for (const msg of messages) {
    if (!msg || !msg.role) continue;

    if (msg.role === 'system') continue; // system 已单独处理

    if (msg.role === 'user') {
      lines.push(`[用户]\n${formatUserContent(msg.content)}`);
    } else if (msg.role === 'assistant') {
      const text = formatAssistantContent(msg.content, msg.tool_calls);
      if (text) lines.push(`[助手]\n${text}`);
    } else if (msg.role === 'tool') {
      const inner = formatUserContent(msg.content);
      lines.push(`[工具结果 tool_call_id=${msg.tool_call_id || '?'}]\n${inner}`);
    }
  }

  return lines.join('\n\n');
}

function formatAssistantContent(content, toolCalls) {
  const parts = [];
  if (content) parts.push(formatUserContent(content));
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const name = tc.function?.name || tc.name || '?';
      const args = tc.function?.arguments ?? tc.arguments ?? {};
      // 只保留参数摘要，避免长 JSON 污染上下文，也避免诱导模型模仿出错格式
      parts.push(`（此前调用过工具 ${name}，参数摘要：${summarizeArgs(args)}）`);
    }
  }
  const out = parts.filter(Boolean).join('\n');

  logTransform(
    'formatAssistantContent',
    JSON.stringify({ content, tool_calls: toolCalls }),
    out
  );

  return out;
}

/**
 * 把工具参数压成一行摘要，用于历史复述。
 *
 * - 字符串值超过 40 字符截断，并标注原长度
 * - 数组标注项数，对象标注字段数
 * - 最终整行超过 200 字符再截断
 */
function summarizeArgs(args) {
  let obj = args;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      obj = null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    const s = String(args ?? '');
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  }

  const parts = Object.keys(obj).map((k) => {
    const v = obj[k];
    if (typeof v === 'string') {
      const s = v.length > 40 ? v.slice(0, 40) + `…(${v.length}字符)` : v;
      return `${k}=${JSON.stringify(s)}`;
    }
    if (Array.isArray(v)) return `${k}=[${v.length}项]`;
    if (v && typeof v === 'object') return `${k}={${Object.keys(v).length}字段}`;
    return `${k}=${String(v)}`;
  });

  const line = parts.join(', ');
  return line.length > 200 ? line.slice(0, 200) + '…' : line;
}

function formatUserContent(content) {
  const out = formatUserContentInner(content);

  logTransform(
    'formatUserContent',
    typeof content === 'string' ? content : JSON.stringify(content),
    out
  );

  return out;
}

function formatUserContentInner(content) {
  if (typeof content === 'string') {
    // prompt 侧也清理残留标签：模型此前输出过的脏标签不应通过历史回到
    // 模型眼前，否则会形成"复述残留标签"的正反馈。
    return sanitizeText(content);
  }
  if (!Array.isArray(content)) return sanitizeText(String(content ?? ''));

  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === 'string') {
      parts.push(sanitizeText(block));
      continue;
    }
    if (block.type === 'text') {
      parts.push(sanitizeText(block.text || ''));
    } else if (block.type === 'tool_result') {
      const inner = formatToolResultContent(block.content);
      const isError = block.is_error ? '（执行失败）' : '';
      parts.push(
        `[工具结果 tool_use_id=${block.tool_use_id}${isError}]\n${inner}`
      );
    }
  }
  return parts.filter(Boolean).join('\n\n');
}

function formatToolResultContent(content) {
  if (typeof content === 'string') return sanitizeText(content);
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return sanitizeText(c);
        if (c?.type === 'text') return sanitizeText(c.text || '');
        if (c?.type === 'image') return '[图片]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return sanitizeText(String(content ?? ''));
}

/* ---------- ID 生成 ---------- */

export function newToolUseId() {
  const rand = Math.random().toString(36).slice(2, 12);
  return `toolu_${Date.now().toString(36)}${rand}`;
}

export function newMessageId() {
  const rand = Math.random().toString(36).slice(2, 12);
  return `msg_${Date.now().toString(36)}${rand}`;
}

/* ---------- 流式标签缓冲 ---------- */

export class ToolCallBuffer {
  constructor() {
    this.buffer = '';
  }

  feed(chunk) {
    if (chunk) this.buffer += chunk;
    const out = { text: '', toolCalls: [] };

    while (true) {
      const match = this._findNextStart();
      if (!match) {
        // 没有开始标签，检查是否是部分前缀
        const partial = this._findPartialStart();
        if (partial !== -1) {
          out.text += this.buffer.slice(0, partial);
          this.buffer = this.buffer.slice(partial);
          return this._finish(out);
        }
        out.text += this.buffer;
        this.buffer = '';
        return this._finish(out);
      }

      const { type, pos, len } = match;
      out.text += this.buffer.slice(0, pos);

      if (type === 'tool_call') {
        // 优先找 </tool_call>，找不到则容错接受 DSML 关闭标签序列
        let endIdx = this.buffer.indexOf(TOOL_CALL_END, pos + len);
        let consumedEnd = endIdx === -1 ? -1 : endIdx + TOOL_CALL_END.length;

        if (endIdx === -1) {
          const closeRe = new RegExp(RE_DSML_CLOSE_SEQ.source, 'g');
          closeRe.lastIndex = pos + len;
          const cm = closeRe.exec(this.buffer);
          if (cm) {
            endIdx = cm.index;
            consumedEnd = cm.index + cm[0].length;
          }
        }

        if (endIdx === -1) {
          this.buffer = this.buffer.slice(pos);
          return this._finish(out);
        }

        let body = this.buffer.slice(pos + len, endIdx).trim();
        // 二次清理：剥离混入 body 的 DSML 标签
        body = body.replace(RE_DSML_ANY_TAG, '').trim();

        const calls = parseToolCallsJson(body);
        if (calls) {
          tlog(
            'debug',
            `解析 tool_call 成功 (${calls.length}): ${calls.map((c) => c.name).join(',')}` +
              formatCalls(calls)
          );
          out.toolCalls.push(...calls);
        } else {
          tlog('warn', 'tool_call 解析失败，回退为正文', {
            body: tp(body, 200),
          });
          out.text += stripToolCallResidue(this.buffer.slice(pos, consumedEnd));
        }

        this.buffer = this.buffer.slice(consumedEnd);
      } else if (type === 'dsml_calls') {
        // 有 <｜｜DSML｜｜ calls> 外层包裹
        const endMatch = findDsmlCallsEnd(this.buffer, pos + len);
        if (!endMatch) {
          this.buffer = this.buffer.slice(pos);
          return this._finish(out);
        }
        const endIdx = endMatch.index;
        const endLen = endMatch.length;
        const body = this.buffer.slice(pos + len, endIdx);
        const calls = parseDsmlCalls(body);
        if (calls.length > 0) {
          tlog(
            'debug',
            `解析 DSML calls 成功 (${calls.length}): ${calls.map((c) => c.name).join(',')}` +
              formatCalls(calls)
          );
          out.toolCalls.push(...calls);
        } else {
          tlog('warn', 'DSML calls 解析失败，回退为正文', { body: tp(body, 200) });
          out.text += stripToolCallResidue(this.buffer.slice(pos, endIdx + endLen));
        }
        this.buffer = this.buffer.slice(endIdx + endLen);
      } else if (type === 'dsml_invoke') {
        // 无 calls 包裹：连续消费所有 invoke 块
        const consumed = this._consumeBareInvokes(pos);
        if (consumed === -1) {
          this.buffer = this.buffer.slice(pos);
          return this._finish(out);
        }
        const body = this.buffer.slice(pos, consumed);
        const calls = parseDsmlCalls(body);
        if (calls.length > 0) {
          tlog(
            'debug',
            `解析裸 DSML invoke 成功 (${calls.length}): ${calls.map((c) => c.name).join(',')}` +
              formatCalls(calls)
          );
          out.toolCalls.push(...calls);
        } else {
          tlog('warn', '裸 DSML invoke 解析失败，回退为正文', {
            body: tp(body, 200),
          });
          out.text += stripToolCallResidue(body);
        }
        this.buffer = this.buffer.slice(consumed);
      }
    }
  }

  /**
   * 从 start 开始连续消费 invoke 块。
   * 返回消费结束位置，-1 表示数据不完整（等下一 chunk）。
   */
  _consumeBareInvokes(start) {
    let cursor = start;
    const invokeOpenRe = new RegExp(
      `<${DSML}\\s*invoke\\s+name\\s*=\\s*"[^"]+"[^>]*>`,
      'g'
    );
    const invokeCloseRe = new RegExp(`</${DSML}\\s*invoke\\s*>`, 'g');

    while (true) {
      invokeOpenRe.lastIndex = cursor;
      const om = invokeOpenRe.exec(this.buffer);
      if (!om || om.index !== cursor) break;

      invokeCloseRe.lastIndex = om.index + om[0].length;
      const cm = invokeCloseRe.exec(this.buffer);
      if (!cm) return -1;
      cursor = cm.index + cm[0].length;

      // 跳过空白，看下一个是否还是 invoke
      const ws = /^\s*/.exec(this.buffer.slice(cursor))[0];
      const afterWs = cursor + ws.length;
      if (!RE_INVOKE_OPEN_ANCHORED.test(this.buffer.slice(afterWs))) {
        cursor = afterWs;
        break;
      }
      cursor = afterWs;
    }
    return cursor;
  }

  flush() {
    const out = { text: '', toolCalls: [] };
    if (!this.buffer) return out;

    // 尝试 DSML calls 包裹
    if (findDsmlCallsStart(this.buffer)) {
      const calls = parseDsmlCalls(this.buffer);
      if (calls.length > 0) {
        tlog(
          'debug',
          `flush 解析 DSML calls 成功 (${calls.length}): ${calls.map((c) => c.name).join(',')}` +
            formatCalls(calls)
        );
        out.toolCalls.push(...calls);
        this.buffer = '';
        return this._finish(out);
      }
    }

    // 尝试裸 invoke
    const bareRe = new RegExp(`<${DSML}\\s*invoke\\s+name\\s*=\\s*"[^"]+"[^>]*>`);
    if (bareRe.test(this.buffer)) {
      const calls = parseDsmlCalls(this.buffer);
      if (calls.length > 0) {
        tlog(
          'debug',
          `flush 解析裸 DSML invoke 成功 (${calls.length}): ${calls.map((c) => c.name).join(',')}` +
            formatCalls(calls)
        );
        out.toolCalls.push(...calls);
        this.buffer = '';
        return this._finish(out);
      }
    }

    // 尝试 <tool_call> + 各种收尾
    const tcStart = this.buffer.indexOf(TOOL_CALL_START);
    if (tcStart !== -1) {
      let body = this.buffer.slice(tcStart + TOOL_CALL_START.length);
      body = body
        .replace(/<\/tool_call>\s*$/i, '')
        .replace(RE_DSML_ANY_TAG, '')
        .trim();
      const calls = parseToolCallsJson(body);
      if (calls) {
        tlog(
          'debug',
          `flush 解析 <tool_call> 成功 (${calls.length}): ${calls.map((c) => c.name).join(',')}` +
            formatCalls(calls)
        );
        out.toolCalls.push(...calls);
        this.buffer = '';
        return this._finish(out);
      }
      tlog('warn', 'flush 中 <tool_call> 解析失败，回退为正文', {
        body: tp(body, 200),
      });
    } else if (this.buffer.indexOf('DSML') !== -1 || /tool_call/i.test(this.buffer)) {
      // 缓冲里有标签痕迹但没匹配到完整开始标签，通常是流被截断
      tlog('warn', 'flush 时缓冲残留未闭合的工具标签', {
        buffer: tp(this.buffer, 200),
      });
    }

    out.text = this.buffer;
    this.buffer = '';
    return this._finish(out);
  }

  _finish(out) {
    if (out.text) out.text = stripToolCallResidue(out.text);
    return out;
  }

  /** 找到下一个开始标签位置和类型 */
  _findNextStart() {
    const tcPos = this.buffer.indexOf(TOOL_CALL_START);
    const callsMatch = findDsmlCallsStart(this.buffer);
    const callsPos = callsMatch ? callsMatch.index : -1;
    const callsLen = callsMatch ? callsMatch.length : 0;

    // 裸 invoke 开标签
    const bareRe = new RegExp(`<${DSML}\\s*invoke\\s+name\\s*=\\s*"[^"]+"[^>]*>`);
    const bareMatch = bareRe.exec(this.buffer);
    const barePos = bareMatch ? bareMatch.index : -1;
    const bareLen = bareMatch ? bareMatch[0].length : 0;

    const candidates = [];
    if (tcPos !== -1)
      candidates.push({ type: 'tool_call', pos: tcPos, len: TOOL_CALL_START.length });
    if (callsPos !== -1)
      candidates.push({ type: 'dsml_calls', pos: callsPos, len: callsLen });
    if (barePos !== -1)
      candidates.push({ type: 'dsml_invoke', pos: barePos, len: bareLen });

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.pos - b.pos);
    return candidates[0];
  }

  /** 检查 buffer 末尾是否是某个开始标签的部分前缀 */
  _findPartialStart() {
    const maxLen = Math.min(this.buffer.length, TOOL_CALL_START.length - 1);
    for (let len = maxLen; len >= 1; len--) {
      const suffix = this.buffer.slice(-len);
      if (TOOL_CALL_START.startsWith(suffix)) {
        return this.buffer.length - len;
      }
    }

    const lastLt = this.buffer.lastIndexOf('<');
    if (lastLt !== -1) {
      const suffix = this.buffer.slice(lastLt);
      if (isPartialDsmlCallsStart(suffix)) {
        return lastLt;
      }
    }

    return -1;
  }
}

/* ---------- JSON 工具调用解析 ---------- */

function parseToolCallsJson(body) {
  if (!body) return null;

  let parsed = tryParseJson(body);

  // 兜底：JSON 括号少写/多写一层时尝试自动平衡
  if (parsed === undefined) {
    const fixed = balanceBrackets(body);
    if (fixed !== body) {
      const parsedFixed = tryParseJson(fixed);
      if (parsedFixed !== undefined && parsedFixed !== null) {
        tlog('warn', 'JSON 括号不匹配，已自动修复后解析成功', {
          original: tp(body),
          fixed: tp(fixed),
        });
        parsed = parsedFixed;
      }
    }
  }

  // tryParseJson 返回 undefined 表示解析失败
  if (parsed === undefined || parsed === null) {
    tlog('warn', '工具调用 JSON 解析失败，已降级为正文', { body: tp(body) });
    return null;
  }

  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const calls = [];

  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;

    const name = c.name || c.function?.name;
    let args = c.arguments ?? c.input ?? c.function?.arguments ?? {};

    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        // 保留字符串
      }
    }

    if (name) calls.push({ name, arguments: args });
  }

  return calls.length > 0 ? calls : null;
}

/**
 * 尝试解析 JSON 文本。
 * 成功返回解析结果，失败返回 undefined（用于和"解析出 null"区分）。
 */
function tryParseJson(text) {
  if (!text) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    /* fallthrough */
  }

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (cleaned !== text) {
    try {
      return JSON.parse(cleaned);
    } catch {
      /* fallthrough */
    }
  }

  return undefined;
}

/**
 * 单遍扫描，字符串感知地修复括号配对。
 *
 * 处理 LLM 输出 JSON 的典型错误：
 *   - 少写一层 } 或 ]：遇到不匹配的闭合符时，先补齐栈顶缺失的闭合符
 *   - 多写一层 } 或 ]：没有可匹配的开括号时，直接丢弃该闭合符
 *   - 末尾未闭合：按栈序补齐
 *   - 字符串未闭合：补一个 "
 *
 * 字符串内部的括号与引号不参与配对计算。
 *
 * @param {string} s 原始文本
 * @returns {string} 修复后的文本（可能和输入相同，表示无需修复）
 */
function balanceBrackets(s) {
  const stack = [];
  let inStr = false;
  let esc = false;
  let out = '';
  let changed = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }

    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }

    if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']');
      out += c;
      continue;
    }

    if (c === '}' || c === ']') {
      // 补齐所有与当前闭合符不匹配的栈顶（视为模型少写了这些闭合符）
      while (stack.length > 0 && stack[stack.length - 1] !== c) {
        out += stack.pop();
        changed = true;
      }
      if (stack.length === 0) {
        // 没有可匹配的开括号：丢弃多余的闭合符
        changed = true;
        continue;
      }
      stack.pop();
      out += c;
      continue;
    }

    out += c;
  }

  if (inStr) {
    out += '"';
    changed = true;
  }
  while (stack.length > 0) {
    out += stack.pop();
    changed = true;
  }

  return changed ? out : s;
}

/* ---------- DSML 解析 ---------- */

function parseDsmlCalls(body) {
  const calls = [];
  const openRe = new RegExp(RE_INVOKE_OPEN.source, 'g');
  const closeRe = new RegExp(RE_INVOKE_CLOSE.source, '');
  const openMatches = [];
  let m;
  while ((m = openRe.exec(body)) !== null) {
    openMatches.push({ name: m[1], start: m.index, bodyStart: openRe.lastIndex });
  }

  for (let i = 0; i < openMatches.length; i++) {
    const cur = openMatches[i];
    const next = openMatches[i + 1];
    const segment = body.slice(cur.bodyStart, next ? next.start : body.length);
    const closeMatch = closeRe.exec(segment);
    let invokeBody;
    if (closeMatch) {
      invokeBody = segment.slice(0, closeMatch.index);
    } else {
      invokeBody = segment;
    }
    calls.push(parseInvokeBlock(cur.name, invokeBody));
  }

  return calls;
}

function parseInvokeBlock(name, body) {
  const args = {};
  const openRe = new RegExp(RE_PARAM_OPEN.source, 'g');
  const closeRe = new RegExp(RE_PARAM_CLOSE.source, '');
  const openMatches = [];
  let m;
  while ((m = openRe.exec(body)) !== null) {
    openMatches.push({ name: m[1], attrs: m[2], start: m.index, valueStart: openRe.lastIndex });
  }

  for (let i = 0; i < openMatches.length; i++) {
    const cur = openMatches[i];
    const next = openMatches[i + 1];
    const segment = body.slice(cur.valueStart, next ? next.start : body.length);
    const closeMatch = closeRe.exec(segment);
    let value;
    if (closeMatch) {
      value = segment.slice(0, closeMatch.index);
    } else {
      value = segment;
    }
    args[cur.name] = coerceDsmlValue(value, cur.attrs);
  }

  return { name, arguments: args };
}

function coerceDsmlValue(value, attrs) {
  // 解析模型显式声明的类型：type="number" / type="boolean" / type="null" /
  // type="object" / type="array"，或旧式 string="true" / number="true" 等
  const explicit = readExplicitType(attrs);

  // 默认（无声明）与显式 string：一律保留字符串原文，只去首尾空白
  // 注意：不做数字/布尔推断，避免 "123"、"007" 被误转，破坏下游 schema
  if (explicit === 'string' || explicit === null) {
    return value.trim();
  }

  const trimmed = value.trim();

  switch (explicit) {
    case 'boolean':
      if (trimmed === 'true') return true;
      if (trimmed === 'false') return false;
      return trimmed;
    case 'null':
      return trimmed === 'null' ? null : trimmed;
    case 'number':
      if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed)) {
        const n = Number(trimmed);
        if (Number.isFinite(n)) return n;
      }
      return trimmed;
    case 'object':
    case 'array':
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    default:
      return value;
  }
}

/**
 * 从 DSML 参数属性串里读出显式类型声明。
 *
 * 支持两种写法：
 *   1. type="number"            —— 推荐
 *   2. string="true" / number="true" / boolean="true" / null="true"
 *      —— DeepSeek 历史写法（值恒为 "true"）
 *
 * @returns {'string'|'number'|'boolean'|'null'|'object'|'array'|null}
 *          null 表示未声明任何类型
 */
function readExplicitType(attrs) {
  if (!attrs) return null;

  // 形式 1：type="xxx"
  // 用 (?:^|\s) 而非 \b，避免误匹配 x-type="..."
  const typeMatch = /(?:^|\s)type\s*=\s*"([^"]+)"/.exec(attrs);
  if (typeMatch) {
    const t = typeMatch[1].toLowerCase();
    if (['string', 'number', 'boolean', 'null', 'object', 'array'].includes(t)) {
      return t;
    }
  }

  // 形式 2：xxx="true"
  const boolMatch = /(?:^|\s)(string|number|boolean|null|object|array)\s*=\s*"true"/i.exec(
    attrs
  );
  if (boolMatch) return boolMatch[1].toLowerCase();

  return null;
}