/**
 * stats.js - 运行时统计
 *
 * 从 server.js 原样搬出，行为不变。
 */

export const stats = {
  startedAt: Date.now(),
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  retriedRequests: 0,
  throttledRequests: 0,
  lastRequestAt: null,
  lastError: null,
  lastErrorAt: null,
};

export function recordError(message) {
  stats.lastError = String(message).slice(0, 300);
  stats.lastErrorAt = Date.now();
}
