'use strict';

/*
 * webbuddy · Service Worker
 * 职责：右键菜单 → 组装任务 → 写 storage.session → 打开侧边栏。
 * 侧边栏通过 storage.onChanged / 主动读取消费任务，规避 SW 休眠丢消息。
 */

importScripts('common.js', 'tabdock-store.js');

const PARENT_ID = 'ask-ai-parent';
const CUSTOM_ID = 'ask-ai-custom';
const PAGE_ID = 'ask-ai-page';
const TABDOCK_PARENT = 'tabdock-parent';

// storage.session 默认仅 SW 可读；必须放开，否则侧边栏静默读不到任务
chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch(() => {});

// 关闭「点图标自动开面板」默认行为（顶层设置，每次 SW 启动都生效；
// 手动刷新扩展未必触发 onInstalled，放这里避免旧行为残留），改由 action.onClicked 处理。
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

// 旧模型名迁移：把配置里已退役的别名改写为官方现名（幂等）
async function migrateModelNames() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings || !settings.api) return;
  const oldModel = settings.api.model;
  const oldVision = settings.api.visionModel;
  const newModel = normalizeModel(oldModel);
  const newVision = normalizeModel(oldVision);
  if (newModel !== oldModel || newVision !== oldVision) {
    settings.api.model = newModel;
    settings.api.visionModel = newVision;
    await chrome.storage.local.set({ settings });
  }
}
migrateModelNames().catch(() => {});

async function seedDefaults() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await saveSettings(DEFAULT_SETTINGS);
}

/*
 * 菜单重建串行化：onInstalled / onStartup / settings 变更可能几乎同时触发，
 * 并发执行会导致 removeAll 后两轮 create 互相撞 id（duplicate id 报错）。
 * 做法：全部排进同一条 Promise 链；过期请求（已有更新的 seq）直接跳过。
 */
let rebuildChain = Promise.resolve();
let rebuildSeq = 0;

function rebuildMenus() {
  const seq = ++rebuildSeq;
  rebuildChain = rebuildChain
    .then(async () => {
      if (seq !== rebuildSeq) return; // 已有更新的重建请求排队，本次跳过
      await chrome.contextMenus.removeAll();
      // create 回调里消费 lastError：即使极端情况撞 id 也不会抛 Unchecked runtime.lastError
      chrome.contextMenus.create(
        { id: PARENT_ID, title: 'Ask AI', contexts: ['page', 'selection'] },
        () => void chrome.runtime.lastError
      );
      // 解读当前页面：无论是否选中文字都显示（页面级总览）
      chrome.contextMenus.create(
        {
          id: PAGE_ID,
          parentId: PARENT_ID,
          title: '📄 Explain this page',
          contexts: ['page', 'selection']
        },
        () => void chrome.runtime.lastError
      );
      const { prompts } = await getMergedSettings();
      prompts
        .filter((p) => p.enabled && p.label && p.template)
        .sort((a, b) => a.order - b.order)
        .forEach((p) => {
          chrome.contextMenus.create(
            {
              id: 'prompt:' + p.id,
              parentId: PARENT_ID,
              title: p.label,
              contexts: ['selection']
            },
            () => void chrome.runtime.lastError
          );
        });
      chrome.contextMenus.create(
        {
          id: CUSTOM_ID,
          parentId: PARENT_ID,
          title: '✏️ Custom question…',
          contexts: ['selection']
        },
        () => void chrome.runtime.lastError
      );
      // Tab Dock：收纳标签页（完全本地，等价于独立插件）
      chrome.contextMenus.create(
        { id: TABDOCK_PARENT, title: '🗂 Tab Dock', contexts: ['page'] },
        () => void chrome.runtime.lastError
      );
      chrome.contextMenus.create(
        { id: 'tabdock:current', parentId: TABDOCK_PARENT, title: 'Dock this tab', contexts: ['page'] },
        () => void chrome.runtime.lastError
      );
      chrome.contextMenus.create(
        { id: 'tabdock:all', parentId: TABDOCK_PARENT, title: 'Dock all tabs (every window)', contexts: ['page'] },
        () => void chrome.runtime.lastError
      );
      chrome.contextMenus.create(
        { id: 'tabdock:open', parentId: TABDOCK_PARENT, title: 'Open Tab Dock manager', contexts: ['page'] },
        () => void chrome.runtime.lastError
      );
    })
    .catch((e) => console.error('[webbuddy] failed to rebuild context menus:', e));
  return rebuildChain;
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  } catch {}
  await seedDefaults();
  try {
    // 关闭「点图标自动开面板」默认行为，改由 action.onClicked 手动处理：
    // 这样能在同一手势内先捕获页面上下文，再打开面板。
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch {}
  await rebuildMenus();
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  } catch {}
  await rebuildMenus();
});

// 仅预设问题变化才重建菜单（模型/apiKey 等变化无需重建，避免切换模型时的无谓重绘）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    const oldP = changes.settings.oldValue && changes.settings.oldValue.prompts;
    const newP = changes.settings.newValue && changes.settings.newValue.prompts;
    if (JSON.stringify(oldP || []) !== JSON.stringify(newP || [])) rebuildMenus();
  }
});

/*
 * 注意：chrome.sidePanel.open() 必须在用户手势激活期内【同步】调用。
 * 一旦先 await（哪怕一次 storage 读取），手势即失效，open() 会抛
 * "may only be called in response to a user gesture" 并被吞掉——面板打不开。
 * 因此 open() 放第一行，任务组装放到后面的异步分支；
 * 面板加载晚于任务写入也没关系，侧边栏 init 时 catchUpTask 会主动读任务兜底。
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === PARENT_ID || !tab || !tab.id) return;

  // Tab Dock 类菜单：本地收纳，不涉及问答任务
  if (info.menuItemId === 'tabdock:current' || info.menuItemId === 'tabdock:all' || info.menuItemId === 'tabdock:open') {
    if (info.menuItemId === 'tabdock:open') {
      chrome.tabs.create({ url: chrome.runtime.getURL('tabdock.html') }).catch(() => {});
      return;
    }
    if (info.menuItemId === 'tabdock:current') {
      addTabsToTabDock([tab]).catch((e) => console.error('[Tab Dock] failed to dock current tab:', e));
    } else if (info.menuItemId === 'tabdock:all') {
      chrome.tabs
        .query({})
        .then((tabs) => addTabsToTabDock(tabs))
        .catch((e) => console.error('[Tab Dock] failed to dock all tabs:', e));
    }
    return;
  }

  // 同步抢占用户手势打开面板（面板已打开时此调用无害）
  try {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  } catch {}

  dispatchTask(info, tab).catch((e) => console.error('[webbuddy] failed to dispatch task:', e));
});

/** 右键收纳：一次收纳 = 管理页里的一个分组（与页面/侧栏行为一致），并关闭标签释放内存 */
async function addTabsToTabDock(tabs) {
  const items = tdTabsFromBrowser(tabs);
  if (!items.length) return;
  const state = await tdLoadState();
  tdCollect(state, items, '');
  await tdSaveState(state);
  await tdCloseBrowserTabs(tabs);
}

/*
 * 点工具栏图标：默认打开问答侧边栏，并在同一手势内捕获当前页面上下文
 * （供自由提问感知页面）。open 必须同步抢占手势，抓取放异步分支。
 */
chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  try {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  } catch {}
  capturePageContext(tab).catch((e) => console.error('[webbuddy] failed to capture page context:', e));
});

/*
 * 多标签页场景：侧边栏是全局共享的，页面上下文必须跟随「当前活动标签页」更新，
 * 否则切标签页后自由提问会用到旧标签页的信息。切 tab / 页面加载完成时防抖重捕。
 */
let ctxDebounce = null;
function schedulePageCtxCapture(tab) {
  clearTimeout(ctxDebounce);
  ctxDebounce = setTimeout(() => {
    capturePageContext(tab).catch(() => {});
  }, 400);
}

chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    schedulePageCtxCapture(tab);
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 整页加载完成，或 SPA 路由切换（URL 变化但无 complete）都要重捕
  if (changeInfo.status !== 'complete' && !changeInfo.url) return;
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && active.id === tabId) schedulePageCtxCapture(tab);
  } catch {}
});

/* ================= 截图问图 ================= */

// 侧边栏点「截图」→ 框选 → 全屏截图 → 裁剪 → 回传 dataURL
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'start-screenshot') {
    handleScreenshot()
      .then((dataUrl) => chrome.runtime.sendMessage({ type: 'screenshot-result', dataUrl }))
      .catch((e) => chrome.runtime.sendMessage({ type: 'screenshot-result', error: String((e && e.message) || e) }))
      .catch(() => {});
    return false;
  }
  // 提问前主动核对：即时捕获指定标签页的上下文并回传
  if (msg && msg.type === 'capture-page-ctx-now' && msg.tabId != null) {
    chrome.tabs
      .get(msg.tabId)
      .then(async (tab) => {
        const vars = await buildPageVars(tab);
        await chrome.storage.session.set({ [CTX_KEY]: { vars, at: Date.now() } });
        sendResponse({ vars });
      })
      .catch(() => sendResponse({}));
    return true; // 异步响应
  }
  // 划词气泡点了预设问题：开面板 + 派发任务（与右键菜单同一条链路）
  if (msg && msg.type === 'ask-selection') {
    /*
     * 【同步抢占用户手势】open() 必须在这个同步执行栈里调用，绝不能 await。
     * 该 API 的手势标记只保留约 1ms，一旦先 await（哪怕是 await open 自身），
     * Chrome 就会静默忽略 —— 面板打不开，用户看到的就是「点了没反应」。
     * 与 contextMenus.onClicked 里的写法保持一致。
     */
    const askTabId = sender && sender.tab && sender.tab.id;
    if (askTabId != null) {
      try {
        chrome.sidePanel.open({ tabId: askTabId }).catch(() => {});
      } catch {}
    }
    askFromSelection(msg, sender)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  }
  // 气泡里的 Settings
  if (msg && msg.type === 'open-options') {
    chrome.runtime.openOptionsPage().catch(() => {});
    return false;
  }
  return false;
});

/*
 * 划词气泡入口：只负责组装并写任务，**开面板的动作已在 onMessage 里同步完成**。
 * 这里再 await 一次 open 会让手势失效（见 onMessage 处的说明），所以不要把它搬回来。
 * 面板加载晚于任务写入也没关系，侧边栏 init 时的 catchUpTask 会主动读任务兜底。
 */
async function askFromSelection(msg, sender) {
  const tab = sender && sender.tab;
  if (!tab || tab.id == null) return { ok: false, error: 'No active tab' };

  const opened = true; // open 已在同步分支尝试过；同步调用拿不到可靠结果

  const text = String(msg.text || '').trim();
  if (!text) return { ok: false, error: 'Empty selection' };

  const settings = await getMergedSettings();
  const vars = { text, title: tab.title || '', url: tab.url || '' };

  let task = null;
  if (msg.custom) {
    task = { type: 'custom', label: 'Custom question', vars };
  } else {
    const prompt = settings.prompts.find((p) => p.id === msg.promptId);
    // 与右键菜单同一套过滤条件：禁用的预设不能从任何入口触发
    if (!prompt || !prompt.enabled || !prompt.label || !prompt.template) {
      return { ok: false, error: 'Unknown preset question' };
    }
    task = { type: 'preset', label: prompt.label, template: prompt.template, vars };
  }

  task.taskId = crypto.randomUUID();
  task.tabId = tab.id;
  task.createdAt = Date.now();
  await chrome.storage.session.set({ [TASK_KEY]: task });

  // 顺手刷新页面上下文，便于紧接着的自由追问
  capturePageContext(tab).catch(() => {});

  /*
   * 兜底：sidePanel.open() 即使同步调用也可能被 Chrome 静默拒绝（手势链被拉长、
   * 扩展刚重载等）。这时任务已经落盘，但用户眼前一片安静，最难排查。
   * 所以在这里等一下**回执**：面板真的接住任务会写 ACK，1.5s 内没收到就明确引导用户。
   */
  schedulePanelFallback(tab.id, task.taskId);

  return { ok: true, opened };
}

/**
 * 面板兜底提示：任务写入后若始终没有回执，说明面板多半没打开，
 * 回推一条提示给 content script，让用户知道该点工具栏图标。
 */
function schedulePanelFallback(tabId, taskId) {
  setTimeout(async () => {
    try {
      const data = await chrome.storage.session.get(ACK_KEY);
      if (data[ACK_KEY] === taskId) return; // 面板已接住任务，一切正常
    } catch {
      return;
    }
    chrome.tabs
      .sendMessage(tabId, {
        type: 'wb-toast',
        text: 'Side panel did not open — click the webbuddy toolbar icon to see the answer.'
      })
      .catch(() => {}); // 页面已关闭或脚本未注入则忽略
  }, 1500);
}

/**
 * 注入的框选脚本：覆盖遮罩，用户拖拽框选，Esc 取消。
 * 返回 Promise<{x,y,w,h,dpr,vw,vh} | null>，executeScript 会等待 Promise resolve。
 */
function screenshotSelect() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,0.35);z-index:2147483647;cursor:crosshair;';
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;border:2px solid #4f6ef7;background:rgba(79,110,247,0.15);z-index:2147483647;display:none;pointer-events:none;';
    const tip = document.createElement('div');
    tip.textContent = 'Drag to select an area · Esc to cancel';
    tip.style.cssText =
      'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;background:#1f2329;color:#fff;padding:6px 14px;border-radius:8px;font:13px/1.5 sans-serif;';
    document.body.appendChild(overlay);
    document.body.appendChild(box);
    document.body.appendChild(tip);

    let sx = 0;
    let sy = 0;
    function down(e) {
      sx = e.clientX;
      sy = e.clientY;
      box.style.display = 'block';
      move(e);
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
      e.preventDefault();
      e.stopPropagation();
    }
    function move(e) {
      const x = Math.min(sx, e.clientX);
      const y = Math.min(sy, e.clientY);
      box.style.left = x + 'px';
      box.style.top = y + 'px';
      box.style.width = Math.abs(e.clientX - sx) + 'px';
      box.style.height = Math.abs(e.clientY - sy) + 'px';
    }
    function up(e) {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      cleanup();
      const x = Math.min(sx, e.clientX);
      const y = Math.min(sy, e.clientY);
      const w = Math.abs(e.clientX - sx);
      const h = Math.abs(e.clientY - sy);
      if (w < 5 || h < 5) {
        resolve(null);
        return;
      }
      resolve({ x, y, w, h, dpr: window.devicePixelRatio || 1, vw: window.innerWidth, vh: window.innerHeight });
    }
    function esc(e) {
      if (e.key === 'Escape') {
        cleanup();
        resolve(null);
      }
    }
    function cleanup() {
      overlay.remove();
      box.remove();
      tip.remove();
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', esc, true);
    }
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', esc, true);
  });
}

async function handleScreenshot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) throw new Error('Cannot get the current tab');
  // chrome:// 等浏览器内部页面禁止注入/截图，提前给出友好提示
  if (tab.url && /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(tab.url)) {
    throw new Error('Browser internal pages (' + tab.url.split(':')[0] + '://) cannot be captured — switch to a normal web page');
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: screenshotSelect
  });
  const rect = results && results[0] && results[0].result;
  if (!rect) throw new Error('Cancelled');
  const fullDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return cropScreenshot(fullDataUrl, rect);
}

async function cropScreenshot(fullDataUrl, rect) {
  const resp = await fetch(fullDataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const scale = bitmap.width / (rect.vw || 1);
  const sx = Math.round(rect.x * scale);
  const sy = Math.round(rect.y * scale);
  const sw = Math.round(rect.w * scale);
  const sh = Math.round(rect.h * scale);
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const out = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataURL(out);
}

async function blobToDataURL(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:' + blob.type + ';base64,' + btoa(binary);
}

/**
 * 注入脚本抓取当前页正文（activeTab 在用户手势内授权）。
 * 优先取 article/main/[role=main]，退而取 body；chrome:// 等受限页注入会失败，返回 null。
 */
function extractPageFn() {
  const title = document.title || '';
  const metaDesc = (document.querySelector('meta[name="description"]') || {}).content || '';
  const main = document.querySelector('article, main, [role="main"]');
  const src = main || document.body;
  const text = (src && src.innerText ? src.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
  return { title, url: location.href, meta: String(metaDesc).trim(), text };
}

async function extractPage(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageFn
    });
    const r = results && results[0] && results[0].result;
    if (r && (r.title || r.text || r.url)) return r;
  } catch {
    // chrome:// / Web Store 等页禁止注入，忽略
  }
  return null;
}

/** 组装页面 vars：优先注入抓到的正文，失败则退回 tab 的 title/url */
async function buildPageVars(tab) {
  const vars = { text: '', title: tab.title || '', url: tab.url || '', pageText: '', meta: '' };
  const ex = await extractPage(tab.id);
  if (ex) {
    vars.title = ex.title || vars.title;
    vars.url = ex.url || vars.url;
    vars.meta = ex.meta || '';
    vars.pageText = ex.text || '';
  }
  return vars;
}

/** 捕获当前页上下文写入 CTX_KEY（自由提问时侧边栏读取以感知页面） */
async function capturePageContext(tab) {
  const vars = await buildPageVars(tab);
  await chrome.storage.session.set({ [CTX_KEY]: { vars, at: Date.now() } });
}

async function dispatchTask(info, tab) {
  const settings = await getMergedSettings();
  const baseVars = {
    text: (info.selectionText || '').trim(),
    title: tab.title || '',
    url: tab.url || ''
  };

  let task = null;
  if (info.menuItemId === PAGE_ID) {
    const vars = await buildPageVars(tab);
    task = { type: 'page', label: 'Explain this page', template: PAGE_SUMMARY_PROMPT, vars };
  } else if (info.menuItemId === CUSTOM_ID) {
    // 自定义问题：顺带刷新页面上下文，便于后续自由追问感知页面
    capturePageContext(tab).catch(() => {});
    task = { type: 'custom', label: 'Custom question', vars: baseVars };
  } else {
    const prompt = settings.prompts.find((p) => 'prompt:' + p.id === info.menuItemId);
    if (!prompt) return;
    task = { type: 'preset', label: prompt.label, template: prompt.template, vars: baseVars };
  }

  task.taskId = crypto.randomUUID();
  task.tabId = tab.id;
  task.createdAt = Date.now();

  await chrome.storage.session.set({ [TASK_KEY]: task });
}
