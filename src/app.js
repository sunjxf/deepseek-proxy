/**
 * app.js - Express 应用装配
 *
 * 从 server.js 拆出：中间件、模块日志注入、路由注册、静态资源。
 * 不负责 listen，由 index.js 调用 createApp() 后再监听。
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, setConfigLogger } from './config.js';
import { setPowLogger } from './pow.js';
import { setThrottleLogger } from './upstream/throttle.js';
import { setToolLogger } from './tools/index.js';
import { makeLog } from './logger.js';

import { registerOpenAIRoutes } from './routes/openai.js';
import { registerAnthropicRoutes } from './routes/anthropic.js';
import { registerNativeRoutes } from './routes/native.js';
import { registerAdminRoutes } from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const log = makeLog('proxy');

/**
 * 把统一日志注入到各模块，保证输出格式、级别、时间戳一致。
 * 原 server.js 在模块顶层做这件事，这里放进 createApp()，
 * 保证先装配 logger 再注入。
 */
function injectModuleLoggers() {
  const moduleLog = (scope) => (level, msg, extra) => {
    const fn = log[level] || log.info;
    fn(`[${scope}] ${msg}`, extra ?? '');
  };
  setConfigLogger(moduleLog('config'));
  setPowLogger(moduleLog('pow'));
  setThrottleLogger(moduleLog('throttle'));
  setToolLogger(moduleLog('tool_call'));
}

export function createApp() {
  injectModuleLoggers();
  loadConfig();

  const app = express();
  app.use(express.json({ limit: '50mb' }));

  registerNativeRoutes(app);
  registerOpenAIRoutes(app);
  registerAnthropicRoutes(app);
  registerAdminRoutes(app);

  app.get('/test', (req, res) => res.redirect('/admin/test/'));
  app.use('/admin', express.static(path.join(ROOT, 'public')));
  app.get('/admin', (req, res) => res.redirect('/admin/config/'));
  app.get('/', (req, res) => res.redirect('/admin/'));

  return app;
}
