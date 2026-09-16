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

init().catch((err) => console.error('[学习助手] 设置页初始化失败:', err));

async function init() {
  settings = await getMergedSettings();
  savedAPI = { ...settings.api };
  prompts = settings.prompts.map((p) => ({ ...p }));
  fillAPI();
  fillUI();
  await loadAdBlock();
  renderPromptList();
  bindEvents();
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
    return { ok: false, error: 'baseURL 不是合法的 http(s) 地址' };
  }
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return { ok: true, origin, already: true };
  const granted = await chrome.permissions.request({ origins: [origin] });
  return { ok: granted, origin };
}

async function saveAPI() {
  const api = currentAPI();
  if (!api.baseURL) return setMsg('api-msg', '请填写 baseURL', 'err');
  if (!api.model) return setMsg('api-msg', '请填写 model（如 deepseek-flash）', 'err');

  const perm = await ensureHostPermission(api.baseURL);
  // 无论权限是否授予，先更新 savedAPI 再落盘——否则预设自动保存会把旧值带回盘
  savedAPI = { ...api };
  if (!perm.ok) {
    if (perm.error) return setMsg('api-msg', perm.error, 'err');
    // 权限被拒：仍保存配置，但明确警告
    await saveSettings(fullSettings(api));
    return setMsg('api-msg', '已保存，但域名授权被拒绝——请求可能失败。重新点一次「保存并授权域名」即可再次弹窗。', 'err');
  }
  await saveSettings(fullSettings(api));
  setMsg('api-msg', perm.already ? '已保存 ✓（域名权限此前已授予）' : '已保存 ✓ 并已授权 ' + perm.origin, 'ok');
}

async function testAPI() {
  const api = currentAPI();
  if (!api.baseURL || !api.model) return setMsg('api-msg', '先填写 baseURL 和 model', 'err');
  const perm = await ensureHostPermission(api.baseURL);
  if (!perm.ok) return setMsg('api-msg', perm.error || '未授予域名访问权限，无法测试', 'err');

  const url = normalizeChatURL(api.baseURL);
  setMsg('api-msg', '测试中… → ' + url, '');
  let out = '';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    await callOpenAICompatible({
      api,
      messages: [{ role: 'user', content: '你好' }],
      signal: ctl.signal,
      extraBody: { max_tokens: 8 },
      onDelta: (d) => (out += d)
    });
    clearTimeout(timer);
    setMsg('api-msg', '连接成功 ✓ ' + url + ' · 回复：' + (out.slice(0, 30) || '(空)'), 'ok');
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
      drag.title = '拖拽排序';
      drag.textContent = '⠿';

      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = p.enabled !== false;
      enabled.title = '启用 / 禁用';

      const main = document.createElement('div');
      main.className = 'p-main';
      const label = document.createElement('input');
      label.className = 'p-label';
      label.value = p.label;
      label.placeholder = '问题名称（右键菜单显示）';
      const template = document.createElement('textarea');
      template.className = 'p-template';
      template.rows = 2;
      template.value = p.template;
      template.placeholder = '模板，可用 {{text}} {{title}} {{url}} {{lang}}';
      main.append(label, template);

      const del = document.createElement('button');
      del.className = 'p-del';
      del.type = 'button';
      del.textContent = '删除';

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
        if (!confirm('删除预设「' + (p.label || '未命名') + '」？')) return;
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
    label: '新问题',
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
    return setMsg('prompt-msg', 'JSON 解析失败', 'err');
  }
  if (
    !Array.isArray(data) ||
    !data.length ||
    !data.every((x) => x && typeof x.label === 'string' && typeof x.template === 'string')
  ) {
    return setMsg('prompt-msg', '格式不符：需要 [{ "label": …, "template": … }] 数组', 'err');
  }
  if (!confirm('导入 ' + data.length + ' 条预设，将替换当前 ' + prompts.length + ' 条，继续？')) return;
  prompts = data.map((x, i) => ({
    id: crypto.randomUUID(),
    label: x.label.trim() || '问题' + (i + 1),
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
  setMsg('prompt-msg', '已保存 ✓', 'ok');
}

/* ================= 界面与会话 ================= */

function fillUI() {
  $('ui-scope').value = settings.ui.sidebarScope || 'global';
  $('ui-keep').checked = !!settings.ui.keepHistory;
  $('ui-max').value = settings.ui.maxHistory || 50;
}

function currentUI() {
  return {
    sidebarScope: 'global', // v1 固定全局共享
    keepHistory: $('ui-keep').checked,
    maxHistory: Math.min(500, Math.max(1, parseInt($('ui-max').value, 10) || 50))
  };
}

async function saveUINow() {
  await saveSettings(fullSettings());
  setMsg('ui-msg', '已保存 ✓', 'ok');
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
  setMsg('ui-msg', enabled ? '免广告已开启 ✓' : '免广告已关闭', 'ok');
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
      setMsg('api-msg', '已填充，记得「保存并授权域名」', '');
    });
  });

  $('toggle-key').addEventListener('click', () => {
    const inp = $('api-key');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('toggle-key').textContent = show ? '隐藏' : '显示';
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
  $('ad-block').addEventListener('change', saveAdBlock);
}
