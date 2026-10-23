import PowSolver from '@rezaparsian/deepseek-pow-solver';

let solverInstance = null;
let solverReady = false;

// 轻量日志：默认走 console，可通过 setPowLogger 注入
let plog = (level, msg, extra) => {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[pow] ${msg}`, extra ?? '');
};

export function setPowLogger(fn) {
  if (typeof fn === 'function') plog = fn;
}

async function ensureSolver() {
  if (solverReady) return solverInstance;
  const started = Date.now();
  plog('debug', '初始化 WASM 求解器');
  solverInstance = new PowSolver();
  await solverInstance.init();
  solverReady = true;
  plog('info', 'WASM 求解器已初始化', { ms: Date.now() - started });
  return solverInstance;
}

export async function fetchChallenge(cfg) {
  const started = Date.now();
  plog('debug', '获取 PoW challenge', { url: cfg.powChallengeUrl });

  const res = await fetch(cfg.powChallengeUrl, {
    method: 'POST',
    headers: {
      authorization: cfg.authorization,
      'content-type': 'application/json',
      accept: '*/*',
      origin: 'https://chat.deepseek.com',
      referer: 'https://chat.deepseek.com/',
      'user-agent': cfg.userAgent,
      'x-client-bundle-id': 'com.deepseek.chat',
      'x-client-locale': 'zh_CN',
      'x-client-platform': 'web',
      'x-client-timezone-offset': '28800',
      'x-client-version': '2.5.0',
    },
    body: JSON.stringify({ target_path: cfg.powTargetPath }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    plog('error', '获取 PoW challenge 失败', {
      status: res.status,
      ms: Date.now() - started,
      body: text.slice(0, 200),
    });
    throw new Error(
      `获取 PoW challenge 失败：HTTP ${res.status} ${text.slice(0, 200)}`
    );
  }

  const data = await res.json();

  if (data.code !== 0 && data.code !== undefined) {
    plog('error', 'PoW challenge 业务错误', { code: data.code, msg: data.msg });
    throw new Error(
      `获取 PoW challenge 业务错误：code=${data.code} msg=${data.msg}`
    );
  }

  const challenge =
    data?.data?.biz_data?.challenge ||
    data?.biz_data?.challenge ||
    data?.data?.challenge;

  if (!challenge || !challenge.challenge || !challenge.salt) {
    plog('error', 'PoW challenge 结构异常', {
      preview: JSON.stringify(data).slice(0, 300),
    });
    throw new Error(
      `PoW challenge 结构异常：${JSON.stringify(data).slice(0, 300)}`
    );
  }

  plog('debug', '拿到 PoW challenge', {
    ms: Date.now() - started,
    algorithm: challenge.algorithm,
    difficulty: challenge.difficulty,
  });
  return challenge;
}

export async function solveAndBuildHeader(cfg) {
  const started = Date.now();
  const solver = await ensureSolver();
  const challenge = await fetchChallenge(cfg);

  const payload = solver.solve(challenge);

  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, 'utf8').toString('base64');

  plog('info', 'PoW 求解完成', {
    ms: Date.now() - started,
    algorithm: payload.algorithm,
    answer: payload.answer,
    headerBytes: base64.length,
  });

  return base64;
}