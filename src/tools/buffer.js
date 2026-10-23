/**
 * buffer.js - 流式工具标签缓冲
 *
 * 从 tools.js 拆出。ToolCallBuffer 在流式文本中定位工具标记，
 * 跨 chunk 缓冲不完整的标签，产出结构化调用或清洗后的正文。
 */

import {
  TOOL_CALL_START,
  TOOL_CALL_END,
  findDsmlCallsStart,
  findDsmlCallsEndStrict,
  isPartialDsmlCallsStart,
  scanOutsideString,
  isOutsideString,
  fixRawNewlinesInJson,
  stripToolCallResidue,
  stripToolResultResidue,
} from './residue.js';
import {
  parseToolCallsJson,
  parseDsmlCalls,
  balanceBrackets,
  tryParseJson,
  scanDsmlInvokeBlocks,
  makeBareInvokeAnchor,
} from './parse.js';
import { tlog, tp, formatCalls } from './log.js';

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
        const from = pos + len;
        const strict = this._findToolCallEndStrict(from);

        if (!strict) {
          this.buffer = this.buffer.slice(pos);
          return this._finish(out);
        }

        const endIdx = strict.endIdx;
        const consumedEnd = endIdx + TOOL_CALL_END.length;
        const body = this.buffer.slice(from, endIdx).trim();

        const calls = parseToolCallsJson(body);
        if (calls) {
          tlog(
            'debug',
            `解析 tool_call 成功 (${calls.length}): ${calls.map((c) => c.name).join(',')}` +
              formatCalls(calls)
          );
          out.toolCalls.push(...calls);
        } else {
          tlog('warn', 'tool_call 解析失败，回退为正文', { body: tp(body, 200) });
          out.text += stripToolCallResidue(this.buffer.slice(pos, consumedEnd));
        }

        this.buffer = this.buffer.slice(consumedEnd);
      } else if (type === 'dsml_calls') {
        const endMatch = findDsmlCallsEndStrict(this.buffer, pos + len);
        if (!endMatch) {
          this.buffer = this.buffer.slice(pos);
          return this._finish(out);
        }
        const endIdx = endMatch.index;
        const endLen = endMatch.length;
        const body = this.buffer.slice(pos + len, endIdx);
        const result = parseDsmlCalls(body);
        if (result.complete && result.calls.length > 0) {
          tlog(
            'debug',
            `解析 DSML calls 成功 (${result.calls.length}): ${result.calls
              .map((c) => c.name)
              .join(',')}` + formatCalls(result.calls)
          );
          out.toolCalls.push(...result.calls);
        } else {
          tlog('warn', 'DSML calls 解析失败，回退为正文', { body: tp(body, 200) });
          out.text += stripToolCallResidue(this.buffer.slice(pos, endIdx + endLen));
        }
        this.buffer = this.buffer.slice(endIdx + endLen);
      } else if (type === 'dsml_invoke') {
        const consumed = this._consumeBareInvokes(pos);
        if (consumed === -1) {
          this.buffer = this.buffer.slice(pos);
          return this._finish(out);
        }
        const body = this.buffer.slice(pos, consumed);
        const result = parseDsmlCalls(body);
        if (result.complete && result.calls.length > 0) {
          tlog(
            'debug',
            `解析裸 DSML invoke 成功 (${result.calls.length}): ${result.calls
              .map((c) => c.name)
              .join(',')}` + formatCalls(result.calls)
          );
          out.toolCalls.push(...result.calls);
        } else {
          tlog('warn', '裸 DSML invoke 解析失败，回退为正文', { body: tp(body, 200) });
          out.text += stripToolCallResidue(body);
        }
        this.buffer = this.buffer.slice(consumed);
      }
    }
  }

  _findToolCallEndStrict(from) {
    const positions = scanOutsideString(this.buffer, TOOL_CALL_END, from);
    for (let i = positions.length - 1; i >= 0; i--) {
      const idx = positions[i];
      const body = this.buffer.slice(from, idx).trim();
      if (tryParseJson(body) !== undefined) {
        return { endIdx: idx };
      }
    }
    return null;
  }

  _consumeBareInvokes(start) {
    const anchorRe = makeBareInvokeAnchor();
    const m = anchorRe.exec(this.buffer.slice(start));
    if (!m || m.index !== 0) return -1;

    const rest = this.buffer.slice(start);
    const blocks = scanDsmlInvokeBlocks(rest);
    if (!blocks || blocks.length === 0) return -1;

    return start + blocks[blocks.length - 1].end;
  }

  flush() {
    const out = { text: '', toolCalls: [] };
    if (!this.buffer) return out;

    const callsStart = findDsmlCallsStart(this.buffer);
    if (callsStart) {
      const r = this._tryFlushDsmlCalls(callsStart);
      if (r) return this._finish(r);
    }

    const bareAnchor = makeBareInvokeAnchor();
    if (bareAnchor.test(this.buffer)) {
      const r = this._tryFlushBareInvokes();
      if (r) return this._finish(r);
    }

    const tcPositions = scanOutsideString(this.buffer, TOOL_CALL_START);
    if (tcPositions.length > 0) {
      const r = this._tryFlushToolCall(tcPositions[0]);
      if (r) return this._finish(r);
    }

    if (this.buffer.indexOf('DSML') !== -1 || /tool_call/i.test(this.buffer)) {
      tlog('warn', 'flush 时缓冲残留未闭合的工具标签', {
        buffer: tp(this.buffer, 200),
      });
    }

    out.text = this.buffer;
    this.buffer = '';
    return this._finish(out);
  }

  _tryFlushDsmlCalls(callsStart) {
    const contentStart = callsStart.index + callsStart.length;
    const endMatch = findDsmlCallsEndStrict(this.buffer, contentStart);
    if (!endMatch) return null;

    const body = this.buffer.slice(contentStart, endMatch.index);
    const result = parseDsmlCalls(body);
    if (!result.complete) return null;

    if (result.calls.length > 0) {
      tlog(
        'debug',
        `flush 解析 DSML calls 成功 (${result.calls.length}): ${result.calls
          .map((c) => c.name)
          .join(',')}` + formatCalls(result.calls)
      );
    }

    const out = { text: '', toolCalls: result.calls };
    out.text += this.buffer.slice(0, callsStart.index);
    out.text += this.buffer.slice(endMatch.index + endMatch.length);
    this.buffer = '';
    return out;
  }

  _tryFlushBareInvokes() {
    const firstRe = makeBareInvokeAnchor();
    const m = firstRe.exec(this.buffer);
    if (!m) return null;
    const startPos = m.index;

    const rest = this.buffer.slice(startPos);
    const blocks = scanDsmlInvokeBlocks(rest);
    if (!blocks || blocks.length === 0) return null;

    const endPos = startPos + blocks[blocks.length - 1].end;
    const body = this.buffer.slice(startPos, endPos);
    const result = parseDsmlCalls(body);
    if (!result.complete) return null;

    if (result.calls.length > 0) {
      tlog(
        'debug',
        `flush 解析裸 DSML invoke 成功 (${result.calls.length}): ${result.calls
          .map((c) => c.name)
          .join(',')}` + formatCalls(result.calls)
      );
    }

    const out = { text: '', toolCalls: result.calls };
    out.text += this.buffer.slice(0, startPos);
    out.text += this.buffer.slice(endPos);
    this.buffer = '';
    return out;
  }

  _tryFlushToolCall(tcStart) {
    const from = tcStart + TOOL_CALL_START.length;

    const strict = this._findToolCallEndStrict(from);
    if (strict) {
      const endIdx = strict.endIdx;
      const endLen = TOOL_CALL_END.length;
      const body = this.buffer.slice(from, endIdx).trim();
      const calls = parseToolCallsJson(body);
      if (calls) {
        tlog(
          'debug',
          `flush 解析 <tool_call> 成功 (${calls.length}): ${calls
            .map((c) => c.name)
            .join(',')}` + formatCalls(calls)
        );
        const out = { text: '', toolCalls: calls };
        out.text += this.buffer.slice(0, tcStart);
        if (endIdx + endLen < this.buffer.length) {
          out.text += this.buffer.slice(endIdx + endLen);
        }
        this.buffer = '';
        return out;
      }
    }

    const positions = scanOutsideString(this.buffer, TOOL_CALL_END, from);
    for (let i = positions.length - 1; i >= 0; i--) {
      const idx = positions[i];
      const body = this.buffer.slice(from, idx).trim();
      const fixed = fixRawNewlinesInJson(body);
      const balanced = balanceBrackets(fixed);
      let parsed;
      try {
        parsed = JSON.parse(balanced);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && parsed !== null) {
        const calls = this._buildCallsFromParsed(parsed);
        if (calls) {
          tlog(
            'debug',
            `flush 修复括号后解析 <tool_call> 成功 (${calls.length}): ${calls
              .map((c) => c.name)
              .join(',')}` + formatCalls(calls)
          );
          const out = { text: '', toolCalls: calls };
          out.text += this.buffer.slice(0, tcStart);
          if (idx + TOOL_CALL_END.length < this.buffer.length) {
            out.text += this.buffer.slice(idx + TOOL_CALL_END.length);
          }
          this.buffer = '';
          return out;
        }
      }
    }

    tlog('warn', 'flush 中 <tool_call> 解析失败，回退为正文', {
      body: tp(this.buffer.slice(from), 200),
    });
    return null;
  }

  _buildCallsFromParsed(parsed) {
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const calls = [];
    for (const c of arr) {
      if (!c || typeof c !== 'object') continue;
      const name = c.name || c.function?.name;
      let args = c.arguments ?? c.input ?? c.function?.arguments ?? {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { /* 保留字符串 */ }
      }
      if (name) calls.push({ name, arguments: args });
    }
    return calls.length > 0 ? calls : null;
  }

  _finish(out) {
    if (out.text) {
      out.text = stripToolCallResidue(out.text);
      // 兜底：即使 stripToolCallResidue 内部路径遗漏，这里再跑一次
      // tool_result 清理。幂等，成本低。
      out.text = stripToolResultResidue(out.text);
    }
    return out;
  }

  _findNextStart() {
    const tcPositions = scanOutsideString(this.buffer, TOOL_CALL_START);
    const tcPos = tcPositions.length > 0 ? tcPositions[0] : -1;

    const callsMatch = findDsmlCallsStart(this.buffer);
    const callsPos = callsMatch ? callsMatch.index : -1;
    const callsLen = callsMatch ? callsMatch.length : 0;

    const bareRe = makeBareInvokeAnchor();
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

  _findPartialStart() {
    const maxLen = Math.min(this.buffer.length, TOOL_CALL_START.length - 1);
    for (let len = maxLen; len >= 1; len--) {
      const suffix = this.buffer.slice(-len);
      if (TOOL_CALL_START.startsWith(suffix)) {
        const ltPos = this.buffer.length - len;
        if (isOutsideString(this.buffer, ltPos)) {
          return ltPos;
        }
      }
    }

    const lastLt = this.buffer.lastIndexOf('<');
    if (lastLt !== -1) {
      const suffix = this.buffer.slice(lastLt);
      if (
        isPartialDsmlCallsStart(suffix) &&
        isOutsideString(this.buffer, lastLt)
      ) {
        return lastLt;
      }
    }

    return -1;
  }
}