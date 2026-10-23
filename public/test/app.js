/**
 * app.js - 对话测试页逻辑
 *
 * 从原 test.html 内联 <script> 原样搬出。功能全部保留：
 *   - session 输入与 sessionStorage 持久化
 *   - 从配置页读取默认 chat_session_id
 *   - thinking_enabled / search_enabled 开关
 *   - 原始 SSE 展示
 *   - SSE 增量解析与流式渲染
 */

(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    sessionId: sessionStorage.getItem('ds_session_id') || '',
    busy: false,
    raw: false,
    controller: null,
  };

  const SESSION_STORE = 'ds_session_id';
  // 用户手动改过输入框后，不再用配置值覆盖
  const SESSION_EDITED = 'ds_session_edited';

  function isSessionEdited() {
    return sessionStorage.getItem(SESSION_EDITED) === '1';
  }

  /* ---------- 初始化 UI ---------- */

  $('session-input').value = state.sessionId;

  $('session-input').addEventListener('input', () => {
    state.sessionId = $('session-input').value.trim();
    sessionStorage.setItem(SESSION_STORE, state.sessionId);
    sessionStorage.setItem(SESSION_EDITED, '1');
  });

  $('raw-switch').addEventListener('change', (e) => {
    state.raw = e.target.checked;
    document.querySelectorAll('.raw-block').forEach((el) => {
      el.hidden = !state.raw;
    });
  });

  $('btn-clear').addEventListener('click', () => {
    $('chat-inner').innerHTML =
      '<div class="empty" id="empty">输入一句话开始测试。<br/>请求会经本地代理转发到上游。</div>';
  });

  $('btn-send').addEventListener('click', send);

  $('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  $('prompt').addEventListener('input', () => {
    const el = $('prompt');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  });

  /* ---------- 从配置页加载默认 session id ---------- */

  async function loadConfig() {
    try {
      const res = await fetch('/admin/api/config');
      const data = await res.json();
      const cfgId = data?.config?.chatSessionId || '';
      // 配置值优先，除非用户手动编辑过输入框
      if (cfgId && !isSessionEdited()) {
        state.sessionId = cfgId;
        $('session-input').value = cfgId;
        sessionStorage.setItem(SESSION_STORE, cfgId);
      }
    } catch {
      /* 配置接口不可用时忽略 */
    }
  }

  /* ---------- 工具函数 ---------- */

  function setStatus(text, cls) {
    $('status-text').textContent = text;
    $('dot').className = 'dot ' + (cls || '');
  }

  function scrollBottom() {
    const chat = $('chat');
    chat.scrollTop = chat.scrollHeight;
  }

  function addMessage(role, text) {
    const empty = $('empty');
    if (empty) empty.remove();

    const msg = document.createElement('div');
    msg.className = 'msg ' + role;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const roleEl = document.createElement('div');
    roleEl.className = 'role';
    roleEl.textContent = role === 'user' ? '我' : 'assistant';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    wrap.append(roleEl, bubble);

    if (role === 'assistant') {
      const rawBlock = document.createElement('details');
      rawBlock.className = 'raw-block';
      rawBlock.hidden = !state.raw;
      rawBlock.open = false;
      const summary = document.createElement('summary');
      summary.textContent = '原始 SSE';
      const raw = document.createElement('div');
      raw.className = 'raw';
      raw.textContent = '';
      rawBlock.append(summary, raw);
      wrap.appendChild(rawBlock);
      msg._raw = raw;
    }

    msg.appendChild(wrap);
    msg._bubble = bubble;
    $('chat-inner').appendChild(msg);
    scrollBottom();
    return msg;
  }

  /* ---------- 文本提取 ---------- */

  function extractText(obj) {
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj)) return obj.map(extractText).join('');
    if (!obj || typeof obj !== 'object') return '';

    const { p, o, v } = obj;

    // BATCH 批量操作
    if (o === 'BATCH' && Array.isArray(v)) {
      return v.map(extractText).join('');
    }

    // 初始响应对象
    if (
      v &&
      typeof v === 'object' &&
      v.response &&
      Array.isArray(v.response.fragments)
    ) {
      return v.response.fragments
        .map((f) => (typeof f.content === 'string' ? f.content : ''))
        .join('');
    }

    // 显式追加
    if (typeof v === 'string' && typeof p === 'string') {
      if (p.endsWith('/content') || p === 'response/content') {
        return o === 'APPEND' || o === 'SET' ? v : '';
      }
      return '';
    }

    // 隐式追加（无 p）
    if (typeof v === 'string' && p === undefined) {
      return v;
    }

    // OpenAI 兼容
    const delta = obj.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') return delta;

    const message = obj.choices?.[0]?.message?.content;
    if (typeof message === 'string') return message;

    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.text === 'string') return obj.text;

    return '';
  }

  function extractBizError(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (
      obj.data &&
      typeof obj.data.biz_code === 'number' &&
      obj.data.biz_code !== 0
    ) {
      return obj.data.biz_msg || `biz_code=${obj.data.biz_code}`;
    }
    if (typeof obj.code === 'number' && obj.code !== 0 && obj.msg) {
      return `code=${obj.code} ${obj.msg}`;
    }
    return null;
  }

  /* ---------- 发送 ---------- */

  async function send() {
    if (state.busy) return;

    const input = $('prompt');
    const prompt = input.value.trim();
    if (!prompt) return;

    if (!state.sessionId) {
      setStatus('请先在配置页填写 chat_session_id，或在上方手动输入', 'err');
      $('session-input').focus();
      return;
    }

    state.busy = true;
    $('btn-send').disabled = true;
    input.value = '';
    input.style.height = 'auto';

    addMessage('user', prompt);
    const assistant = addMessage('assistant', '');
    assistant._bubble.classList.add('pending');

    setStatus('请求中…', '');

    const controller = new AbortController();
    state.controller = controller;

    let acc = '';
    const rawLines = [];
    let lastPaint = 0;
    let bizError = null;

    const paint = (force) => {
      const now = performance.now();
      if (!force && now - lastPaint < 50) return;
      lastPaint = now;
      assistant._bubble.textContent = acc;
      scrollBottom();
    };

    const pushRaw = (line) => {
      rawLines.push(line);
      if (state.raw) {
        const view = rawLines.slice(-2000).join('\n');
        assistant._raw.textContent = view;
      }
    };

    const handleData = (data) => {
      if (!data) return;
      if (data === '[DONE]') return;
      pushRaw(data);

      let obj;
      try {
        obj = JSON.parse(data);
      } catch {
        return;
      }

      const err = extractBizError(obj);
      if (err) {
        bizError = err;
        return;
      }

      const text = extractText(obj);
      if (text) {
        acc += text;
        paint(false);
      }
    };

    const processEvent = (chunk) => {
      const lines = chunk.split('\n');
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (dataLines.length) handleData(dataLines.join('\n'));
    };

    try {
      const res = await fetch('/api/v0/chat/completion', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          chat_session_id: state.sessionId,
          parent_message_id: null,
          model_type: 'default',
          prompt,
          ref_file_ids: [],
          thinking_enabled: $('thinking-switch').checked,
          search_enabled: $('search-switch').checked,
          action: null,
          preempt: false,
        }),
      });

      setStatus('HTTP ' + res.status, res.ok ? '' : 'err');

      if (!res.ok) {
        const text = await res.text();
        assistant._bubble.classList.remove('pending');
        assistant._bubble.classList.add('error');
        assistant._bubble.textContent =
          `[HTTP ${res.status}]\n` + text.slice(0, 1200);
        return;
      }

      if (!res.body) {
        const text = await res.text();
        assistant._bubble.textContent = text || '(空响应)';
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          processEvent(chunk);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) processEvent(buffer.replace(/\r\n/g, '\n'));

      paint(true);

      if (bizError) {
        assistant._bubble.classList.add('error');
        assistant._bubble.textContent = acc
          ? acc + `\n\n[业务错误] ${bizError}`
          : `[业务错误] ${bizError}`;
        setStatus('业务错误', 'err');
        return;
      }

      if (!acc) {
        assistant._bubble.textContent =
          '(未解析出文本，请打开"显示原始"查看上游数据)';
      }

      setStatus('完成', 'ok');
    } catch (e) {
      assistant._bubble.classList.remove('pending');
      if (e.name === 'AbortError') {
        assistant._bubble.textContent = acc || '(已取消)';
        setStatus('已取消', 'err');
      } else {
        assistant._bubble.classList.add('error');
        assistant._bubble.textContent = '[请求异常] ' + e.message;
        setStatus('请求异常', 'err');
      }
    } finally {
      assistant._bubble.classList.remove('pending');
      state.busy = false;
      state.controller = null;
      $('btn-send').disabled = false;
      paint(true);
    }
  }

  window.addEventListener('error', (e) => {
    setStatus('脚本错误：' + e.message, 'err');
  });

  /* ---------- 启动 ---------- */

  loadConfig();
})();