/**
 * index.js - 服务入口
 *
 * 从 server.js 拆出：创建 app、读取配置、listen、打印启动信息。
 * 仅在直接执行时 listen，被 import 时只导出 createApp（便于验证 import 图）。
 */

import { createApp } from './app.js';
import { getConfig, CONFIG_PATH } from './config.js';
import { makeLog, logInfo } from './logger.js';

const log = makeLog('proxy');

/**
 * 启动 HTTP 服务。
 * @returns {import('node:http').Server}
 */
export function startServer() {
  const app = createApp();
  const cfg = getConfig();

  const server = app.listen(cfg.port, cfg.host, () => {
    log.info(`代理服务:   http://${cfg.host}:${cfg.port}`);
    log.info(`配置页面:   http://${cfg.host}:${cfg.port}/admin`);
    log.info(`测试页面:   http://${cfg.host}:${cfg.port}/test`);
    log.info(`OpenAI:    http://${cfg.host}:${cfg.port}/v1/chat/completions`);
    log.info(`Anthropic: http://${cfg.host}:${cfg.port}/v1/messages`);
    log.info(`配置文件:   ${CONFIG_PATH}`);
    log.info(`日志文件:   ${logInfo.logFile}`);
    log.info(`PoW 自动求解: ${cfg.powEnabled !== false ? '已开启' : '已关闭'}`);
  });

  return server;
}

// 直接执行本文件时启动服务；被 import 时只导出函数
const isMain =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isMain) {
  startServer();
}
