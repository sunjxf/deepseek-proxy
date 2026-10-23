/**
 * app.js - 配置页逻辑
 *
 * GROUPS 驱动表单渲染，SENSITIVE 字段（authorization）按掩码/清除语义处理。
 */

const SENSITIVE = new Set(['authorization']);

const GROUPS = [
  {
    title: '服务设置',
    desc: '修改 host / port 后需要重启进程才会生效。',
    fields: [
      { key: 'host', label: '监听地址', type: 'text', hint: '建议保持 127.0.0.1，不要暴露到公网' },
      { key: 'port', label: '端口', type: 'number' },
      { key: 'upstreamUrl', label: '上游地址', type: 'text', wide: true },
      { key: 'requestTimeoutMs', label: '请求超时（毫秒）', type: 'number' },
      { key: 'maxRetries', label: '最大重试次数', type: 'number', hint: '针对 429 / 5xx，0 表示不重试' },
      { key: 'retryBaseDelayMs', label: '重试基础延迟（毫秒）', type: 'number', hint: '指数退避起点，最大 16 秒' },
      {
        key: 'maxRequestsPerMinute',
        label: '本机限速（次/分钟）',
        type: 'number',
        hint: '0 表示不限速，用于避免触发上游 429',
      },
      {
        key: 'requestIntervalMs',
        label: '请求最小间隔（毫秒）',
        type: 'number',
        hint: '相邻两次请求至少间隔这么久，不足则等待。0 表示不限制',
      },
      { key: 'userAgent', label: 'User-Agent', type: 'text', wide: true },
    ],
  },
  {
    title: 'PoW 自动求解',
    desc: '开启后代理会在每次请求前自动获取 challenge 并求解，无需手动填写 x-ds-pow-response。',
    fields: [
      {
        key: 'powEnabled',
        label: '启用 PoW 自动求解',
        type: 'checkbox',
      },
      { key: 'powChallengeUrl', label: 'Challenge 地址', type: 'text', wide: true },
      { key: 'powTargetPath', label: 'Target Path', type: 'text', wide: true },
    ],
  },
  {
    title: '默认会话',
    desc: '测试页和代理请求在未提供 chat_session_id 时会使用这里的默认值。',
    fields: [
      {
        key: 'chatSessionId',
        label: 'chat_session_id',
        type: 'text',
        wide: true,
        hint: '从浏览器地址栏 .../a/chat/s/<这一段> 复制',
      },
    ],
  },
  {
    title: '上游凭证',
    desc: '来自浏览器已登录会话。请勿分享，不要提交到 Git。',
    fields: [
      {
        key: 'authorization',
        label: 'authorization',
        type: 'password',
        sensitive: true,
        hint: '可只填 token，保存时会自动补 Bearer 前缀',
      },
    ],
  },
];

const state = {
  config: null,
  runtime: null,
  dirty: {},
  cleared: new Set(),
};

const $ = (id) => document.getElementById(id);

/* ---------- API ---------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body,
  });

  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 空响应 */
  }

  if (!res.ok) {
    const err = new Error(data.error || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- Toast ---------- */

let toastTimer = null;
function toast(message, type = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${type}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (type !== 'error') {
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }
}

/* ---------- 渲染表单 ---------- */

function renderForm() {
  const form = $('form');
  form.innerHTML = '';

  for (const group of GROUPS) {
    const card = document.createElement('section');
    card.className = 'card';

    const h = document.createElement('h2');
    h.textContent = group.title;
    card.appendChild(h);

    if (group.desc) {
      const d = document.createElement('p');
      d.className = 'desc';
      d.textContent = group.desc;
      card.appendChild(d);
    }

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const f of group.fields) grid.appendChild(renderField(f));
    card.appendChild(grid);

    form.appendChild(card);
  }
}

function renderField(field) {
  const cfg = state.config || {};
  const wrap = document.createElement('div');
  wrap.className = 'field' + (field.wide || field.type === 'textarea' ? ' wide' : '');

  const label = document.createElement('label');
  label.textContent = field.label;
  label.htmlFor = `f_${field.key}`;
  wrap.appendChild(label);

  const inputWrap = document.createElement('div');
  inputWrap.className = 'input-wrap';

  // checkbox
  if (field.type === 'checkbox') {
    const input = document.createElement('input');
    input.id = `f_${field.key}`;
    input.type = 'checkbox';
    input.checked = cfg[field.key] !== false;
    inputWrap.appendChild(input);
    wrap.appendChild(inputWrap);

    if (field.hint) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = field.hint;
      wrap.appendChild(hint);
    }
    return wrap;
  }

  const input =
    field.type === 'textarea'
      ? document.createElement('textarea')
      : document.createElement('input');

  input.id = `f_${field.key}`;

  if (field.type === 'textarea') {
    input.rows = 3;
  } else {
    input.type = field.type || 'text';
  }

  const isSet = Boolean(cfg[`${field.key}__set`]);

  if (SENSITIVE.has(field.key)) {
    input.value = '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = isSet ? cfg[field.key] : '未设置';
    input.addEventListener('input', () => {
      state.dirty[field.key] = input.value;
      state.cleared.delete(field.key);
    });
  } else {
    input.value = cfg[field.key] ?? '';
  }

  inputWrap.appendChild(input);

  if (SENSITIVE.has(field.key)) {
    if (input.tagName === 'INPUT') {
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'mini';
      eye.textContent = '显示';
      eye.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        eye.textContent = show ? '隐藏' : '显示';
      });
      inputWrap.appendChild(eye);
    }

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'mini danger';
    clear.textContent = '清除';
    clear.addEventListener('click', () => {
      input.value = '';
      input.placeholder = '已标记为清除，保存后生效';
      state.cleared.add(field.key);
      delete state.dirty[field.key];
    });
    inputWrap.appendChild(clear);
  }

  wrap.appendChild(inputWrap);

  if (field.hint) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = field.hint;
    wrap.appendChild(hint);
  }

  return wrap;
}

/* ---------- 渲染状态 ---------- */

function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}

function renderStatus() {
  const r = state.runtime || {};
  const box = $('stats');
  box.innerHTML = '';

  const items = [
    ['运行时长', formatDuration(r.uptimeMs)],
    ['代理请求总数', String(r.totalRequests ?? 0)],
    ['成功 / 失败', `${r.successRequests ?? 0} / ${r.failedRequests ?? 0}`],
    ['重试次数 / 本机节流', `${r.retriedRequests ?? 0} / ${r.throttledRequests ?? 0}`],
    ['最近请求时间', r.lastRequestAt ? new Date(r.lastRequestAt).toLocaleString() : '—'],
    ['Node 版本', r.node || '—'],
    [
      '最近错误',
      r.lastError
        ? `${r.lastError}（${new Date(r.lastErrorAt).toLocaleString()}）`
        : '无',
      r.lastError ? 'err' : '',
    ],
  ];

  for (const [k, v, cls] of items) {
    const div = document.createElement('div');
    div.className = 'stat';
    const kEl = document.createElement('div');
    kEl.className = 'k';
    kEl.textContent = k;
    const vEl = document.createElement('div');
    vEl.className = `v ${cls || ''}`;
    vEl.textContent = v;
    div.append(kEl, vEl);
    box.appendChild(div);
  }

  $('cfg-path').textContent = r.configPath || '—';

  const dot = $('health-dot');
  dot.className =
    'dot ' + (r.lastError && r.lastErrorAt > Date.now() - 60000 ? 'err' : 'ok');
}

/* ---------- 数据加载 ---------- */

async function refresh() {
  const data = await api('/admin/api/config');
  state.config = data.config;
  state.runtime = data.runtime;
  renderForm();
  renderStatus();
}

/* ---------- 保存 ---------- */

async function save() {
  const payload = {};

  for (const group of GROUPS) {
    for (const f of group.fields) {
      if (SENSITIVE.has(f.key)) {
        if (state.cleared.has(f.key)) payload[f.key] = null;
        else if (f.key in state.dirty) payload[f.key] = state.dirty[f.key];
      } else if (f.type === 'checkbox') {
        const el = $(`f_${f.key}`);
        payload[f.key] = el.checked;
      } else {
        const el = $(`f_${f.key}`);
        payload[f.key] = f.type === 'number' ? Number(el.value) : el.value;
      }
    }
  }

  const data = await api('/admin/api/config', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });

  state.config = data.config;
  state.dirty = {};
  state.cleared = new Set();

  renderForm();
  await refresh();
  toast(data.restartRequired ? '已保存，host/port 变更需重启进程' : '已保存', 'ok');
}

/* ---------- 测试连接 ---------- */

async function testConnection() {
  toast('正在测试上游连接…');
  try {
    const data = await api('/admin/api/test', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    if (data.ok) {
      toast(`上游连通，HTTP ${data.status}，耗时 ${data.ms}ms`, 'ok');
    } else {
      const detail = data.error || (data.preview || '').slice(0, 160);
      toast(`上游返回 HTTP ${data.status}：${detail}`, 'error');
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------- 启动 ---------- */

async function boot() {
  $('btn-save').addEventListener('click', () =>
    save().catch((e) => toast(e.message, 'error'))
  );
  $('btn-refresh').addEventListener('click', () =>
    refresh().catch((e) => toast(e.message, 'error'))
  );
  $('btn-test').addEventListener('click', testConnection);

  try {
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
}

boot();