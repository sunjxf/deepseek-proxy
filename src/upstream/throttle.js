/**
 * throttle.js - 两层限速
 *
 * 原样取自 server.js 的 throttle() / waitForInterval()。
 * 统计与日志通过注入获得，避免依赖 server.js。
 */

import { getConfig } from '../config.js';
import { stats } from '../stats.js';

let log = { warn() {}, debug() {} };

export function setThrottleLogger(fn) {
  if (fn && typeof fn === 'object') log = fn;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let windowStart = Date.now();
let windowCount = 0;

export async function throttle() {
  const cfg = getConfig();
  const limit = Number(cfg.maxRequestsPerMinute) || 0;
  if (limit <= 0) return;

  const now = Date.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    windowCount = 0;
  }

  if (windowCount >= limit) {
    const wait = 60_000 - (now - windowStart);
    stats.throttledRequests += 1;
    log.warn('throttle', '本机限流触发，等待后继续', {
      limit,
      count: windowCount,
      waitMs: wait,
    });
    await sleep(wait);
    windowStart = Date.now();
    windowCount = 0;
  }
  windowCount += 1;
}

let lastRequestAt = 0;
let intervalChain = Promise.resolve();

// 相邻两次请求至少间隔 requestIntervalMs 毫秒，不足则等待。
// 通过 promise 链把并发请求排队，保证间隔是"发出请求"之间的间隔。
export function waitForInterval() {
  const cfg = getConfig();
  const interval = Number(cfg.requestIntervalMs) || 0;
  if (interval <= 0) return Promise.resolve();

  const run = intervalChain.then(async () => {
    const now = Date.now();
    const elapsed = now - lastRequestAt;
    if (lastRequestAt && elapsed < interval) {
      const wait = interval - elapsed;
      stats.throttledRequests += 1;
      log.debug('interval', '请求间隔不足，排队等待', {
        intervalMs: interval,
        elapsedMs: elapsed,
        waitMs: wait,
      });
      await sleep(wait);
    }
    lastRequestAt = Date.now();
  });

  // 无论成功失败都让链继续，避免一个异常卡死后续请求
  intervalChain = run.catch(() => {});
  return run;
}
