/**
 * anthropic.js - Anthropic 兼容端点
 *
 * POST /v1/messages
 * 原样取自 server.js 的同名路由。
 */

import { getConfig } from '../config.js';
import { forwardToDeepSeek } from '../upstream/client.js';
import { getSessionId } from '../upstream/session.js';
import { throttle, waitForInterval } from '../upstream/throttle.js';
import { collectDeepSeek } from '../upstream/sse.js';
import { streamAsAnthropic } from '../adapters/anthropic.js';
import { makeUsage } from '../adapters/usage.js';
import { stats, recordError } from '../stats.js';
import { makeLog, newRequestId, dumpBody, preview } from '../logger.js';
import { formatExchange } from '../logger.js';
import {
  buildPromptFromMessages,
  extractSystemText,
  formatToolsInstruction,
  extractImagesFromMessages,
  newMessageId,
  newToolUseId,
} from '../tools/index.js';
import { uploadImages } from '../upstream/upload.js';

const log = makeLog('proxy');

export function registerAnthropicRoutes(app) {
  app.post('/v1/messages', async (req, res) => {
    const cfg = getConfig();
    const rid = newRequestId();
    const lg = makeLog('anthropic', rid);
    stats.totalRequests += 1;
    stats.lastRequestAt = Date.now();
    lg.debug('收到请求', {
      model: req.body?.model,
      stream: req.body?.stream !== false,
      messages: req.body?.messages?.length ?? 0,
      tools: req.body?.tools?.length ?? 0,
      body: dumpBody(req.body),
    });

    try {
      await throttle();
      await waitForInterval();

      // 先提取最后一条 user 消息里的 base64 图片，再构造 prompt
      const { images, messages } = extractImagesFromMessages(req.body.messages);
      if (images.length > 0) {
        lg.debug('anthropic', '已提取待上传图片', {
          count: images.length,
          totalBytes: images.reduce((n, i) => n + (i.buffer?.length || 0), 0),
        });
      }

      const prompt = buildPromptFromMessages(
        messages,
        extractSystemText(req.body.system),
        formatToolsInstruction(req.body.tools)
      );

      if (!prompt) {
        res.status(400).json({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'no user message found',
          },
        });
        return;
      }

      const stream = req.body.stream !== false;

      // 上传图片（若最后一条 user 消息含 base64 图片），拿到 file_id 供上游引用
      const refFileIds = await uploadImages(cfg, req, images, lg);
      if (images.length > 0) {
        lg.info('anthropic', '图片处理完成', {
          requested: images.length,
          uploaded: refFileIds.length,
        });
      }

      const sessionId = await getSessionId(cfg, req, lg);

      const upstream = await forwardToDeepSeek(
        cfg,
        req,
        prompt,
        {
          sessionId,
          thinking: !!req.body.thinking,
          search: !!req.body.search,
          refFileIds,
        },
        lg
      );

      if (!upstream) throw new Error('上游无响应');

      if (!upstream.ok) {
        const text = await upstream.text();
        stats.failedRequests += 1;
        recordError(`上游 HTTP ${upstream.status}`);
        lg.warn('上游返回错误', {
          status: upstream.status,
          body: preview(text, 300),
        });
        res.status(upstream.status).json({
          type: 'error',
          error: {
            type: 'api_error',
            message: text.slice(0, 800) || `upstream ${upstream.status}`,
          },
        });
        return;
      }

      stats.successRequests += 1;

      if (stream) {
        res.setHeader('content-type', 'text/event-stream; charset=utf-8');
        res.setHeader('cache-control', 'no-cache, no-transform');
        res.setHeader('connection', 'keep-alive');
        res.setHeader('x-accel-buffering', 'no');
        lg.info('开始流式输出', { model: req.body.model });
        await streamAsAnthropic(upstream, res, req.body.model, lg, prompt);
      } else {
        const { text, toolCalls, rawAll } = await collectDeepSeek(upstream, lg);

        const content = [];
        if (text) content.push({ type: 'text', text });

        const toolUsesOut = toolCalls.map((call) => ({
          type: 'tool_use',
          id: newToolUseId(),
          name: call.name,
          input: call.arguments ?? {},
        }));
        for (const tu of toolUsesOut) content.push(tu);

        lg.info('anthropic-collect', formatExchange(rawAll, toolUsesOut, text));

        res.json({
          id: newMessageId(),
          type: 'message',
          role: 'assistant',
          model: req.body.model || 'deepseek-chat',
          content,
          stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: makeUsage(prompt, '').prompt_tokens,
            output_tokens: makeUsage('', text).completion_tokens,
          },
        });
      }
    } catch (e) {
      stats.failedRequests += 1;
      const msg = e.name === 'AbortError' ? '请求超时' : e.message;
      recordError(msg);
      if (!res.headersSent) {
        res.status(502).json({
          type: 'error',
          error: { type: 'api_error', message: msg },
        });
      } else {
        res.end();
      }
    }
  });
}