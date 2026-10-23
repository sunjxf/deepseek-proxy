/**
 * openai.js - OpenAI 兼容流式适配
 *
 * 原样取自 server.js 的 streamAsOpenAI()。
 * 把上游 DeepSeek SSE 转成 OpenAI chat.completion.chunk 事件流。
 */

import { ToolCallBuffer } from '../tools/buffer.js';
import { iterateDeepSeekEvents, extractDeepSeekText } from '../upstream/sse.js';
import { makeUsage } from './usage.js';
import { formatExchange } from '../logger.js';

export async function streamAsOpenAI(upstream, res, model, lg, promptText = '') {
  const id = 'chatcmpl-' + Date.now().toString(36);
  const created = Math.floor(Date.now() / 1000);
  const actualModel = model || 'deepseek-chat';

  const writeChunk = (delta, finishReason) => {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: actualModel,
      choices: [
        { index: 0, delta, finish_reason: finishReason ?? null },
      ],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  writeChunk({ role: 'assistant', content: '' }, null);

  const toolBuf = new ToolCallBuffer();
  const toolCallsOut = [];
  let toolCallIndex = 0;
  let rawAll = '';
  let cleanAll = '';

  try {
    for await (const obj of iterateDeepSeekEvents(upstream)) {
      const text = extractDeepSeekText(obj);
      if (!text) continue;

      const { text: clean, toolCalls } = toolBuf.feed(text);

      rawAll += text;
      cleanAll += clean;

      if (clean) writeChunk({ content: clean }, null);

      for (const call of toolCalls) {
        toolCallsOut.push(call);
        writeChunk(
          {
            tool_calls: [
              {
                index: toolCallIndex++,
                id: 'call_' + Math.random().toString(36).slice(2, 10),
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              },
            ],
          },
          null
        );
      }
    }

    const tail = toolBuf.flush();
    if (tail.text) {
      cleanAll += tail.text;
      writeChunk({ content: tail.text }, null);
    }
    for (const call of tail.toolCalls) {
      toolCallsOut.push(call);
      writeChunk(
        {
          tool_calls: [
            {
              index: toolCallIndex++,
              id: 'call_' + Math.random().toString(36).slice(2, 10),
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            },
          ],
        },
        null
      );
    }

    lg.info('openai-stream', formatExchange(rawAll, toolCallsOut, cleanAll));

    const usage = makeUsage(promptText, cleanAll);
    lg.info('openai-stream', '流式输出完成', {
      toolCalls: toolCallsOut.length,
      usage,
    });
    writeChunk({}, toolCallsOut.length > 0 ? 'tool_calls' : 'stop');
    // 无条件追加 usage chunk（OpenAI 规范中该 chunk 的 choices 为空数组）
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: actualModel,
        choices: [],
        usage,
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    lg.error('openai-stream', '流式输出中断', { error: e.message });
    writeChunk({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
