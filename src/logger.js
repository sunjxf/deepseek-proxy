import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 日志级别 ---------- */

// 日志级别：error < warn < info < debug，由 LOG_LEVEL 环境变量控制，默认 info
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL =
  LOG_LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 2;

/* ---------- 日志文件 ---------- */

// 日志文件：默认 <项目根>/logs/app.log，可用 LOG_FILE 覆盖；LOG_TO_FILE=0 可关闭
const LOG_FILE =
  process.env.LOG_FILE || path.join(__dirname, '..', 'logs', 'app.log');
const LOG_TO_FILE = String(process.env.LOG_TO_FILE ?? '1') !== '0';
// 单文件大小上限（默认 50MB），超过后轮转为 app.log.1
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES) || 50 * 1024 * 1024;
// 日志保留天数：按天切分日志文件，并删除超过该天数的旧文件。0 表示不清理
const LOG_KEEP_DAYS = Number(process.env.LOG_KEEP_DAYS ?? 2) || 0;

const LOG_DIR = path.dirname(LOG_FILE);
const LOG_BASE = path.basename(LOG_FILE);
const LOG_EXT = path.extname(LOG_FILE);
const LOG_STEM = LOG_BASE.slice(0, LOG_BASE.length - LOG_EXT.length);

let logStream = null;
let logBytes = 0;
let logDay = '';

// 本地日期 YYYY-MM-DD，用于按天切分文件名
function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 当天日志文件名：app.log -> app-2026-10-24.log
function dayLogFile(day = localDay()) {
  return path.join(LOG_DIR, `${LOG_STEM}-${day}${LOG_EXT}`);
}

function openLogStream() {
  if (!LOG_TO_FILE) return null;
  const file = dayLogFile(logDay);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      logBytes = fs.statSync(file).size;
    } catch {
      logBytes = 0;
    }
    const s = fs.createWriteStream(file, { flags: 'a' });
    s.on('error', (e) => {
      // 写文件失败不能让服务崩溃，降级为仅 console
      console.error('[log] 日志文件写入失败，已降级为仅控制台：', e.message);
      logStream = null;
    });
    return s;
  } catch (e) {
    console.error('[log] 无法创建日志文件，已降级为仅控制台：', e.message);
    return null;
  }
}

// 删除超过保留天数的日志文件（只动本服务命名的 app-YYYY-MM-DD.log / .log.N）
function cleanupOldLogs() {
  if (!LOG_TO_FILE || LOG_KEEP_DAYS <= 0) return;
  const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
  const re = new RegExp(
    `^${LOG_STEM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{4}-\\d{2}-\\d{2})${LOG_EXT.replace(/\./g, '\\.')}(\\.\\d+)?$`
  );
  let names;
  try {
    names = fs.readdirSync(LOG_DIR);
  } catch {
    return;
  }
  let removed = 0;
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    const dayEnd = new Date(`${m[1]}T23:59:59.999`).getTime();
    if (!Number.isFinite(dayEnd) || dayEnd >= cutoff) continue;
    try {
      fs.rmSync(path.join(LOG_DIR, name), { force: true });
      removed++;
    } catch {
      /* 忽略单个文件删除失败 */
    }
  }
  if (removed > 0) {
    console.log(`[log] 已清理 ${removed} 个超过 ${LOG_KEEP_DAYS} 天的日志文件`);
  }
}

// 按天切换日志文件
function ensureLogDay() {
  const day = localDay();
  if (day === logDay && logStream) return;
  try {
    logStream?.end();
  } catch {
    /* 忽略 */
  }
  logDay = day;
  logStream = openLogStream();
  cleanupOldLogs();
}

function rotateIfNeeded() {
  if (!logStream || logBytes < LOG_MAX_BYTES) return;
  try {
    logStream.end();
    const base = dayLogFile(logDay);
    // 大小轮转：app-YYYY-MM-DD.log -> app-YYYY-MM-DD.log.1，已有则删除
    const backup = `${base}.1`;
    fs.rmSync(backup, { force: true });
    fs.renameSync(base, backup);
    logBytes = 0;
    logStream = openLogStream();
  } catch (e) {
    console.error('[log] 日志轮转失败：', e.message);
  }
}

function writeToFile(line) {
  if (!LOG_TO_FILE) return;
  ensureLogDay();
  if (!logStream) return;
  try {
    logStream.write(line);
    logBytes += Buffer.byteLength(line);
    rotateIfNeeded();
  } catch {
    /* 忽略：日志失败不影响主流程 */
  }
}

/* ---------- 初始化 ---------- */

logDay = localDay();
logStream = openLogStream();
cleanupOldLogs();
if (LOG_KEEP_DAYS > 0) {
  // 每小时检查一次，处理跨天切换与过期清理（unref 不阻止进程退出）
  const timer = setInterval(() => {
    ensureLogDay();
    cleanupOldLogs();
  }, 60 * 60 * 1000);
  timer.unref?.();
}

/* ---------- 格式化 ---------- */

// 日期时间（本地时区）YYYY-MM-DD HH:mm:ss.SSS
function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

// 把日志参数拼成一行可读文本（对非字符串做序列化）
function formatArgs(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

/* ---------- 对外接口 ---------- */

export function makeLog(scope, rid) {
  const prefix = () => `[${ts()}][${scope}]${rid ? `[${rid}]` : ''}`;
  const emit = (level, consoleFn, minLevel, args) => {
    if (LOG_LEVEL < minLevel) return;
    const line = `${prefix()} ${formatArgs(args)}\n`;
    consoleFn(line.trimEnd());
    writeToFile(line);
  };
  return {
    error: (...a) => emit('error', console.error, 0, a),
    warn: (...a) => emit('warn', console.warn, 1, a),
    info: (...a) => emit('info', console.log, 2, a),
    debug: (...a) => emit('debug', console.log, 3, a),
  };
}

// 每个请求一个短 ID，便于把同一请求的多行日志串起来
let reqSeq = 0;
export function newRequestId() {
  reqSeq = (reqSeq + 1) % 100000;
  return `${reqSeq.toString(36)}-${Date.now().toString(36).slice(-4)}`;
}

// 截断长文本用于日志，避免刷屏
export function preview(text, len = 200) {
  if (text == null) return '';
  const s = String(text).replace(/\s+/g, ' ');
  return s.length > len ? s.slice(0, len) + `…(${s.length}字符)` : s;
}

// 三段式日志：大模型原始响应 → 解析成工具调用最终格式 → 正文清洗后。
// calls 为 OpenAI tool_calls 数组或 Anthropic tool_use 数组，原样 JSON 输出。
export function formatExchange(raw, calls, clean) {
  const n = Array.isArray(calls) ? calls.length : 0;
  return (
    `\n----- 大模型响应（原始 ${raw.length} 字符）-----\n` +
    (raw || '(空)') +
    `\n----- 解析成工具调用最终格式（${n} 个）-----\n` +
    (n > 0 ? JSON.stringify(calls, null, 2) : '(无)') +
    `\n----- 正文清洗后（${clean.length} 字符）-----\n` +
    (clean || '(空)') +
    `\n----- 结束 -----`
  );
}

// 把请求体序列化成一行完整 JSON 用于日志。
// 默认上限 1M 个 UTF-16 字符（不是字节；中文落盘字节约为字符数 × 3），
// 超出按字符数截断并在尾部标注完整长度；设置为 0 可完全关闭请求体日志。
const LOG_BODY_MAX = Number(process.env.LOG_BODY_MAX ?? 1024 * 1024);
export function dumpBody(body) {
  if (LOG_BODY_MAX === 0) return '(已关闭)';
  let s;
  try {
    s = JSON.stringify(body);
  } catch (e) {
    return `(序列化失败：${e.message})`;
  }
  if (s == null) return '(空)';
  if (LOG_BODY_MAX > 0 && s.length > LOG_BODY_MAX) {
    return s.slice(0, LOG_BODY_MAX) + `…(截断，完整 ${s.length} 字符)`;
  }
  return s;
}

// 供启动日志使用
export const logInfo = {
  logFile: LOG_TO_FILE ? LOG_FILE : '(已关闭)',
  logToFile: LOG_TO_FILE,
};
