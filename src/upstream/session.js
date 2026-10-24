/**
 * session.js - 自动创建 chat_session
 *
 * POST https://chat.deepseek.com/api/v0/chat_session/create  body: {}
 * 响应 data.biz_data.chat_session.id 即会话 ID。
 *
 * 策略：进程内维护一个会话，被使用 sessionMaxUses 次后重建。
 * 创建失败非致命，退回 config.json 中的 chatSessionId。
 */

import { solveAndBuildHeader } from '../pow.js';
import { buildUpstreamHeaders } from './client.js';
import { makeLog } from '../logger.js';

const log = makeLog('session');

const SESSION_CREATE_URL =
  'https://chat.deepseek.com/api/v0/chat_session/create';

let current = { id: '', uses: 0 };
let creating = null; // 并发创建去重

async function createChatSession(cfg, req, lg) {
  const started = Date.now();
  let powHeader = null;
  try {
    if (cfg.powEnabled !== false) {
      powHeader = await solveAndBuildHeader(cfg);
    }
  } catch (e) {
    lg.warn('session', 'PoW 求解失败，尝试无 PoW 创建会话', {
      error: e.message,
    });
  }

  const res = await fetch(SESSION_CREATE_URL, {
    method: 'POST',
    headers: buildUpstreamHeaders(cfg, req, powHeader),
    body: '{}',
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`create HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`create 响应非 JSON：${text.slice(0, 200)}`);
  }

  if (data.code !== 0) {
    throw new Error(`create 业务错误 code=${data.code} msg=${data.msg}`);
  }

  const id = data?.data?.biz_data?.chat_session?.id;
  if (!id) {
    throw new Error(`create 响应缺少 session id：${text.slice(0, 300)}`);
  }

  lg.info('session', '已创建新会话', { id, ms: Date.now() - started });
  return id;
}

/**
 * 获取一个可用会话 ID。达到使用上限或尚未创建时自动创建。
 * 创建失败时退回 config.json 的 chatSessionId（非致命）。
 */
export async function getSessionId(cfg, req, lg = log) {
  const maxUses = Math.max(1, Number(cfg.sessionMaxUses) || 30);

  if (current.id && current.uses < maxUses) {
    current.uses += 1;
    lg.debug('session', '复用会话', {
      id: current.id,
      uses: current.uses,
      maxUses,
    });
    return current.id;
  }

  if (current.id) {
    lg.info('session', '会话已达使用上限，准备重建', {
      id: current.id,
      uses: current.uses,
      maxUses,
    });
  }

  if (creating) {
    lg.debug('session', '等待并发中的会话创建', { id: current.id || '(无)' });
  } else {
    creating = createChatSession(cfg, req, lg)
      .then((id) => {
        current = { id, uses: 1 };
        return id;
      })
      .catch((e) => {
        const fallback = cfg.chatSessionId;
        lg.warn('session', '创建会话失败，退回配置中的 chatSessionId', {
          error: e.message,
          fallback: fallback || '(空)',
        });
        if (!fallback) {
          throw new Error(
            `创建会话失败且未配置 chatSessionId：${e.message}`
          );
        }
        current = { id: fallback, uses: 1 };
        return fallback;
      })
      .finally(() => {
        creating = null;
      });
  }

  return creating;
}

/** 仅用于调试/日志 */
export function sessionSnapshot() {
  return { ...current };
}
