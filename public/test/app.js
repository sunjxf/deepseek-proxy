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
    endpoint: sessionStorage.getItem('ds_endpoint') || '/v1/chat/completions',
    busy: false,
    raw: false,
    controller: null,
    images: [],
  };

  const SESSION_STORE = 'ds_session_id';
  const ENDPOINT_STORE = 'ds_endpoint';
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_IMAGES = 4;
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
      // 打开时把已累积但未渲染的原始行补写进 DOM
      const msg = el.closest('.msg');
      if (state.raw && msg && msg._raw && msg._rawLines) {
        msg._raw.textContent = msg._rawLines.slice(-2000).join('\n');
      }
    });
  });

  $('btn-clear').addEventListener('click', () => {
    $('chat-inner').innerHTML =
      '<div class="empty" id="empty">输入一句话开始测试。<br/>请求会经本地代理转发到上游。</div>';
  });

  $('btn-send').addEventListener('click', send);

  /* ---------- 端点切换 ---------- */

  $('endpoint-select').value = state.endpoint;

  function isNative() {
    return state.endpoint === '/api/v0/chat/completion';
  }

  function syncImageControls() {
    const native = isNative();
    $('btn-attach').disabled = native;
    $('btn-attach').style.opacity = native ? '0.5' : '';
    $('image-hint').textContent = native
      ? 'native 端点不支持自动上传图片，请手动上传后填 ref_file_ids'
      : `最多 ${MAX_IMAGES} 张，单张 ≤ ${MAX_IMAGE_BYTES / 1024 / 1024}MB`;
  }

  $('endpoint-select').addEventListener('change', (e) => {
    state.endpoint = e.target.value;
    sessionStorage.setItem(ENDPOINT_STORE, state.endpoint);
    syncImageControls();
  });

  /* ---------- 图片选择与预览 ---------- */

  $('btn-attach').addEventListener('click', () => $('file-input').click());

  $('file-input').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const file of files) addImageFile(file);
  });

  function addImageFile(file) {
    if (state.images.length >= MAX_IMAGES) {
      setStatus(`最多 ${MAX_IMAGES} 张图片`, 'err');
      return;
    }
    if (!file.type.startsWith('image/')) {
      setStatus('只支持图片文件', 'err');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setStatus(`图片过大（${Math.round(file.size / 1024)}KB），上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`, 'err');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const comma = dataUrl.indexOf(',');
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
      state.images.push({
        name: file.name,
        mime: file.type || 'image/png',
        dataUrl,
        base64,
      });
      renderThumbs();
    };
    reader.onerror = () => setStatus('读取图片失败', 'err');
    reader.readAsDataURL(file);
  }

  function renderThumbs() {
    const box = $('thumbs');
    box.innerHTML = '';
    box.hidden = state.images.length === 0;

    state.images.forEach((img, idx) => {
      const item = document.createElement('div');
      item.className = 'thumb';

      const el = document.createElement('img');
      el.src = img.dataUrl;
      el.alt = img.name;
      el.title = img.name;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'thumb-del';
      del.textContent = '×';
      del.title = '移除';
      del.addEventListener('click', () => {
        state.images.splice(idx, 1);
        renderThumbs();
      });

      item.append(el, del);
      box.appendChild(item);
    });
  }

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

  function addMessage(role, text, images) {
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

    // 用户消息附带的图片以缩略图形式挂在气泡下方
    if (Array.isArray(images) && images.length > 0) {
      const strip = document.createElement('div');
      strip.className = 'msg-images';
      for (const img of images) {
        const el = document.createElement('img');
        el.src = img.dataUrl;
        el.alt = img.name || '图片';
        el.title = img.name || '';
        strip.appendChild(el);
      }
      bubble.appendChild(strip);
    }

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

  /* ---------- 按端点构造请求体 ---------- */

  function buildRequestBody(prompt) {
    const thinking = $('thinking-switch').checked;
    const search = $('search-switch').checked;
    const images = state.images;

    // OpenAI 兼容
    if (state.endpoint === '/v1/chat/completions') {
      const content = [{ type: 'text', text: prompt }];
      for (const img of images) {
        content.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      }
      return {
        model: 'deepseek-chat',
        stream: true,
        thinking,
        search,
        messages: [{ role: 'user', content }],
      };
    }

    // Anthropic 兼容
    if (state.endpoint === '/v1/messages') {
      const content = [{ type: 'text', text: prompt }];
      for (const img of images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mime, data: img.base64 },
        });
      }
      return {
        model: 'deepseek-chat',
        max_tokens: 4096,
        stream: true,
        thinking,
        search,
        messages: [{ role: 'user', content }],
      };
    }

    // Native 直通
    return {
      chat_session_id: state.sessionId,
      parent_message_id: null,
      model_type: 'default',
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinking,
      search_enabled: search,
      action: null,
      preempt: false,
    };
  }

  /* ---------- Anthropic SSE 事件解析 ---------- */

  /**
   * 从 Anthropic 的 content_block_delta 事件里取增量文本。
   * 返回 null 表示该事件不含文本，无需处理。
   */
  function extractAnthropicDelta(event, obj) {
    if (event === 'content_block_delta') {
      const d = obj?.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string') return d.text;
      return null;
    }
    if (event === 'error') {
      return null;
    }
    return null;
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

    // native 端点必须显式带 session；兼容端点由代理自动创建会话
    if (isNative() && !state.sessionId) {
      setStatus('native 端点需要 chat_session_id，请先在配置页填写或手动输入', 'err');
      $('session-input').focus();
      return;
    }

    const images = state.images.slice();

    state.busy = true;
    $('btn-send').disabled = true;
    input.value = '';
    input.style.height = 'auto';

    addMessage('user', prompt, images);
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
      // 挂到消息上，供 raw-switch 变更时回填
      assistant._rawLines = rawLines;
      if (state.raw) {
        const view = rawLines.slice(-2000).join('\n');
        assistant._raw.textContent = view;
      }
    };

    const handleData = (data, eventName) => {
      if (!data) return;
      if (data === '[DONE]') return;
      pushRaw(eventName ? `event: ${eventName}\ndata: ${data}` : data);

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

      // Anthropic 的增量文本在 content_block_delta 事件里
      const anthropicText = extractAnthropicDelta(eventName, obj);
      if (anthropicText) {
        acc += anthropicText;
        paint(false);
        return;
      }

      // Anthropic error 事件
      if (eventName === 'error') {
        bizError = obj?.error?.message || JSON.stringify(obj).slice(0, 300);
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
      let eventName = null;
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (dataLines.length) handleData(dataLines.join('\n'), eventName);
    };

    const payload = buildRequestBody(prompt);

    try {
      const res = await fetch(state.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
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
      // 已随本次请求发出的图片不再复用，避免下一轮重复上传
      if (images.length > 0) {
        state.images = [];
        renderThumbs();
      }
      paint(true);
    }
  }

  window.addEventListener('error', (e) => {
    setStatus('脚本错误：' + e.message, 'err');
  });

  /* ---------- 启动 ---------- */

  syncImageControls();
  loadConfig();
})();