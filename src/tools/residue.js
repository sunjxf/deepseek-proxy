/**
 * residue.js - 工具标签正则常量与残留清洗
 *
 * 从 tools.js 抽出：所有正则常量、字符串状态机、DSML 扫描辅助、
 * 残留剥离函数。parse.js / buffer.js / prompt.js 都从这里导入，
 * 避免它们互相引用形成环。
 */

/* ---------- 基础常量 ---------- */

const PIPE = '｜';
const PIPE_CLASS = `[${PIPE}|]`;
const DSML = `${PIPE_CLASS}{2}DSML${PIPE_CLASS}{2}`;

export { PIPE, PIPE_CLASS, DSML };

export const TOOL_CALL_START = '<tool_call>';
export const TOOL_CALL_END = '</tool_call>';
export const DSML_CALLS_START = `<${PIPE}${PIPE}DSML${PIPE}${PIPE} calls>`;
export const DSML_CALLS_END = `</${PIPE}${PIPE}DSML${PIPE}${PIPE} calls>`;

export const RE_CALLS_START = new RegExp(`<${DSML}\\s*calls\\s*>`);
export const RE_CALLS_END = new RegExp(`</${DSML}\\s*calls\\s*>`);
export const RE_DSML_ANY_TAG = new RegExp(`<\\s*/?\\s*${DSML}\\s*\\w+[^>]*>`, 'g');
export const RE_DSML_CLOSE_SEQ = new RegExp(
  `(?:<\\s*/\\s*${DSML}\\s*\\w+\\s*>\\s*)+`,
  'g'
);
export const RE_TOOL_CALL_ANY_TAG = /<\s*\/?\s*tool_call\b[^>]*>/gi;

// 放宽后的 tool_result 正则：去掉 \b、去掉前置检查依赖、兼容可选属性
export const RE_TOOL_RESULT_BLOCK =
  /<\s*tool_result(?:\s[^>]*)?\s*>[\s\S]*?<\s*\/\s*tool_result\s*>/gi;
export const RE_TOOL_RESULT_TAG = /<\s*\/?\s*tool_result(?:\s[^>]*)?\s*>/gi;
export const RE_RESULT_TAG = /<\s*\/?\s*result(?:\s[^>]*)?\s*>/gi;

export const RE_DSML_INVOKE_SCAN = new RegExp(
  `<\\s*(/)?\\s*${DSML}\\s*invoke\\b([^>]*)>`,
  'g'
);
export const RE_DSML_PARAM_SCAN = new RegExp(
  `<\\s*(/)?\\s*${DSML}\\s*parameter\\b([^>]*)>`,
  'g'
);

/* ---------- 字符串状态机 ---------- */

export function scanOutsideString(text, token, from = 0) {
  const positions = [];
  if (!text || !token) return positions;
  let inString = false;
  let escape = false;
  let i = from;
  const len = text.length;
  const tlen = token.length;

  while (i < len) {
    const c = text[i];

    if (inString) {
      if (escape) { escape = false; i++; continue; }
      if (c === '\\') { escape = true; i++; continue; }
      if (c === '"') { inString = false; i++; continue; }
      i++;
      continue;
    }

    if (c === '"') { inString = true; i++; continue; }

    if (c === token[0] && text.startsWith(token, i)) {
      positions.push(i);
      i += tlen;
      continue;
    }

    i++;
  }

  return positions;
}

export function isOutsideString(text, pos) {
  if (!text || pos <= 0) return true;
  let inString = false;
  let escape = false;
  const limit = Math.min(pos, text.length);
  for (let i = 0; i < limit; i++) {
    const c = text[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = false; continue; }
      continue;
    }
    if (c === '"') { inString = true; }
  }
  return !inString;
}

/* ---------- 清理 JSON 字符串内的裸换行 ---------- */

export function fixRawNewlinesInJson(text) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) { out += c; escape = false; continue; }
      if (c === '\\') { out += c; escape = true; continue; }
      if (c === '"') { out += c; inString = false; continue; }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
      out += c;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    out += c;
  }
  return out;
}

/* ---------- DSML 辅助函数 ---------- */

export function findDsmlCallsStart(haystack, fromIndex = 0) {
  const re = new RegExp(RE_CALLS_START.source, 'g');
  re.lastIndex = fromIndex;
  const m = re.exec(haystack);
  return m ? { index: m.index, length: m[0].length } : null;
}

export function findDsmlCallsEndStrict(haystack, fromIndex) {
  const re = new RegExp(RE_CALLS_END.source, 'g');
  let searchFrom = fromIndex;
  while (true) {
    re.lastIndex = searchFrom;
    const m = re.exec(haystack);
    if (!m) return null;
    const body = haystack.slice(fromIndex, m.index);
    if (scanDsmlInvokeBlocks(body) !== null) {
      return { index: m.index, length: m[0].length };
    }
    searchFrom = m.index + m[0].length;
  }
}

export function isPartialDsmlCallsStart(s) {
  if (!s.startsWith('<')) return false;
  if (s.includes('>')) return false;
  if (s.length === 1) return true;
  let i = 1;
  if (s[i] === '/') i++;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (i >= s.length) return true;
  const ch = s[i];
  return ch === PIPE || ch === '|';
}

export function stripDsmlResidue(text) {
  if (!text || text.indexOf('DSML') === -1) return text;
  return text.replace(RE_DSML_ANY_TAG, '');
}

export function stripToolResultResidue(text) {
  if (!text) return text;
  // 去掉前置检查：前置检查用的正则一旦因不可见字符失效，
  // 整个清理都会被跳过。改成无条件执行 replace。
  return text
    .replace(RE_TOOL_RESULT_BLOCK, '')
    .replace(RE_TOOL_RESULT_TAG, '')
    .replace(RE_RESULT_TAG, '');
}

export function sanitizeText(text) {
  return stripToolResultResidue(stripDsmlResidue(text));
}

export function stripToolCallResidue(text) {
  if (!text) return text;
  let s = sanitizeText(text);
  if (/tool_call/i.test(s)) {
    s = s.replace(RE_TOOL_CALL_ANY_TAG, '');
  }
  return s;
}

/* ---------- DSML 结构扫描 ---------- */

export function scanDsmlInvokeBlocks(body) {
  if (body == null) return null;
  const re = new RegExp(RE_DSML_INVOKE_SCAN.source, 'g');
  const blocks = [];
  let depth = 0;
  let current = null;
  let m;

  while ((m = re.exec(body)) !== null) {
    const isClose = !!m[1];
    const attrs = m[2];

    if (!isClose) {
      if (depth === 0) {
        const nameMatch = /name\s*=\s*"([^"]+)"/.exec(attrs);
        if (!nameMatch) return null;
        current = { name: nameMatch[1], bodyStart: re.lastIndex, end: -1 };
      }
      depth++;
    } else {
      if (depth === 0) return null;
      depth--;
      if (depth === 0 && current) {
        current.end = m.index;
        blocks.push(current);
        current = null;
      }
    }
  }

  if (depth !== 0 || current) return null;
  return blocks;
}

export function scanDsmlParameters(invokeBody) {
  if (invokeBody == null) return [];
  const re = new RegExp(RE_DSML_PARAM_SCAN.source, 'g');
  const blocks = [];
  let depth = 0;
  let current = null;
  let m;

  while ((m = re.exec(invokeBody)) !== null) {
    const isClose = !!m[1];
    const attrs = m[2];

    if (!isClose) {
      if (depth === 0) {
        const nameMatch = /name\s*=\s*"([^"]+)"/.exec(attrs);
        if (!nameMatch) return null;
        current = { name: nameMatch[1], attrs, valueStart: re.lastIndex, end: -1 };
      }
      depth++;
    } else {
      if (depth === 0) return null;
      depth--;
      if (depth === 0 && current) {
        current.end = m.index;
        blocks.push(current);
        current = null;
      }
    }
  }

  if (depth !== 0 || current) return null;
  return blocks;
}
