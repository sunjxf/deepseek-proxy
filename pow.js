import PowSolver from '@rezaparsian/deepseek-pow-solver';

let solverInstance = null;
let solverReady = false;

async function ensureSolver() {
  if (solverReady) return solverInstance;
  solverInstance = new PowSolver();
  await solverInstance.init();
  solverReady = true;
  console.log('[pow] WASM 求解器已初始化');
  return solverInstance;
}

export async function fetchChallenge(cfg) {
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
    throw new Error(
      `获取 PoW challenge 失败：HTTP ${res.status} ${text.slice(0, 200)}`
    );
  }

  const data = await res.json();

  if (data.code !== 0 && data.code !== undefined) {
    throw new Error(
      `获取 PoW challenge 业务错误：code=${data.code} msg=${data.msg}`
    );
  }

  const challenge =
    data?.data?.biz_data?.challenge ||
    data?.biz_data?.challenge ||
    data?.data?.challenge;

  if (!challenge || !challenge.challenge || !challenge.salt) {
    throw new Error(
      `PoW challenge 结构异常：${JSON.stringify(data).slice(0, 300)}`
    );
  }

  return challenge;
}

export async function solveAndBuildHeader(cfg) {
  const solver = await ensureSolver();
  const challenge = await fetchChallenge(cfg);

  const payload = solver.solve(challenge);

  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, 'utf8').toString('base64');

  console.log(
    `[pow] 求解完成 algorithm=${payload.algorithm} answer=${payload.answer}`
  );

  return base64;
}