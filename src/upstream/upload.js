/**
 * upload.js - 图片上传到 DeepSeek
 *
 * POST https://chat.deepseek.com/api/v0/file/upload_file
 * multipart 字段名 `file`，响应 data.biz_data.id 即 file_id（形如 file-<uuid>）。
 * 上传成功后，completion 请求里通过 ref_file_ids 引用。
 *
 * 注意：上传接口的 PoW target_path 与 completion 不同，这里显式覆盖。
 */

import { solveAndBuildHeader } from '../pow.js';
import { buildUpstreamHeaders } from './client.js';
import { makeLog } from '../logger.js';

const log = makeLog('upload');

export const UPLOAD_URL =
  'https://chat.deepseek.com/api/v0/file/upload_file';
export const UPLOAD_POW_TARGET = '/api/v0/file/upload_file';

function extFromMime(mime) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
  };
  return map[mime] || 'bin';
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function calcDelay(attempt, retryAfterHeader, baseDelay) {
  if (retryAfterHeader) {
    const sec = Number(retryAfterHeader);
    if (!Number.isNaN(sec) && sec > 0) return Math.min(sec * 1000, 30_000);
  }
  const base = baseDelay * 2 ** attempt;
  const jitter = Math.random() * 500;
  return Math.min(base + jitter, 16_000);
}

/**
 * 上传一张图片，返回 file_id。
 *
 * 不复用 client.js 的 fetchWithRetry：那里对 options.body 复用同一实例，
 * 而 multipart body 每次重试都应重新构造（boundary 与流状态都不保证可重放）。
 * 这里用 buildBody 工厂在每次尝试时重建 FormData。
 *
 * @param {object} cfg 配置
 * @param {object} req 原始请求（用于复用 referer 等头）
 * @param {{ mime: string, buffer: Buffer, name?: string }} image
 * @param {object} lg logger
 * @returns {Promise<string>} file_id
 */
export async function uploadImage(cfg, req, image, lg = log) {
  const { mime, buffer } = image;
  const name = image.name || `image.${extFromMime(mime)}`;
  const started = Date.now();

  // 上传接口的 PoW target path 与 completion 不同。
  // 与 completion 不同，这里 PoW 失败直接抛错：无 PoW 的上传大概率 401/403，
  // 继续发只会浪费一次往返，且错误信息会被 uploadImages 吞成「跳过该图片」。
  // 所以失败前必须留下日志，否则只会在 uploadImages 看到一句笼统的「跳过」。
  let powHeader = null;
  if (cfg.powEnabled !== false && !req.headers['x-ds-pow-response']) {
    const powStarted = Date.now();
    try {
      powHeader = await solveAndBuildHeader(cfg, UPLOAD_POW_TARGET);
      lg.debug('upload', '上传 PoW 求解成功', {
        target: UPLOAD_POW_TARGET,
        ms: Date.now() - powStarted,
      });
    } catch (e) {
      lg.warn('upload', '上传 PoW 求解失败，放弃该图片', {
        target: UPLOAD_POW_TARGET,
        ms: Date.now() - powStarted,
        error: e.message,
      });
      throw e;
    }
  }

  const headers = buildUpstreamHeaders(cfg, req, powHeader);
  // 让 fetch 自己带 multipart boundary，不能复用 application/json
  delete headers['content-type'];
  headers['x-file-size'] = String(buffer.length);
  headers['x-model-type'] = 'default';

  const buildBody = () => {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), name);
    return form;
  };

  const maxRetries = Number(cfg.maxRetries) || 0;
  const baseDelay = Number(cfg.retryBaseDelayMs) || 1000;
  const timeoutMs = Number(cfg.requestTimeoutMs) || 120000;

  let res = null;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const attemptStarted = Date.now();

    try {
      lg.debug('upload', '发送上传请求', {
        url: UPLOAD_URL,
        attempt,
        bytes: buffer.length,
        mime,
      });

      res = await fetch(UPLOAD_URL, {
        method: 'POST',
        headers,
        body: buildBody(),
        signal: controller.signal,
      });
      clearTimeout(timer);

      lg.debug('upload', '上传响应', {
        status: res.status,
        ms: Date.now() - started,
        attempt,
      });

      if (!RETRYABLE_STATUS.has(res.status) || attempt === maxRetries) break;

      const delay = calcDelay(
        attempt,
        res.headers.get('retry-after'),
        baseDelay
      );
      await res.text().catch(() => {});
      lg.warn('upload', '上传可重试状态，等待后重试', {
        status: res.status,
        attempt,
        delayMs: Math.round(delay),
      });
      await sleep(delay);
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      const kind = e.name === 'AbortError' ? 'timeout' : e.message;
      if (attempt === maxRetries) {
        lg.error('upload', '上传请求最终失败', {
          attempt,
          ms: Date.now() - started,
          error: kind,
        });
        throw e;
      }
      const delay = calcDelay(attempt, null, baseDelay);
      lg.warn('upload', '上传请求异常，准备重试', {
        attempt,
        ms: Date.now() - started,
        error: kind,
        delayMs: Math.round(delay),
      });
      await sleep(delay);
    }
  }

  if (!res) {
    throw lastError || new Error('上传无响应');
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    lg.debug('upload', '上传响应非 2xx', {
      status: res.status,
      bodyPreview: text.slice(0, 200),
    });
    throw new Error(`上传 HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    lg.debug('upload', '上传响应非 JSON', {
      status: res.status,
      bodyPreview: text.slice(0, 200),
    });
    throw new Error(`上传响应非 JSON：${text.slice(0, 200)}`);
  }

  if (data.code !== 0 && data.code !== undefined) {
    lg.debug('upload', '上传业务错误', {
      code: data.code,
      msg: data.msg,
    });
    throw new Error(`上传业务错误 code=${data.code} msg=${data.msg}`);
  }

  const id = data?.data?.biz_data?.id;
  if (!id) {
    lg.debug('upload', '上传响应缺少 file id', {
      bodyPreview: text.slice(0, 300),
    });
    throw new Error(`上传响应缺少 file id：${text.slice(0, 300)}`);
  }

  lg.info('upload', '图片上传成功', {
    id,
    mime,
    bytes: buffer.length,
    isImage: data?.data?.biz_data?.is_image,
    ms: Date.now() - started,
  });

  return id;
}

/**
 * 批量上传图片，返回成功的 file_id 数组。
 *
 * 单张失败不中断整体流程：记录警告后跳过，调用方负责降级
 * （按当前策略，失败图片在 prompt 里保留 [图片] 占位）。
 *
 * @param {object} cfg 配置
 * @param {object} req 原始请求
 * @param {Array<{mime: string, buffer: Buffer, name?: string}>} images
 * @param {object} lg logger
 * @returns {Promise<string[]>} file_id 数组
 */
export async function uploadImages(cfg, req, images, lg = log) {
  if (!Array.isArray(images) || images.length === 0) {
    lg.debug('upload', '无图片需要上传');
    return [];
  }

  const started = Date.now();
  const totalBytes = images.reduce(
    (n, img) => n + (img?.buffer?.length || 0),
    0
  );
  lg.info('upload', '开始批量上传图片', {
    count: images.length,
    totalBytes,
    mimes: images.map((i) => i?.mime),
  });

  const ids = [];
  let failed = 0;
  for (const img of images) {
    try {
      const id = await uploadImage(cfg, req, img, lg);
      ids.push(id);
    } catch (e) {
      failed++;
      lg.warn('upload', '图片上传失败，跳过该图片', {
        mime: img?.mime,
        bytes: img?.buffer?.length,
        error: e.message,
      });
    }
  }

  lg.info('upload', '批量上传完成', {
    count: images.length,
    uploaded: ids.length,
    failed,
    totalBytes,
    ms: Date.now() - started,
  });

  return ids;
}
