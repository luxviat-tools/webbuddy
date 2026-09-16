'use strict';

/*
 * 学习助手 · 设置页
 * API 配置（保存 + 按需域名授权 + 测试连接）、预设问题 CRUD/拖拽排序/导入导出、界面选项。
 * 预设与界面改动自动保存（防抖）；API 保存是显式动作（涉及权限申请）。
 */

const $ = (id) => document.getElementById(id);

let settings = null;
let savedAPI = null; // 已保存的 API 配置（自动保存预设/界面时用它，避免把表单草稿一起写盘）
let prompts = [];
let saveTimer = null;
let draggingId = null;

init().catch((err) => console.error('[webbuddy] settings init failed:', err));

async function init() {
  settings = await getMergedSettings();
  savedAPI = { ...settings.api };
  prompts = settings.prompts.map((p) => ({ ...p }));
  fillAPI();
  fillUI();
  await loadAdBlock();
  renderPromptList();
  bindEvents();

  // 让「配置到底在不在」一眼可见，避免误以为丢失而重复填写
  if (wasSettingsRestored()) {
    setMsg('api-msg', 'Config was missing — restored from backup ✓ (no need to re-enter)', 'ok');
  } else if (settings.api.apiKey) {
    setMsg('api-msg', 'Config loaded · key ' + maskKey(settings.api.apiKey), 'ok');
  }
}

/** 只显示首尾，中间打码：确认保存的是哪个 key，又不泄露 */
function maskKey(key) {
  const s = String(key || '');
  if (!s) return '(empty)';
  if (s.length <= 8) return s.slice(0, 2) + '••••';
  return s.slice(0, 3) + '••••' + s.slice(-4);
}

/* ================= API 配置 ================= */

function fillAPI() {
  $('api-baseurl').value = settings.api.baseURL || '';
  $('api-key').value = settings.api.apiKey || '';
  $('api-model').value = settings.api.model || '';
  $('api-vision').value = settings.api.visionModel || '';
  $('api-temp-range').value = settings.api.temperature;
  $('temp-val').textContent = (+settings.api.temperature).toFixed(1);
  $('api-stream').checked = settings.api.stream !== false;
}

function currentAPI() {
  const t = parseFloat($('api-temp-range').value);
  return {
    baseURL: $('api-baseurl').value.trim(),
    apiKey: $('api-key').value.trim(),
    model: $('api-model').value.trim(),
    visionModel: $('api-vision').value.trim(),
    temperature: Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : 0.3,
    stream: $('api-stream').checked
  };
}

/** 按需申请 baseURL 域名的 host 权限（最小化：只授当前 origin） */
async function ensureHostPermission(baseURL) {
  let origin;
  try {
    const u = new URL(baseURL);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
    origin = u.origin + '/*';
  } catch {
    return { ok: false, error: 'baseURL is not a valid http(s) address' };
  }
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return { ok: true, origin, already: true };
  const granted = await chrome.permissions.request({ origins: [origin] });
  return { ok: granted, origin };
}

async function saveAPI() {
  const api = currentAPI();
  if (!api.baseURL) return setMsg('api-msg', 'Please fill in baseURL', 'err');
  if (!api.model) return setMsg('api-msg', 'Please fill in model (e.g. deepseek-flash)', 'err');

  const perm = await ensureHostPermission(api.baseURL);
  // 无论权限是否授予，先更新 savedAPI 再落盘——否则预设自动保存会把旧值带回盘
  savedAPI = { ...api };
  if (!perm.ok) {
    if (perm.error) return setMsg('api-msg', perm.error, 'err');
    // 权限被拒：仍保存配置，但明确警告
    await saveSettings(fullSettings(api));
    return setMsg('api-msg', 'Saved, but the origin grant was declined — requests may fail. Click “Save & grant origin” again to re-prompt.', 'err');
  }
  await saveSettings(fullSettings(api));
  setMsg(
    'api-msg',
    'Saved ✓ · key ' + maskKey(api.apiKey) +
      (perm.already ? ' (origin permission already granted)' : ' · granted ' + perm.origin),
    'ok'
  );
}

async function testAPI() {
  const api = currentAPI();
  if (!api.baseURL || !api.model) return setMsg('api-msg', 'Fill in baseURL and model first', 'err');
  const perm = await ensureHostPermission(api.baseURL);
  if (!perm.ok) return setMsg('api-msg', perm.error || 'Origin access not granted — cannot test', 'err');

  const url = normalizeChatURL(api.baseURL);
  setMsg('api-msg', 'Testing… → ' + url, '');
  let out = '';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    await callOpenAICompatible({
      api,
      messages: [{ role: 'user', content: 'Hi' }],
      signal: ctl.signal,
      extraBody: { max_tokens: 8 },
      onDelta: (d) => (out += d)
    });
    clearTimeout(timer);
    setMsg('api-msg', 'Connected ✓ ' + url + ' · reply: ' + (out.slice(0, 30) || '(empty)'), 'ok');
  } catch (err) {
    clearTimeout(timer);
    setMsg('api-msg', describeAPIError(err, err && err.name === 'AbortError'), 'err');
  }
}

/* ================= 预设问题 ================= */

function renderPromptList() {
  const list = $('prompt-list');
  list.innerHTML = '';
  prompts
    .slice()
    .sort((a, b) => a.order - b.order)
    .forEach((p, idx) => {
      p.order = idx + 1;
      const row = document.createElement('div');
      row.className = 'prompt-row';
      row.draggable = true;
      row.dataset.id = p.id;

      const drag = document.createElement('span');
      drag.className = 'drag';
      drag.title = 'Drag to reorder';
      drag.textContent = '⠿';

      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = p.enabled !== false;
      enabled.title = 'Enable / disable';

      const main = document.createElement('div');
      main.className = 'p-main';
      const label = document.createElement('input');
      label.className = 'p-label';
      label.value = p.label;
      label.placeholder = 'Question name (shown in the right-click menu)';
      const template = document.createElement('textarea');
      template.className = 'p-template';
      template.rows = 2;
      template.value = p.template;
      template.placeholder = 'Template; {{text}} {{title}} {{url}} {{lang}} available';
      main.append(label, template);

      const del = document.createElement('button');
      del.className = 'p-del';
      del.type = 'button';
      del.textContent = 'Delete';

      row.append(drag, enabled, main, del);
      list.appendChild(row);

      enabled.addEventListener('change', () => {
        p.enabled = enabled.checked;
        scheduleSavePrompts();
      });
      label.addEventListener('input', () => {
        p.label = label.value;
        scheduleSavePrompts();
      });
      template.addEventListener('input', () => {
        p.template = template.value;
        scheduleSavePrompts();
      });
      del.addEventListener('click', () => {
        if (!confirm('Delete preset “' + (p.label || 'Untitled') + '”?')) return;
        prompts = prompts.filter((x) => x.id !== p.id);
        renderPromptList();
        savePromptsNow();
      });

      /* 拖拽排序：dragover 只移动 DOM 节点，drop/dragend 时提交顺序，避免重渲打断拖拽 */
      row.addEventListener('dragstart', (e) => {
        draggingId = p.id;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', p.id);
        } catch {}
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        draggingId = null;
        commitOrder();
      });
      row.addEventListener('dragover', (e) => {
        if (!draggingId || draggingId === p.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = row.getBoundingClientRect();
        const dragged = list.querySelector('[data-id="' + draggingId + '"]');
        if (!dragged) return;
        if (e.clientY < rect.top + rect.height / 2) list.insertBefore(dragged, row);
        else list.insertBefore(dragged, row.nextSibling);
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        commitOrder();
      });
    });
}

function commitOrder() {
  const list = $('prompt-list');
  const ids = [...list.querySelectorAll('.prompt-row')].map((el) => el.dataset.id);
  prompts.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  prompts.forEach((p, i) => (p.order = i + 1));
  savePromptsNow();
}

function addPrompt() {
  prompts.push({
    id: crypto.randomUUID(),
    label: 'New question',
    template: '关于「{{text}}」：',
    order: prompts.length + 1,
    enabled: true
  });
  renderPromptList();
  savePromptsNow();
  const rows = $('prompt-list').querySelectorAll('.prompt-row');
  const last = rows[rows.length - 1];
  if (last) last.querySelector('.p-label').select();
}

function exportPrompts() {
  const data = prompts.map((p) => ({
    label: p.label,
    template: p.template,
    order: p.order,
    enabled: p.enabled !== false
  }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'learning-assistant-prompts.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importPrompts(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return setMsg('prompt-msg', 'JSON parse failed', 'err');
  }
  if (
    !Array.isArray(data) ||
    !data.length ||
    !data.every((x) => x && typeof x.label === 'string' && typeof x.template === 'string')
  ) {
    return setMsg('prompt-msg', 'Wrong format: expected an array [{ "label": …, "template": … }]', 'err');
  }
  if (!confirm('Import ' + data.length + ' presets, replacing the current ' + prompts.length + '. Continue?')) return;
  prompts = data.map((x, i) => ({
    id: crypto.randomUUID(),
    label: x.label.trim() || 'Question ' + (i + 1),
    template: x.template,
    order: Number.isFinite(x.order) ? x.order : i + 1,
    enabled: x.enabled !== false
  }));
  prompts.sort((a, b) => a.order - b.order);
  prompts.forEach((p, i) => (p.order = i + 1));
  renderPromptList();
  savePromptsNow();
}

function scheduleSavePrompts() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePromptsNow, 600);
}

async function savePromptsNow() {
  clearTimeout(saveTimer);
  // 不传参：API 一律用已保存的 savedAPI，绝不把表单草稿带进盘
  await saveSettings(fullSettings());
  setMsg('prompt-msg', 'Saved ✓', 'ok');
}

/* ================= 界面与会话 ================= */

function fillUI() {
  $('ui-scope').value = settings.ui.sidebarScope || 'global';
  $('ui-keep').checked = !!settings.ui.keepHistory;
  $('ui-max').value = settings.ui.maxHistory || 50;
  $('ui-bubble').checked = settings.ui.selectionBubble !== false;
}

function currentUI() {
  return {
    sidebarScope: 'global', // v1 固定全局共享
    keepHistory: $('ui-keep').checked,
    maxHistory: Math.min(500, Math.max(1, parseInt($('ui-max').value, 10) || 50)),
    selectionBubble: $('ui-bubble').checked
  };
}

async function saveUINow() {
  await saveSettings(fullSettings());
  setMsg('ui-msg', 'Saved ✓', 'ok');
}

/* ================= 免广告（独立配置） ================= */

async function loadAdBlock() {
  try {
    const res = await chrome.storage.local.get(AD_KEY);
    const enabled = !res[AD_KEY] || res[AD_KEY].enabled !== false;
    $('ad-block').checked = enabled;
  } catch {
    $('ad-block').checked = true;
  }
}

async function saveAdBlock() {
  const enabled = $('ad-block').checked;
  await chrome.storage.local.set({ [AD_KEY]: { enabled } });
  setMsg('ui-msg', enabled ? 'Ad block on ✓' : 'Ad block off', 'ok');
}

/* ================= 杂项 ================= */

/** 当前生效的完整 settings：API 用已保存值，预设/界面用编辑态 */
function fullSettings(api) {
  return { api: api || savedAPI, prompts, ui: currentUI() };
}

function setMsg(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = 'msg' + (cls ? ' ' + cls : '');
}

function bindEvents() {
  document.querySelectorAll('.quick button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('api-baseurl').value = btn.dataset.base;
      if (btn.dataset.model) $('api-model').value = btn.dataset.model;
      setMsg('api-msg', 'Filled in — remember to hit “Save & grant origin”', '');
    });
  });

  $('toggle-key').addEventListener('click', () => {
    const inp = $('api-key');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('toggle-key').textContent = show ? 'Hide' : 'Show';
  });

  $('api-temp-range').addEventListener('input', () => {
    $('temp-val').textContent = (+$('api-temp-range').value).toFixed(1);
  });

  $('api-save').addEventListener('click', saveAPI);
  $('api-test').addEventListener('click', testAPI);

  $('prompt-add').addEventListener('click', addPrompt);
  $('prompt-export').addEventListener('click', exportPrompts);
  $('prompt-import').addEventListener('click', () => $('prompt-file').click());
  $('prompt-file').addEventListener('change', importPrompts);

  $('ui-keep').addEventListener('change', saveUINow);
  $('ui-max').addEventListener('change', saveUINow);
  $('ui-bubble').addEventListener('change', saveUINow);
  $('ad-block').addEventListener('change', saveAdBlock);
}
