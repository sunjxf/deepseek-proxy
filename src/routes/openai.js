/**
 * openai.js - OpenAI 兼容端点
 *
 * POST /v1/chat/completions
 * 原样取自 server.js 中的同名路由。
 */

import { getConfig } from '../config.js';
import { stats, recordError } from '../stats.js';
import { makeLog, newRequestId, preview, dumpBody } from '../logger.js';
import { throttle, waitForInterval } from '../upstream/throttle.js';
import { forwardToDeepSeek } from '../upstream/client.js';
import { getSessionId } from '../upstream/session.js';
import { streamAsOpenAI } from '../adapters/openai.js';
import { collectDeepSeek } from '../upstream/sse.js';
import { makeUsage } from '../adapters/usage.js';
import {
  buildPromptFromMessages,
  extractSystemText,
  formatToolsInstruction,
  extractImagesFromMessages,
} from '../tools/index.js';
import { uploadImages } from '../upstream/upload.js';

export function registerOpenAIRoutes(app) {
  app.post('/v1/chat/completions', async (req, res) => {
    const cfg = getConfig();
    const rid = newRequestId();
    const lg = makeLog('openai', rid);
    const started = Date.now();
    stats.totalRequests += 1;
    stats.lastRequestAt = Date.now();
    lg.debug('收到请求', {
      model: req.body?.model,
      stream: !!req.body?.stream,
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
        lg.debug('openai', '从最后一条 user 消息提取图片', {
          images: images.length,
          bytes: images.reduce((n, img) => n + (img.buffer?.length || 0), 0),
        });
      }

      const prompt = buildPromptFromMessages(
        messages,
        extractSystemText(req.body.system),
        formatToolsInstruction(req.body.tools)
      );

      if (!prompt) {
        lg.warn('请求缺少用户消息', { body: preview(dumpBody(req.body), 300) });
        res.status(400).json({
          error: {
            message: 'no user message found',
            type: 'invalid_request_error',
          },
        });
        return;
      }

      const stream = !!req.body.stream;
      const sessionId = await getSessionId(cfg, req, lg);

      // 上传图片；单张失败已在 uploadImages 内记录并跳过，不影响请求
      const refFileIds = await uploadImages(cfg, req, images, lg);
      if (images.length > 0 && refFileIds.length < images.length) {
        lg.warn('openai', '部分图片上传失败，将继续以文本 prompt 请求', {
          images: images.length,
          uploaded: refFileIds.length,
        });
      }

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
          error: {
            message: text.slice(0, 800) || `upstream ${upstream.status}`,
            type: 'upstream_error',
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
        await streamAsOpenAI(upstream, res, req.body.model, lg, prompt);
      } else {
        const { text, toolCalls, rawAll } = await collectDeepSeek(upstream, lg);
        const toolCallsOut =
          toolCalls.length > 0
            ? toolCalls.map((c, i) => ({
                index: i,
                id: 'call_' + Math.random().toString(36).slice(2, 10),
                type: 'function',
                function: {
                  name: c.name,
                  arguments: JSON.stringify(c.arguments),
                },
              }))
            : undefined;

        lg.info('openai-collect', formatExchange(rawAll, toolCallsOut, text));

        res.json({
          id: 'chatcmpl-' + Date.now().toString(36),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: req.body.model || 'deepseek-chat',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: text || (toolCallsOut ? null : ''),
                tool_calls: toolCallsOut,
              },
              finish_reason: toolCallsOut ? 'tool_calls' : 'stop',
            },
          ],
          usage: makeUsage(prompt, text),
        });
      }
    } catch (e) {
      stats.failedRequests += 1;
      const msg = e.name === 'AbortError' ? '请求超时' : e.message;
      recordError(msg);
      lg.error('请求处理失败', { error: msg, ms: Date.now() - started });
      if (!res.headersSent) {
        res.status(502).json({ error: { message: msg, type: 'proxy_error' } });
      } else {
        res.end();
      }
    }
  });
}