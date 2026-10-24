/**
 * native.js - DeepSeek 原生端点透传
 *
 * POST /api/v0/chat/completion
 * 原样取自 server.js 的同名路由。
 */

import { Readable } from 'node:stream';
import { getConfig } from '../config.js';
import { solveAndBuildHeader } from '../pow.js';
import {
  buildUpstreamHeaders,
  fetchWithRetry,
} from '../upstream/client.js';
import { getSessionId } from '../upstream/session.js';
import { throttle, waitForInterval } from '../upstream/throttle.js';
import { stats, recordError } from '../stats.js';
import { makeLog, newRequestId, dumpBody } from '../logger.js';

const log = makeLog('proxy');

export function registerNativeRoutes(app) {
  app.post('/api/v0/chat/completion', async (req, res) => {
    const cfg = getConfig();
    const rid = newRequestId();
    const lg = makeLog('native', rid);
    const started = Date.now();
    stats.totalRequests += 1;
    stats.lastRequestAt = Date.now();
    lg.debug('native', '收到请求', {
      ip: req.ip,
      stream: true,
      sessionId: req.body?.chat_session_id || cfg.chatSessionId || '(空)',
      body: dumpBody(req.body),
    });

    try {
      await throttle();
      await waitForInterval();

      const body = { ...req.body };
      if (!body.chat_session_id) {
        body.chat_session_id = await getSessionId(cfg, req, lg);
      }

      let powHeader = null;
      if (cfg.powEnabled !== false && !req.headers['x-ds-pow-response']) {
        const powStarted = Date.now();
        try {
          powHeader = await solveAndBuildHeader(cfg);
          lg.debug('pow', 'PoW 求解成功', { ms: Date.now() - powStarted });
        } catch (e) {
          lg.warn('pow', 'PoW 求解失败，将以无 PoW 头继续', {
            ms: Date.now() - powStarted,
            error: e.message,
          });
          recordError(`PoW 求解失败：${e.message}`);
        }
      }

      const upstream = await fetchWithRetry(
        cfg.upstreamUrl,
        {
          method: 'POST',
          headers: buildUpstreamHeaders(cfg, req, powHeader),
          body: JSON.stringify(body),
        },
        cfg,
        (status, attempt, delay) => {
          lg.warn('native', '上游可重试状态，等待后重试', {
            status,
            attempt,
            delayMs: Math.round(delay),
          });
        },
        lg
      );

      if (!upstream) throw new Error('上游无响应');

      res.status(upstream.status);

      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('content-type', contentType);

      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');

      if (!upstream.body) {
        const text = await upstream.text();
        if (upstream.ok) stats.successRequests += 1;
        else {
          stats.failedRequests += 1;
          recordError(`上游 HTTP ${upstream.status}`);
        }
        res.end(text);
        return;
      }

      if (upstream.ok) stats.successRequests += 1;
      else {
        stats.failedRequests += 1;
        recordError(`上游 HTTP ${upstream.status}`);
      }

      Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) {
      stats.failedRequests += 1;
      const msg = e.name === 'AbortError' ? '请求超时' : e.message;
      recordError(msg);
      if (!res.headersSent) res.status(502).json({ error: msg });
      else res.end();
    }
  });
}
