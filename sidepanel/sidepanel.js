'use strict';

/*
 * 学习助手 · 侧边栏
 * 消费 storage.session 的任务 → 组装上下文 → 流式请求 → 安全渲染。
 */

const els = {
  thread: document.getElementById('thread'),
  empty: document.getElementById('empty'),
  input: document.getElementById('input'),
  send: document.getElementById('btn-send'),
  stop: document.getElementById('btn-stop'),
  newBtn: document.getElementById('btn-new'),
  settingsBtn: document.getElementById('btn-settings'),
  goSettings: document.getElementById('btn-go-settings'),
  ctxChip: document.getElementById('ctx-chip'),
  ctxChipText: document.getElementById('ctx-chip-text'),
  ctxChipClose: document.getElementById('ctx-chip-close'),
  modelSelect: document.getElementById('model-select'),
  status: document.getElementById('status-bar'),
  adBtn: document.getElementById('btn-ad'),
  imgBtn: document.getElementById('btn-img'),
  shotBtn: document.getElementById('btn-shot'),
  shotPreview: document.getElementById('shot-preview'),
  shotImg: document.getElementById('shot-img'),
  shotPrompts: document.getElementById('shot-prompts'),
  shotCancel: document.getElementById('shot-cancel'),
  navDots: document.getElementById('nav-dots'),
  navTop: document.getElementById('nav-top'),
  navBottom: document.getElementById('nav-bottom'),
  navList: document.getElementById('nav-list')
};

// 截图后的默认问图问题
const SHOT_PROMPTS = [
  '这张图讲了什么？详细解读。',
  '帮我解读这张流程图 / 示意图的逻辑。',
  '提取图中所有文字、数字和标注。',
  '这张图的关键信息和结论是什么？'
];

let settings = null;
let thread = [];            // [{role: 'system'|'user'|'assistant', content, image?, ts}]
let processedTaskId = null; // 已消费的最新任务（session 级持久，防面板重开重复消费）
let abortCtl = null;        // 当前流式请求的控制器
let pendingCtx = null;      // 「自定义问题」待引用的选区上下文
let pageCtx = null;         // 最近捕获的页面上下文（自由提问时感知当前页面）
let imgMode = 'normal';     // 图片显示模式：normal / thumb / hidden
let adEnabled = true;       // 免广告开关（默认开）
let pendingImage = null;    // 待发送的截图 dataURL（问图）
let autoScroll = true;      // 用户手动上滚则暂停跟随

marked.use({ breaks: true, gfm: true });

init().catch((err) => console.error('[webbuddy] 初始化失败:', err));

async function init() {
  settings = await getMergedSettings();
  renderModelSelect();
  await loadThread();
  await loadPageCtx();
  await loadImgMode();
  await loadAdBlock();
  renderThread();
  bindUI();
  bindStorage();
  await catchUpTask(); // 面板刚打开时主动读任务，防错过事件（竞态双保险）
  // 回到侧边栏时重读配置：覆盖「打开设置页改完后切回」的场景
  window.addEventListener('focus', refreshSettings);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshSettings();
  });
  updateEmptyState();
  updateSendState();
}

/* ================= 任务消费 ================= */

async function catchUpTask() {
  const data = await chrome.storage.session.get([TASK_KEY, MARKER_KEY]);
  processedTaskId = data[MARKER_KEY] || null;
  const task = data[TASK_KEY];
  if (task && task.taskId && task.taskId !== processedTaskId) {
    handleTask(task);
  }
}

async function handleTask(task) {
  processedTaskId = task.taskId;
  chrome.storage.session.set({ [MARKER_KEY]: task.taskId });

  // 新任务打断进行中的流式输出
  if (abortCtl) {
    const old = abortCtl;
    abortCtl = null;
    old.abort();
  }

  if (task.type === 'custom') {
    pendingCtx = task.vars || {};
    showCtxChip(pendingCtx);
    els.input.focus();
    return;
  }

  const userContent = renderTemplate(task.template, task.vars);
  thread.push({ role: 'system', content: buildSystem(task.vars), ts: Date.now() });
  appendMessage('user', userContent);
  thread.push({ role: 'user', content: userContent, ts: Date.now() });
  updateEmptyState();
  await runCompletion();
}

function buildSystem(vars) {
  const parts = [
    '你是一名学习助手，帮助用户在浏览网页时快速理解内容。用与用户提问相同的语言回答，简洁准确，善用 Markdown 与代码块。'
  ];
  if (vars && (vars.title || vars.url)) {
    parts.push('用户正在阅读的页面：《' + (vars.title || '无标题') + '》 ' + (vars.url || ''));
  }
  if (vars && vars.text) {
    parts.push('用户选中的文字：「' + truncateText(vars.text, 2000) + '」');
  }
  if (vars && vars.pageText) {
    parts.push('当前页面正文内容（节选，可能被截断）：\n' + truncateText(vars.pageText, 8000));
  }
  return parts.join('\n');
}

/* ================= 输入框追问（多轮） ================= */

async function sendFromInput() {
  const text = els.input.value.trim();
  if (!text || abortCtl) return;
  els.input.value = '';
  autoResize();
  updateSendState();

  const image = pendingImage; // 快照本次待发送的截图
  pendingImage = null;
  hideShotPreview();

  if (pendingCtx) {
    thread.push({ role: 'system', content: buildSystem(pendingCtx), ts: Date.now() });
    pendingCtx = null;
    hideCtxChip();
  } else if (!image) {
    // 自由提问：先主动核对当前活动标签页，确保 AI 知道用户此刻在看哪一页
    await ensureFreshPageCtx();
    if (pageCtx && pageCtx.vars) {
      thread.push({ role: 'system', content: buildSystem(pageCtx.vars), ts: Date.now() });
    }
  }
  appendMessage('user', text, image);
  thread.push({ role: 'user', content: text, image: image || undefined, ts: Date.now() });
  pushInputHistory(text); // 记录已发送问题，供 ↑/↓ 回溯
  updateEmptyState();
  await runCompletion();
}

/**
 * 输入框历史回溯（终端式 ↑/↓ 召回已发送的问题）
 * - 每个非空的已发送问题按顺序入栈；
 * - ↑ 调出更早的问题，↓ 逐步回退到最新，最终回到进入浏览前正在写的草稿；
 * - 用户手动改了内容即视为回到草稿态，继续 ↑ 从最新一条开始。
 */
const inputHistory = [];
let historyIndex = 0;        // 指向栈尾（= 当前草稿位置）
let draftWhileBrowsing = ''; // 进入历史浏览前暂存的草稿

function pushInputHistory(text) {
  const t = text.trim();
  if (!t) return;
  if (inputHistory.length && inputHistory[inputHistory.length - 1] === t) return; // 避免连续重复
  inputHistory.push(t);
  historyIndex = inputHistory.length;
}

function recallHistory(dir) {
  // dir: -1 = ↑(更旧)  +1 = ↓(更新)
  if (inputHistory.length === 0) return false;
  if (dir < 0) {
    if (historyIndex === inputHistory.length) draftWhileBrowsing = els.input.value; // 从草稿进入历史
    if (historyIndex > 0) historyIndex--;
  } else {
    if (historyIndex < inputHistory.length) historyIndex++;
  }
  els.input.value = historyIndex >= inputHistory.length ? (draftWhileBrowsing || '') : inputHistory[historyIndex];
  const len = els.input.value.length;
  els.input.setSelectionRange(len, len);
  autoResize();
  updateSendState();
  return true;
}

function historyKeyHandler(e) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // 保留组合键的默认行为
  // 多行且光标不在首行时，保留默认的换行内光标移动，不劫持
  const multiLine = els.input.value.includes('\n');
  if (multiLine && !(els.input.selectionStart === 0 && els.input.selectionEnd === 0)) return;
  e.preventDefault();
  recallHistory(e.key === 'ArrowUp' ? -1 : 1);
}

/**
 * 提问前核对页面上下文：与当前活动标签页 URL 不一致时才重新抓取，
 * 避免 SPA 路由切换、快速切标签页导致的"AI 不知道当前在哪一页"。
 */
async function ensureFreshPageCtx() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id == null) return;
    if (pageCtx && pageCtx.vars && pageCtx.vars.url === tab.url) return; // 已是当前页，免抓
    const res = await chrome.runtime.sendMessage({ type: 'capture-page-ctx-now', tabId: tab.id });
    if (res && res.vars) pageCtx = { vars: res.vars, at: Date.now() };
  } catch {}
}

/* ================= API 调用与流式渲染 ================= */

async function runCompletion() {
  if (abortCtl) return;

  // 每次请求前强制重读配置：即使错过 storage.onChanged，也保证用最新已保存配置
  settings = await getMergedSettings();
  renderModelSelect();

  if (!settings.api.baseURL || !settings.api.model) {
    const el = appendMessage('assistant', '');
    renderError(el, 'API not configured: add baseURL / apiKey / model in Settings.', true);
    return;
  }

  const el = appendMessage('assistant', '');
  const body = el.querySelector('.body');
  el.classList.add('streaming');
  setStatus('Thinking…');

  const myCtl = new AbortController();
  abortCtl = myCtl;
  setBusy(true);

  const assistant = { role: 'assistant', content: '', ts: Date.now() };
  thread.push(assistant);

  // 连接超时 30s：拿到响应头（callOpenAICompatible 返回前即拿到）后清除，不杀长流
  const timeoutCtl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutCtl.abort();
  }, 30000);

  let renderPending = false;
  const scheduleRender = () => {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      renderMarkdown(body, assistant.content);
    });
  };

  // 本次若含图片，自动切换到视觉模型
  const hasImage = thread.some((m) => m.role === 'user' && m.image);
  const visionModel = resolveVisionModel(settings.api);
  const api = hasImage ? { ...settings.api, model: visionModel || settings.api.model } : settings.api;

  // 让顶部模型框与「实际使用的模型」保持一致（问图时显示视觉模型）
  if (hasImage && visionModel) syncModelSelect(visionModel);

  try {
    await callOpenAICompatible({
      api,
      messages: buildApiMessages(),
      signal: AbortSignal.any([myCtl.signal, timeoutCtl.signal]),
      onDelta: (delta) => {
        assistant.content += delta;
        scheduleRender();
        setStatus('Generating… ' + assistant.content.length + ' chars');
      }
    });
    finishMessage(el, assistant, 'done');
  } catch (err) {
    if (err && err.name === 'AbortError' && !timedOut) {
      finishMessage(el, assistant, 'stopped');
    } else if (assistant.content) {
      // 流式中途出错：保留已生成的部分
      finishMessage(el, assistant, 'stopped');
      setStatus(describeAPIError(err, timedOut), 'error', true);
    } else {
      const idx = thread.indexOf(assistant);
      if (idx >= 0) thread.splice(idx, 1);
      renderError(el, describeAPIError(err, timedOut));
    }
  } finally {
    clearTimeout(timer);
    if (abortCtl === myCtl) {
      abortCtl = null;
      setBusy(false);
      if (!els.status.dataset.sticky) setStatusHidden();
    }
    trimThread();
    persistThread();
    // 不在此恢复模型框：问图后保持显示视觉模型，下一次普通问答会在开头恢复主模型
  }
}

/** API 上下文 = 最近一条 system + 最近 20 条 user/assistant；带图消息转多模态 */
function buildApiMessages() {
  const systems = thread.filter((m) => m.role === 'system');
  const rest = thread.filter((m) => m.role !== 'system').slice(-20);
  const sys = systems[systems.length - 1];
  const msgs = sys ? [sys, ...rest] : rest;
  return msgs.map((m) => {
    if (m.role === 'user' && m.image) {
      return {
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          { type: 'image_url', image_url: { url: m.image } }
        ]
      };
    }
    return { role: m.role, content: m.content };
  });
}

function finishMessage(el, assistant, state) {
  el.classList.remove('streaming');
  const body = el.querySelector('.body');

  if (state !== 'done' && !assistant.content) {
    el.remove();
    const idx = thread.indexOf(assistant);
    if (idx >= 0) thread.splice(idx, 1);
    return;
  }

  renderMarkdown(body, assistant.content || '(empty response)');
  highlightIn(el);

  const footer = document.createElement('div');
  footer.className = 'msg-footer';
  footer.appendChild(makeCopyButton(assistant.content || ''));
  if (state === 'stopped') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'Stopped';
    footer.appendChild(tag);
  }
  el.appendChild(footer);
}

function renderError(el, message, withSettingsBtn) {
  el.classList.remove('streaming');
  el.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'err-box';
  const p = document.createElement('p');
  p.textContent = '⚠ ' + message;
  const retry = document.createElement('button');
  retry.textContent = 'Retry';
  retry.addEventListener('click', async () => {
    el.remove();
    await runCompletion();
  });
  box.appendChild(p);
  box.appendChild(retry);
  if (withSettingsBtn) {
    const cfg = document.createElement('button');
    cfg.textContent = 'Open settings';
    cfg.addEventListener('click', () => chrome.runtime.openOptionsPage());
    box.appendChild(cfg);
  }
  el.appendChild(box);
}

/* ================= 渲染 ================= */

function appendMessage(role, content, image) {
  els.empty.hidden = true;
  const wrap = document.createElement('article');
  wrap.className = 'msg ' + role;
  if (role === 'user' && image) {
    const img = document.createElement('img');
    img.className = 'msg-img';
    img.src = image;
    img.alt = 'Screenshot';
    wrap.appendChild(img);
  }
  const body = document.createElement('div');
  body.className = 'body' + (role === 'assistant' ? ' md' : '');
  if (role === 'user') body.textContent = content; // 纯文本，防注入
  wrap.appendChild(body);
  els.thread.appendChild(wrap);
  scrollToBottom(true);
  if (role === 'user') renderNavDots();
  return wrap;
}

function renderThread() {
  els.thread.querySelectorAll('.msg').forEach((n) => n.remove());
  for (const m of thread) {
    if (m.role === 'user') {
      appendMessage('user', m.content, m.image);
    } else if (m.role === 'assistant') {
      const el = appendMessage('assistant', '');
      renderMarkdown(el.querySelector('.body'), m.content || '(empty response)');
      highlightIn(el);
      const footer = document.createElement('div');
      footer.className = 'msg-footer';
      footer.appendChild(makeCopyButton(m.content || ''));
      el.appendChild(footer);
    }
  }
  updateEmptyState();
  scrollToBottom(true);
  renderNavDots();
}

/* ================= 历史导航（回到顶部/底部 + 提问定位点） ================= */

function renderNavDots() {
  const hasContent = els.thread.querySelectorAll('.msg').length > 0;
  if (!hasContent) {
    els.navDots.hidden = true;
    hideNavTip();
    return;
  }
  els.navDots.hidden = false; // 有对话就显示（↑/↓ 始终可用）

  const userEls = els.thread.querySelectorAll('.msg.user');
  userEls.forEach((el, i) => {
    el.dataset.userIdx = i;
  });

  els.navList.innerHTML = '';
  hideNavTip();
  if (userEls.length < 2) return; // 只有 1 次提问时无需定位点

  userEls.forEach((el, i) => {
    const body = el.querySelector('.body');
    const text = body ? body.textContent.trim() : '';
    const dot = document.createElement('button');
    dot.className = 'nav-dot';
    dot.dataset.tip = truncateText(text, 100) || 'Question ' + (i + 1);
    dot.addEventListener('click', () => scrollToMessage(i));
    dot.addEventListener('mouseenter', () => showNavTip(dot));
    dot.addEventListener('mouseleave', hideNavTip);
    els.navList.appendChild(dot);
  });
}

/** 悬停显示该次提问的文字浮层（自定义，比原生 tooltip 精致） */
let navTipEl = null;
function showNavTip(dot) {
  hideNavTip();
  const text = dot.dataset.tip || '';
  if (!text) return;
  const tip = document.createElement('div');
  tip.className = 'nav-tip';
  tip.textContent = text;
  document.body.appendChild(tip);
  const r = dot.getBoundingClientRect();
  tip.style.left = r.right + 8 + 'px';
  tip.style.top = r.top + r.height / 2 + 'px';
  navTipEl = tip;
}

function hideNavTip() {
  if (navTipEl) {
    navTipEl.remove();
    navTipEl = null;
  }
}

function scrollToMessage(idx) {
  const el = els.thread.querySelector('.msg.user[data-user-idx="' + idx + '"]');
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function scrollToTop() {
  els.thread.scrollTo({ top: 0, behavior: 'smooth' });
}

function scrollToBottomOfThread() {
  els.thread.scrollTo({ top: els.thread.scrollHeight, behavior: 'smooth' });
}

function renderMarkdown(el, text) {
  const html = DOMPurify.sanitize(marked.parse(text || ''));
  el.innerHTML = html;
  el.querySelectorAll('a[href]').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  maybeScroll();
}

function highlightIn(el) {
  el.querySelectorAll('pre code').forEach((block) => {
    try {
      hljs.highlightElement(block);
    } catch {}
  });
  el.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.code-copy')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code');
      try {
        await navigator.clipboard.writeText(code ? code.innerText : pre.innerText);
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1500);
      } catch {}
    });
    pre.appendChild(btn);
  });
}

function makeCopyButton(text) {
  const btn = document.createElement('button');
  btn.textContent = 'Copy';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied ✓';
      setTimeout(() => (btn.textContent = 'Copy'), 1500);
    } catch {}
  });
  return btn;
}

/* ================= 历史（仅浏览器会话内） ================= */

async function persistThread() {
  if (!settings.ui.keepHistory) return;
  await chrome.storage.session.set({ [THREAD_KEY]: thread });
}

async function loadThread() {
  if (!settings.ui.keepHistory) return;
  const data = await chrome.storage.session.get(THREAD_KEY);
  const saved = data[THREAD_KEY];
  if (Array.isArray(saved)) {
    thread = saved.filter(
      (m) => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role)
    );
  }
}

/** 读取最近捕获的页面上下文（自由提问兜底） */
async function loadPageCtx() {
  const data = await chrome.storage.session.get(CTX_KEY);
  const c = data[CTX_KEY];
  if (c && c.vars) pageCtx = c;
}

/* ================= 图片显示模式（单按钮循环切换） ================= */

const IMG_ORDER = ['normal', 'thumb', 'hidden'];
const IMG_LABELS = { normal: 'Normal', thumb: 'Thumbnail', hidden: 'Hidden' };
const LANDSCAPE =
  '<circle cx="17" cy="5" r="2.5" fill="#F5A623"/><path d="M3 18 L8.5 10 L13 15.5 L17 11.5 L21 18 Z" fill="#6BA7E8"/><path d="M3 20.5 C6 19.5 9 21 12 20 C15 21 18 19.5 21 20.5" stroke="#7BB8E8" stroke-width="1.2" fill="none"/>';
const IMG_ICONS = {
  normal: '<svg viewBox="0 0 24 24">' + LANDSCAPE + '</svg>',
  thumb: '<svg viewBox="0 0 24 24" class="shrink">' + LANDSCAPE + '</svg>',
  hidden:
    '<svg viewBox="0 0 24 24" class="gray">' +
    LANDSCAPE +
    '</svg><svg viewBox="0 0 24 24" class="ban" fill="none"><circle cx="12" cy="12" r="10" stroke="#E24B4A" stroke-width="2.2"/><line x1="5.5" y1="18.5" x2="18.5" y2="5.5" stroke="#E24B4A" stroke-width="2.2" stroke-linecap="round"/></svg>'
};

async function loadImgMode() {
  try {
    const res = await chrome.storage.local.get(IMG_KEY);
    imgMode = (res[IMG_KEY] && res[IMG_KEY].mode) || 'normal';
  } catch {
    imgMode = 'normal';
  }
  renderImgSwitch();
}

function renderImgSwitch() {
  const btn = els.imgBtn;
  btn.innerHTML = IMG_ICONS[imgMode] || IMG_ICONS.normal;
  btn.title = 'Images: ' + (IMG_LABELS[imgMode] || imgMode) + ' (click to switch)';
}

async function setImgMode(mode) {
  imgMode = mode;
  try {
    await chrome.storage.local.set({ [IMG_KEY]: { mode } });
  } catch {}
  renderImgSwitch();
}

/** 点击循环切换：正常 → 缩略 → 隐藏 → 正常 */
function cycleImgMode() {
  const idx = IMG_ORDER.indexOf(imgMode);
  const next = IMG_ORDER[(idx + 1) % IMG_ORDER.length];
  setImgMode(next);
}

/* ================= 免广告开关 ================= */

async function loadAdBlock() {
  try {
    const res = await chrome.storage.local.get(AD_KEY);
    adEnabled = !res[AD_KEY] || res[AD_KEY].enabled !== false;
  } catch {
    adEnabled = true;
  }
  renderAdBtn();
}

function renderAdBtn() {
  els.adBtn.classList.toggle('on', adEnabled);
  els.adBtn.title = adEnabled ? 'Ad block on (click to disable)' : 'Ad block off (click to enable)';
}

async function toggleAdBlock() {
  adEnabled = !adEnabled;
  try {
    await chrome.storage.local.set({ [AD_KEY]: { enabled: adEnabled } });
  } catch {}
  renderAdBtn();
}

/** maxHistory 按问答对数截断：保留最近一条 system + 最近 N*2 条消息 */
function trimThread() {
  const max = Math.max(1, parseInt(settings.ui.maxHistory, 10) || 50) * 2;
  const systems = thread.filter((m) => m.role === 'system');
  const rest = thread.filter((m) => m.role !== 'system');
  const sys = systems[systems.length - 1];
  thread = sys ? [sys, ...rest.slice(-max)] : rest.slice(-max);
}

/* ================= UI 杂项 ================= */

function bindUI() {
  els.input.addEventListener('input', () => {
    autoResize();
    updateSendState();
    // 手动编辑即回到草稿态：后续 ↑ 从最新一条历史开始
    if (historyIndex !== inputHistory.length || draftWhileBrowsing) {
      historyIndex = inputHistory.length;
      draftWhileBrowsing = '';
    }
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendFromInput();
      return;
    }
    historyKeyHandler(e); // ↑/↓ 回溯已发送的问题
  });
  els.send.addEventListener('click', sendFromInput);
  els.stop.addEventListener('click', () => abortCtl && abortCtl.abort());
  els.newBtn.addEventListener('click', () => {
    if (abortCtl) {
      const c = abortCtl;
      abortCtl = null;
      c.abort();
    }
    thread = [];
    pendingCtx = null;
    pendingImage = null;
    hideCtxChip();
    hideShotPreview();
    setStatusHidden();
    renderThread();
    persistThread();
  });
  els.settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.goSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.ctxChipClose.addEventListener('click', () => {
    pendingCtx = null;
    hideCtxChip();
  });
  els.thread.addEventListener('scroll', () => {
    autoScroll = nearBottom();
  });
  els.imgBtn.addEventListener('click', cycleImgMode);
  els.adBtn.addEventListener('click', toggleAdBlock);
  els.modelSelect.addEventListener('change', onModelChange);
  els.navTop.addEventListener('click', scrollToTop);
  els.navBottom.addEventListener('click', scrollToBottomOfThread);
  els.shotBtn.addEventListener('click', startScreenshot);
  els.shotCancel.addEventListener('click', () => {
    pendingImage = null;
    hideShotPreview();
  });
}

/* ================= 截图问图 ================= */

async function startScreenshot() {
  setStatus('Drag on the page to select an area…');
  try {
    chrome.runtime.sendMessage({ type: 'start-screenshot' });
  } catch {
    setStatusHidden();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'screenshot-result') {
    setStatusHidden();
    if (msg.dataUrl) {
      pendingImage = msg.dataUrl;
      showShotPreview(msg.dataUrl);
    } else if (msg.error) {
      setStatus('Screenshot failed: ' + msg.error, 'error', true);
    }
  }
});

function showShotPreview(dataUrl) {
  els.shotImg.src = dataUrl;
  renderShotPrompts();
  els.shotPreview.hidden = false;
  els.input.focus();
}

function hideShotPreview() {
  els.shotPreview.hidden = true;
  els.shotImg.src = '';
  els.shotPrompts.innerHTML = '';
}

function renderShotPrompts() {
  els.shotPrompts.innerHTML = '';
  SHOT_PROMPTS.forEach((q) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shot-prompt';
    btn.textContent = q;
    btn.addEventListener('click', () => {
      els.input.value = q;
      autoResize();
      updateSendState();
      els.input.focus();
    });
    els.shotPrompts.appendChild(btn);
  });
}

function bindStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = mergeSettings(changes.settings.newValue);
      renderModelSelect();
      trimThread();
      persistThread();
    }
    if (area === 'session' && changes[TASK_KEY] && changes[TASK_KEY].newValue) {
      const task = changes[TASK_KEY].newValue;
      if (task.taskId !== processedTaskId) handleTask(task);
    }
    if (area === 'session' && changes[CTX_KEY] && changes[CTX_KEY].newValue) {
      pageCtx = changes[CTX_KEY].newValue;
    }
    if (area === 'local' && changes[IMG_KEY]) {
      imgMode = (changes[IMG_KEY].newValue && changes[IMG_KEY].newValue.mode) || 'normal';
      renderImgSwitch();
    }
    if (area === 'local' && changes[AD_KEY]) {
      adEnabled = !changes[AD_KEY].newValue || changes[AD_KEY].newValue.enabled !== false;
      renderAdBtn();
    }
  });
}

/** 从 storage.local 重读最新配置并刷新模型徽标（兜底同步） */
async function refreshSettings() {
  settings = await getMergedSettings();
  renderModelSelect();
  // 注意：图片显示模式(imgMode)是侧边栏内的「即时状态」，不在这里从 storage 二次重读。
  // 否则 focus / visibilitychange 触发的 refreshSettings 会和「点击切换」的 storage 写入产生竞态：
  // 重读的 get 回调往往比点击的 set 更晚执行，会用旧值把第一次切换结果覆盖回去，
  // 表现为「切回插件后第一下点击没反应，第二下才切」。adBlock 同理不在本函数重读。
}

/** 渲染模型选择器：内置清单 + 用户配置的模型去重；问图自动切视觉模型 */
function renderModelSelect() {
  const sel = els.modelSelect;
  if (!settings.api.baseURL) {
    sel.innerHTML = '';
    const opt = document.createElement('option');
    opt.textContent = 'API not configured';
    sel.appendChild(opt);
    sel.disabled = true;
    els.goSettings.hidden = false;
    return;
  }
  els.goSettings.hidden = true;

  const candidates = [];
  MODEL_CATALOG.forEach((m) => candidates.push({ id: m.id, cap: m.cap }));
  if (settings.api.model) candidates.push({ id: settings.api.model, cap: 'text' });
  if (settings.api.visionModel) candidates.push({ id: settings.api.visionModel, cap: 'vision' });

  const seen = new Set();
  const list = candidates.filter((m) => {
    if (!m.id || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  sel.innerHTML = '';
  list.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.id; // 官方原名，不做修饰
    sel.appendChild(opt);
  });
  if (settings.api.model && seen.has(settings.api.model)) sel.value = settings.api.model;
  else if (list.length) sel.value = list[0].id;
  sel.disabled = false;
}

/** 把模型框的显示值临时设为指定模型（若在选项中），用于问图时显示视觉模型 */
function syncModelSelect(modelId) {
  if (!modelId) return;
  const sel = els.modelSelect;
  if ([...sel.options].some((o) => o.value === modelId)) {
    sel.value = modelId;
  }
}

/** 解析视觉模型：优先用户手动配置；DeepSeek 视觉已并入 Flash，直接返回 deepseek-flash */
function resolveVisionModel(api) {
  if (api.visionModel) return api.visionModel;
  const hay = ((api.baseURL || '') + ' ' + (api.model || '')).toLowerCase();
  if (hay.includes('deepseek')) return 'deepseek-flash';
  return '';
}

/** 手动切换主模型（持久化到 settings.api.model） */
async function onModelChange() {
  const model = els.modelSelect.value;
  if (!model || !settings.api.baseURL) return;
  settings.api.model = model;
  await saveSettings(settings);
  setStatus('Model switched: ' + model);
  setTimeout(() => {
    if (!els.status.dataset.sticky) setStatusHidden();
  }, 1500);
}

function updateEmptyState() {
  els.empty.hidden = thread.some((m) => m.role !== 'system');
}

function updateSendState() {
  els.send.disabled = !els.input.value.trim() || !!abortCtl;
}

function setBusy(busy) {
  els.stop.hidden = !busy;
  els.send.hidden = busy;
  if (busy) els.send.disabled = true;
  else updateSendState();
}

function setStatus(text, cls, sticky) {
  els.status.textContent = text;
  els.status.className = 'status-bar' + (cls === 'error' ? ' error' : '');
  els.status.hidden = false;
  if (sticky) els.status.dataset.sticky = '1';
  else delete els.status.dataset.sticky;
}

function setStatusHidden() {
  els.status.hidden = true;
  els.status.textContent = '';
  delete els.status.dataset.sticky;
}

function showCtxChip(vars) {
  els.ctxChipText.textContent = 'Quoting selection: ' + truncateText(vars.text || '', 60);
  els.ctxChip.hidden = false;
}

function hideCtxChip() {
  els.ctxChip.hidden = true;
}

function autoResize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 132) + 'px';
}

function nearBottom() {
  return els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight < 80;
}

function maybeScroll() {
  if (autoScroll) els.thread.scrollTop = els.thread.scrollHeight;
}

function scrollToBottom(force) {
  if (force || autoScroll) {
    autoScroll = true;
    els.thread.scrollTop = els.thread.scrollHeight;
  }
}
