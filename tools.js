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
 */

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

// 任意 DSML 标签（开或关），用于清理残留
const RE_DSML_ANY_TAG = new RegExp(`</?${DSML}\\s*\\w+[^>]*>`, 'g');
// DSML 关闭标签序列（parameter / invoke / calls 连续出现）
const RE_DSML_CLOSE_SEQ = new RegExp(`(?:</${DSML}\\s*\\w+\\s*>\\s*)+`, 'g');

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
  const second = s[1];
  return second === PIPE || second === '|';
}

/**
 * 剥离正文里残留的 DSML 标签。
 * 只在文本里确实含 "DSML" 时才做替换，避免无谓开销。
 * 处理对象包括：
 *   - 成对的开/闭标签
 *   - 孤立的关闭标签（如 </｜｜DSML｜｜ invoke>）
 *   - 孤立的开始标签（未闭合）
 */
function stripDsmlResidue(text) {
  if (!text || text.indexOf('DSML') === -1) return text;
  return text.replace(RE_DSML_ANY_TAG, '');
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

  return parts.filter(Boolean).join('\n\n');
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
      const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
      parts.push(`（此前调用过工具 ${name}，参数 ${argsStr}）`);
    }
  }
  return parts.filter(Boolean).join('\n');
}

function formatUserContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');

  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block.type === 'text') {
      parts.push(block.text || '');
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
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c?.type === 'text') return c.text || '';
        if (c?.type === 'image') return '[图片]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
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
        if (calls) out.toolCalls.push(...calls);
        else out.text += stripDsmlResidue(this.buffer.slice(pos, consumedEnd));

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
        if (calls.length > 0) out.toolCalls.push(...calls);
        else out.text += stripDsmlResidue(this.buffer.slice(pos, endIdx + endLen));
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
        if (calls.length > 0) out.toolCalls.push(...calls);
        else out.text += stripDsmlResidue(body);
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
        out.toolCalls.push(...calls);
        this.buffer = '';
        return this._finish(out);
      }
    }

    out.text = this.buffer;
    this.buffer = '';
    return this._finish(out);
  }

  _finish(out) {
    if (out.text) out.text = stripDsmlResidue(out.text);
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

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    const cleaned = body.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return null;
    }
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