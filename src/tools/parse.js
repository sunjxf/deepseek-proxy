/**
 * parse.js - 工具调用解析（JSON / DSML）
 *
 * 从 tools.js 拆出。包含 JSON 解析与修复、DSML 结构扫描与解析。
 * 正则常量来自 ./residue.js，日志来自 ./log.js。
 */

import {
  PIPE,
  DSML,
  RE_CALLS_START,
  RE_DSML_INVOKE_SCAN,
  RE_DSML_PARAM_SCAN,
  findDsmlCallsEndStrict,
  fixRawNewlinesInJson,
} from './residue.js';
import { tlog, tp } from './log.js';

/* ---------- JSON 工具调用解析 ---------- */

export function parseToolCallsJson(body) {
  if (!body) return null;

  let parsed = tryParseJson(body);

  if (parsed === undefined) {
    const fixed = fixRawNewlinesInJson(body);
    const balanced = balanceBrackets(fixed);
    if (balanced !== body) {
      const parsedFixed = tryParseJson(balanced);
      if (parsedFixed !== undefined && parsedFixed !== null) {
        tlog('warn', 'JSON 括号不匹配，已自动修复后解析成功', {
          original: tp(body),
          fixed: tp(balanced),
        });
        parsed = parsedFixed;
      }
    }
  }

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

export function tryParseJson(text) {
  if (!text) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    /* fallthrough */
  }

  const cleaned = fixRawNewlinesInJson(text);
  if (cleaned !== text) {
    try {
      return JSON.parse(cleaned);
    } catch {
      /* fallthrough */
    }
  }

  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (stripped !== text) {
    try {
      return JSON.parse(stripped);
    } catch {
      /* fallthrough */
    }
    const stripped2 = fixRawNewlinesInJson(stripped);
    if (stripped2 !== stripped) {
      try {
        return JSON.parse(stripped2);
      } catch {
        /* fallthrough */
      }
    }
  }

  return undefined;
}

export function balanceBrackets(s) {
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
      while (stack.length > 0 && stack[stack.length - 1] !== c) {
        out += stack.pop();
        changed = true;
      }
      if (stack.length === 0) {
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

export function parseDsmlCalls(body) {
  if (body == null) return { calls: [], complete: false };

  const blocks = scanDsmlInvokeBlocks(body);
  if (!blocks) return { calls: [], complete: false };

  const calls = [];
  for (const block of blocks) {
    const invokeBody = body.slice(block.bodyStart, block.end);
    const params = scanDsmlParameters(invokeBody);
    if (params === null) return { calls: [], complete: false };

    const args = {};
    for (const p of params) {
      const value = invokeBody.slice(p.valueStart, p.end);
      args[p.name] = coerceDsmlValue(value, p.attrs);
    }
    calls.push({ name: block.name, arguments: args });
  }

  return { calls, complete: true };
}

export function coerceDsmlValue(value, attrs) {
  const explicit = readExplicitType(attrs);

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

function readExplicitType(attrs) {
  if (!attrs) return null;

  const typeMatch = /(?:^|\s)type\s*=\s*"([^"]+)"/.exec(attrs);
  if (typeMatch) {
    const t = typeMatch[1].toLowerCase();
    if (['string', 'number', 'boolean', 'null', 'object', 'array'].includes(t)) {
      return t;
    }
  }

  const boolMatch = /(?:^|\s)(string|number|boolean|null|object|array)\s*=\s*"true"/i.exec(
    attrs
  );
  if (boolMatch) return boolMatch[1].toLowerCase();

  return null;
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

/* ---------- 裸 invoke 锚点 ---------- */

export function makeBareInvokeAnchor() {
  return new RegExp(`<${DSML}\\s*invoke\\s+name\\s*=\\s*"([^"]+)"[^>]*>`);
}

/* 供 buffer.js 使用：定位严格结束位置时需要先扫描 invoke 块 */
export { RE_CALLS_START, findDsmlCallsEndStrict, PIPE };