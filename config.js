import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CONFIG_PATH =
  process.env.CONFIG_PATH || path.join(__dirname, 'config.json');

export const SENSITIVE_FIELDS = ['authorization'];

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3000,
  upstreamUrl: 'https://chat.deepseek.com/api/v0/chat/completion',
  requestTimeoutMs: 120000,
  maxRetries: 4,
  retryBaseDelayMs: 1000,
  maxRequestsPerMinute: 30,
  requestIntervalMs: 0,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',

  // PoW 配置
  powEnabled: true,
  powChallengeUrl: 'https://chat.deepseek.com/api/v0/chat/create_pow_challenge',
  powTargetPath: '/api/v0/chat/completion',

  // 默认会话
  chatSessionId: '',

  // 上游凭证
  authorization: '',
};

let current = { ...DEFAULTS };

function applyEnvOverrides() {
  const map = {
    HOST: 'host',
    PORT: 'port',
    DEEPSEEK_UPSTREAM_URL: 'upstreamUrl',
    DEEPSEEK_AUTHORIZATION: 'authorization',
    DEEPSEEK_CHAT_SESSION_ID: 'chatSessionId',
    MAX_REQUESTS_PER_MINUTE: 'maxRequestsPerMinute',
    REQUEST_INTERVAL_MS: 'requestIntervalMs',
    POW_ENABLED: 'powEnabled',
  };
  for (const [env, key] of Object.entries(map)) {
    if (process.env[env]) current[key] = process.env[env];
  }
}

export function loadConfig() {
  let fromFile = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.error('[config] 解析失败：', e.message);
    }
  }
  current = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (key in fromFile) current[key] = fromFile[key];
  }
  applyEnvOverrides();
  return current;
}

export function getConfig() {
  return current;
}

function persist() {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* Windows 上可能失败，忽略 */
  }
}

/**
 * 规则：
 *  - null            => 清空该字段
 *  - '' 且为敏感字段 => 视为"不修改"
 *  - 其他            => 覆盖
 */
export function updateConfig(patch = {}) {
  const next = { ...current };
  for (const [key, raw] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;

    if (raw === null) {
      next[key] = '';
      continue;
    }
    if (raw === '') {
      if (SENSITIVE_FIELDS.includes(key)) continue;
      next[key] = '';
      continue;
    }
    next[key] = raw;
  }

  next.port = Number(next.port) || 3000;
  next.requestTimeoutMs = Number(next.requestTimeoutMs) || 120000;
  next.maxRetries = Number.isFinite(Number(next.maxRetries))
    ? Math.max(0, Math.min(8, Number(next.maxRetries)))
    : 4;
  next.retryBaseDelayMs = Number(next.retryBaseDelayMs) || 1000;
  next.maxRequestsPerMinute = Number(next.maxRequestsPerMinute) || 0;
  next.requestIntervalMs = Number.isFinite(Number(next.requestIntervalMs))
    ? Math.max(0, Number(next.requestIntervalMs))
    : 0;
  next.powEnabled =
    next.powEnabled === true ||
    next.powEnabled === 'true' ||
    next.powEnabled === 1;

  if (next.authorization && !/^Bearer\s/i.test(next.authorization)) {
    next.authorization = `Bearer ${String(next.authorization).trim()}`;
  }

  current = next;
  persist();
  return current;
}

function maskSummary(value) {
  if (!value) return '';
  return `已设置 · 共 ${String(value).length} 字符`;
}

export function publicConfig() {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const value = current[key];
    if (SENSITIVE_FIELDS.includes(key)) {
      out[key] = maskSummary(value);
      out[`${key}__set`] = Boolean(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}