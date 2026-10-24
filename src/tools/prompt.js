/**
 * prompt.js - Prompt 构造
 *
 * 原样取自 tools.js：把 OpenAI / Anthropic 的 messages 结构压平成
 * DeepSeek 单条 prompt，并生成工具清单说明。
 *
 * 关键约束：工具标记绝不能泄漏进 prompt 历史。
 * formatUserContent() 在消息内容回到 prompt 前做清洗，否则模型会
 * 看到自己写坏的标记并模仿。
 */

import { sanitizeText, TOOL_CALL_START, TOOL_CALL_END } from './residue.js';
import { logTransform } from './log.js';

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
    `6. 每个工具调用都必须成对输出 ${TOOL_CALL_START} 和 ${TOOL_CALL_END}；多个调用请逐个闭合，不要省略`,
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

/* ---------- 图片提取 ---------- */

/**
 * 从最后一条 user 消息里提取 base64 图片。
 *
 * 支持两种格式：
 *   OpenAI:    { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
 *   Anthropic: { type: 'image', source: { type: 'base64', media_type, data } }
 *
 * 只处理最后一条 user 消息（历史图片不重复上传，避免每次请求都重传历史图）。
 * 返回的 images 供调用方上传，messages 中图片块已被剔除，不会进入 prompt 文本。
 *
 * @param {Array} messages 原始消息数组
 * @returns {{ images: Array<{mime: string, buffer: Buffer, name: string}>, messages: Array }}
 */
export function extractImagesFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { images: [], messages };
  }

  // 从后往前找最后一条 user 消息
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return { images: [], messages };

  const target = messages[lastUserIdx];
  if (!Array.isArray(target.content)) return { images: [], messages };

  const images = [];
  const keptBlocks = [];

  for (const block of target.content) {
    const img = imageFromBlock(block);
    if (img) {
      images.push(img);
      // 同步插入文本占位：上传失败时模型仍知道这里有一张图，
      // 上传成功时占位文本与图片并存，语义可接受。
      keptBlocks.push({ type: 'text', text: '[图片]' });
      continue;
    }
    keptBlocks.push(block);
  }

  if (images.length === 0) return { images: [], messages };

  const nextMessages = messages.slice();
  nextMessages[lastUserIdx] = { ...target, content: keptBlocks };

  logTransform(
    'extractImagesFromMessages',
    `user 消息含 ${images.length} 张图片`,
    nextMessages[lastUserIdx].content
  );

  return { images, messages: nextMessages };
}

function imageFromBlock(block) {
  if (!block || typeof block !== 'object') return null;

  // OpenAI 风格：image_url 支持字符串或 { url }
  if (block.type === 'image_url') {
    const url =
      typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
    const parsed = parseDataUrl(url);
    if (parsed) return parsed;
    return null;
  }

  // Anthropic 风格
  if (block.type === 'image' && block.source?.type === 'base64') {
    const mime = block.source.media_type || 'image/png';
    try {
      const buffer = Buffer.from(block.source.data || '', 'base64');
      if (buffer.length === 0) return null;
      return { mime, buffer, name: `image.${extFromMime(mime)}` };
    } catch {
      return null;
    }
  }

  return null;
}

/** 拆解 data URL，非 data URL 返回 null */
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || 'image/png';
  const buffer = m[2]
    ? Buffer.from(m[3] || '', 'base64')
    : Buffer.from(decodeURIComponent(m[3] || ''), 'utf8');
  if (buffer.length === 0) return null;
  return { mime, buffer, name: `image.${extFromMime(mime)}` };
}

function extFromMime(mime) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
  };
  return map[mime] || 'bin';
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
    } else if (block.type === 'image' || block.type === 'image_url') {
      // 图片块已由 extractImagesFromMessages 单独提取上传，
      // 这里不把 base64 数据或对象字符串写进 prompt。
      parts.push('[图片]');
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
