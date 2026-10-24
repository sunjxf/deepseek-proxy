/**
 * admin.js - 配置管理与连通性测试
 *
 * GET/PUT /admin/api/config, POST /admin/api/test
 * 原样取自 server.js 的同名路由。
 */

import crypto from 'node:crypto';
import {
  getConfig,
  updateConfig,
  publicConfig,
  CONFIG_PATH,
} from '../config.js';
import { forwardToDeepSeek } from '../upstream/client.js';
import { getSessionId } from '../upstream/session.js';
import { stats } from '../stats.js';

export function registerAdminRoutes(app) {
  app.get('/admin/api/config', (req, res) => {
    res.json({
      config: publicConfig(),
      runtime: {
        ...stats,
        uptimeMs: Date.now() - stats.startedAt,
        pid: process.pid,
        node: process.version,
        configPath: CONFIG_PATH,
      },
    });
  });

  app.put('/admin/api/config', (req, res) => {
    try {
      const before = getConfig();
      const beforeAddr = `${before.host}:${before.port}`;

      updateConfig(req.body || {});

      const after = getConfig();
      const restartRequired = `${after.host}:${after.port}` !== beforeAddr;

      res.json({ ok: true, config: publicConfig(), restartRequired });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/admin/api/test', async (req, res) => {
    const cfg = getConfig();
    const started = Date.now();

    try {
      const upstream = await forwardToDeepSeek(cfg, req, 'ping', {
        sessionId: await getSessionId(cfg, req),
      });

      const text = await upstream.text();
      res.json({
        ok: upstream.ok,
        status: upstream.status,
        ms: Date.now() - started,
        preview: text.slice(0, 800),
      });
    } catch (e) {
      res.json({
        ok: false,
        status: 0,
        ms: Date.now() - started,
        error: e.name === 'AbortError' ? '请求超时' : e.message,
      });
    }
  });
}
