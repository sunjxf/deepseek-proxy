/**
 * anthropic.js - Anthropic 兼容流式适配
 *
 * 原样取自 server.js 的 streamAsAnthropic()。
 * 把上游 DeepSeek SSE 转成 Anthropic message 事件流（含 tool_use 状态机）。
 */

import { ToolCallBuffer } from '../tools/buffer.js';
import { iterateDeepSeekEvents, extractDeepSeekText } from '../upstream/sse.js';
import { estimateTokens, makeUsage } from './usage.js';
import { newToolUseId, newMessageId } from '../tools/ids.js';
import { formatExchange } from '../logger.js';

export async function streamAsAnthropic(upstream, res, model, lg, promptText = '') {
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
      usage: {
        input_tokens: estimateTokens(promptText),
        output_tokens: 0,
      },
    },
  });

  // 状态机
  const toolBuf = new ToolCallBuffer();
  const toolUsesOut = [];
  let rawAll = '';
  let cleanAll = '';
  let toolCallCount = 0;
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

    toolUsesOut.push({
      type: 'tool_use',
      id: toolId,
      name: call.name,
      input: call.arguments ?? {},
    });

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

      rawAll += text;
      cleanAll += clean;

      if (clean) emitTextDelta(clean);
      for (const call of toolCalls) {
        toolCallCount++;
        emitToolUse(call);
      }
    }

    const tail = toolBuf.flush();
    cleanAll += tail.text;
    toolCallCount += tail.toolCalls.length;
    if (tail.text) emitTextDelta(tail.text);
    for (const call of tail.toolCalls) emitToolUse(call);

    lg.info(
      'anthropic-stream',
      formatExchange(rawAll, toolUsesOut, cleanAll)
    );

    closeCurrentBlock();

    writeEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: hasToolCall ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: makeUsage(promptText, cleanAll).completion_tokens },
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
