/* webbuddy · 划词气泡（selected-text bubble）
 *
 * 选中文字后在选区旁自动浮出插件图标，鼠标移上去展开预设问题，点一下直接提问，
 * 不用再走右键菜单（右键菜单保留，作为完整入口）。
 *
 * 实现要点：
 * - 全部节点放进 Shadow DOM：① 不受宿主页面 CSS 影响（字体/按钮样式/z-index）；
 *   ② 页面自己的 document 级监听器收不到我们内部的点击，选区不会被清掉。
 * - 在 document 捕获阶段拦下落在自己身上的 mousedown/mouseup，并 preventDefault，
 *   这是「点图标时选区不消失」的关键。
 * - 只读配置、不写配置：预设问题与开关都来自 settings（设置页里改，页面即时生效）。
 */
'use strict';

(function () {
  if (window.__webbuddyBubbleLoaded) return;
  window.__webbuddyBubbleLoaded = true;

  const HOVER_OPEN_DELAY = 90; // 悬停多久才展开菜单（防手划过就闪）
  const HOVER_CLOSE_DELAY = 220; // 移开后多久收起菜单（留出从图标移到菜单的时间）
  const GAP = 6; // 图标与选区 / 菜单与图标 之间的间距
  const SIZE = 28; // 图标尺寸（px）
  const EDGE = 8; // 离视口边缘的最小留白

  /* 与 icons/icon128.png 同款：蓝底圆角方块 + 白色问号。
     内联 SVG 而不是 <img src="chrome-extension://...">，省掉 web_accessible_resources，
     也不给页面留一个可探测的扩展资源地址。 */
  const ICON_SVG =
    '<svg viewBox="0 0 128 128" width="' + SIZE + '" height="' + SIZE + '" aria-hidden="true">' +
    '<rect width="128" height="128" rx="30" fill="#4f6ef7"/>' +
    '<path fill="#fff" d="M64 26c-15.2 0-25.6 9.1-26.6 23.4h13.7c.8-7.2 5.4-11.5 12.6-11.5 6.9 0 11.6 4.1 11.6 10 0 5.5-3.3 8.7-9.4 12.8-6.8 4.5-9.7 9.1-9.7 16.7v3.7h13.5v-3.1c0-4.8 2.1-7.5 7.8-11.2 7.6-4.9 11.7-10.3 11.7-18.9C89 36 79.2 26 64 26z"/>' +
    '<circle cx="64" cy="98" r="8.6" fill="#fff"/>' +
    '</svg>';

  const CSS = `
:host { all: initial; }
.wb-root {
  position: fixed; left: 0; top: 0; z-index: 2147483647;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #1f2329; user-select: none; -webkit-user-select: none;
}
.wb-trigger {
  position: fixed; width: ${SIZE}px; height: ${SIZE}px; padding: 0; margin: 0; border: 0;
  border-radius: 8px; background: #fff; cursor: pointer; box-sizing: border-box;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 8px rgba(15,23,42,.22), 0 0 0 1px rgba(15,23,42,.06);
  transition: transform .12s ease, box-shadow .12s ease;
  animation: wb-pop .14s ease-out;
}
.wb-trigger:hover { transform: scale(1.08); box-shadow: 0 4px 14px rgba(15,23,42,.28), 0 0 0 1px rgba(79,110,247,.4); }
.wb-trigger svg { width: 100%; height: 100%; display: block; border-radius: 8px; }
.wb-menu {
  position: fixed; display: none; box-sizing: border-box;
  min-width: 224px; max-width: 340px; padding: 6px;
  background: #fff; border-radius: 10px;
  box-shadow: 0 10px 34px rgba(15,23,42,.20), 0 0 0 1px rgba(15,23,42,.08);
  animation: wb-pop .12s ease-out;
}
.wb-sel {
  padding: 4px 8px 3px; font-size: 11px; line-height: 1.4; color: #8a9099;
  max-height: 34px; overflow: hidden; word-break: break-word;
}
.wb-item {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 9px; border-radius: 7px; cursor: pointer;
  font-size: 13px; color: #1f2329; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.wb-item:hover, .wb-item.wb-active { background: #eef1fe; }
.wb-item .wb-dot { flex: 0 0 auto; width: 5px; height: 5px; border-radius: 50%; background: #4f6ef7; opacity: .75; }
.wb-item.wb-muted { color: #5b6270; }
.wb-item.wb-muted .wb-dot { background: #c2c7d0; }
.wb-sep { height: 1px; margin: 5px 6px; background: #eceef2; }
.wb-foot {
  display: flex; align-items: center; justify-content: space-between;
  padding: 5px 9px 3px; font-size: 11px; color: #9aa0a8;
}
.wb-foot a { color: #6b7280; text-decoration: none; cursor: pointer; }
.wb-foot a:hover { color: #4f6ef7; }
.wb-toast {
  position: fixed; box-sizing: border-box; max-width: 300px;
  padding: 7px 11px; border-radius: 8px;
  background: #1f2329; color: #fff; font-size: 12px; line-height: 1.45;
  box-shadow: 0 6px 22px rgba(0,0,0,.28);
}
@keyframes wb-pop { from { opacity: 0; transform: translateY(-2px) scale(.97); } to { opacity: 1; } }
`;

  /* settings 读不到时（扩展刚装、存储被清）的兜底：label 必须和 common.js 的
     DEFAULT_SETTINGS 一致，id 也一致，后台才认得出是哪个预设。 */
  const FALLBACK_PROMPTS = [
    { id: 'p1', label: 'Summarize in 3 lines' },
    { id: 'p2', label: 'Find an analogy' },
    { id: 'p3', label: 'Why it matters' },
    { id: 'p4', label: 'Explain for a newcomer' }
  ];

  let enabled = true;
  let presets = FALLBACK_PROMPTS.slice();
  let selectedText = '';
  let visible = false;
  let menuOpen = false;
  let openTimer = null;
  let closeTimer = null;
  let toastTimer = null;

  let host = null;
  let root = null;
  let trigger = null;
  let menu = null;
  let list = null;
  let toastEl = null;
  let lastPos = { x: EDGE, y: EDGE }; // 图标最后落点：气泡隐藏后仍要能定位提示条

  /* ================= 配置 ================= */

  async function loadConfig() {
    let s = null;
    try {
      const res = await chrome.storage.local.get('settings');
      s = res && res.settings;
    } catch {
      s = null; // 扩展被重载后旧 content script 会失去上下文，忽略即可
    }
    enabled = !(s && s.ui && s.ui.selectionBubble === false);
    const raw = s && Array.isArray(s.prompts) ? s.prompts : [];
    const list2 = raw
      .filter((p) => p && p.enabled !== false && p.label && p.template)
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((p) => ({ id: p.id, label: p.label }));
    presets = list2.length ? list2 : FALLBACK_PROMPTS.slice();
    if (!enabled) hideAll();
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) loadConfig();
    });
  } catch {}

  // 后台发现「面板没起来」时回推的提示（兜底，避免点了之后完全没反馈）
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'wb-toast' && msg.text) toast(msg.text);
      return false;
    });
  } catch {}

  /* ================= UI 构建（首次用到才建） ================= */

  function buildUI() {
    if (host) return;
    const wrap = document.documentElement || document.body;
    if (!wrap) return;

    host = document.createElement('div');
    host.id = 'webbuddy-bubble-host';
    host.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;display:block;';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;

    root = document.createElement('div');
    root.className = 'wb-root';
    root.style.display = 'none';

    trigger = document.createElement('button');
    trigger.className = 'wb-trigger';
    trigger.type = 'button';
    // 不设 title：原生 tooltip 会延迟弹出并盖在菜单上（菜单 90ms 就出来了）
    trigger.setAttribute('aria-label', 'webbuddy · ask AI about the selection');
    trigger.innerHTML = ICON_SVG;

    menu = document.createElement('div');
    menu.className = 'wb-menu';
    list = document.createElement('div');
    const foot = document.createElement('div');
    foot.className = 'wb-foot';
    const hint = document.createElement('span');
    hint.textContent = 'webbuddy';
    const gear = document.createElement('a');
    gear.textContent = 'Settings';
    gear.href = '#';
    gear.addEventListener('click', (e) => {
      e.preventDefault();
      hideAll();
      try {
        const p = chrome.runtime.sendMessage({ type: 'open-options' });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {}
    });
    foot.appendChild(hint);
    foot.appendChild(gear);
    menu.appendChild(list);
    menu.appendChild(foot);

    toastEl = document.createElement('div');
    toastEl.className = 'wb-toast';
    toastEl.style.display = 'none';

    root.appendChild(trigger);
    root.appendChild(menu);
    root.appendChild(toastEl);
    shadow.appendChild(style);
    shadow.appendChild(root);
    wrap.appendChild(host);

    /* 悬停展开菜单；移开只收菜单、保留图标，方便再次悬停 */
    trigger.addEventListener('mouseenter', () => {
      clearTimeout(closeTimer);
      clearTimeout(openTimer);
      openTimer = setTimeout(openMenu, HOVER_OPEN_DELAY);
    });
    trigger.addEventListener('mouseleave', () => {
      clearTimeout(openTimer);
      scheduleMenuClose();
    });
    menu.addEventListener('mouseenter', () => {
      clearTimeout(closeTimer);
      clearTimeout(openTimer);
    });
    menu.addEventListener('mouseleave', scheduleMenuClose);
    trigger.addEventListener('click', (e) => {
      // 鼠标路径走 hover，这里主要照顾触屏/键盘：点一下开合
      e.preventDefault();
      e.stopPropagation();
      if (menuOpen) closeMenuNow();
      else openMenu();
    });
  }

  /* 事件是否落在气泡自己身上。
     注意 e.target 在极端情况（合成事件、别家扩展派发）可能不是节点，
     直接调 host.contains() 会抛 TypeError 并打断整个处理器，所以先判类型。 */
  function isInHost(e) {
    if (!host) return false;
    let path = null;
    try {
      path = typeof e.composedPath === 'function' ? e.composedPath() : null;
    } catch {
      path = null;
    }
    if (path && path.length) {
      return path.indexOf(host) >= 0 || path.indexOf(trigger) >= 0 || path.indexOf(menu) >= 0;
    }
    const t = e.target;
    if (!t || t.nodeType !== 1) return false;
    return t === host || host.contains(t);
  }

  /* ================= 显示 / 隐藏 ================= */

  function showBubble(rect) {
    buildUI();
    if (!host) return;
    placeTrigger(rect);
    root.style.display = 'block';
    visible = true;
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    closeMenuNow();
  }

  function hideAll() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeMenuNow();
    if (root) root.style.display = 'none';
    visible = false;
  }

  function closeMenuNow() {
    if (menu) menu.style.display = 'none';
    menuOpen = false;
  }

  function scheduleMenuClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (menuOpen) closeMenuNow();
    }, HOVER_CLOSE_DELAY);
  }

  /* ================= 定位 ================= */

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function placeTrigger(rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = rect.right + GAP;
    let y = rect.bottom + GAP;
    // 贴右边界：翻到选区末端的内侧
    if (x + SIZE > vw - 4) x = rect.right - SIZE - 2;
    // 贴底边：翻到选区上方
    if (y + SIZE > vh - 4) y = rect.top - SIZE - GAP;
    x = clamp(x, 4, Math.max(4, vw - SIZE - 4));
    y = clamp(y, 4, Math.max(4, vh - SIZE - 4));
    trigger.style.left = x + 'px';
    trigger.style.top = y + 'px';
    lastPos = { x, y };
  }

  function placeMenu() {
    const t = trigger.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = t.left;
    if (x + m.width > vw - EDGE) x = vw - EDGE - m.width;
    if (x < EDGE) x = EDGE;
    let y = t.bottom + GAP;
    if (y + m.height > vh - EDGE) {
      const above = t.top - GAP - m.height;
      y = above >= EDGE ? above : Math.max(EDGE, vh - EDGE - m.height);
    }
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  /* 提示条：提问失败时用。此时气泡已经收起，只能靠 lastPos 定位，
     所以不能再去量 trigger（display:none 的量出来是 0×0）。 */
  function toast(text) {
    buildUI();
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.style.left = '0px';
    toastEl.style.top = '0px';
    toastEl.style.display = 'block';
    const w = toastEl.offsetWidth;
    const h = toastEl.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = clamp(lastPos.x, EDGE, Math.max(EDGE, vw - EDGE - w));
    let y = lastPos.y + SIZE + GAP;
    if (y + h > vh - EDGE) y = Math.max(EDGE, lastPos.y - GAP - h);
    toastEl.style.left = x + 'px';
    toastEl.style.top = y + 'px';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.display = 'none';
    }, 3600);
  }

  /* ================= 菜单内容 ================= */

  function renderMenu() {
    list.textContent = '';

    const head = document.createElement('div');
    head.className = 'wb-sel';
    head.textContent = selectedText.length > 56 ? selectedText.slice(0, 56) + '…' : selectedText;
    head.title = selectedText;
    list.appendChild(head);

    presets.forEach((p) => {
      list.appendChild(makeItem(p.label, () => ask({ promptId: p.id })));
    });

    const sep = document.createElement('div');
    sep.className = 'wb-sep';
    list.appendChild(sep);
    list.appendChild(makeItem('Custom question…', () => ask({ custom: true }), 'wb-muted'));
  }

  function makeItem(label, onClick, extraClass) {
    const el = document.createElement('div');
    el.className = 'wb-item' + (extraClass ? ' ' + extraClass : '');
    el.setAttribute('role', 'button');
    el.tabIndex = -1;
    const dot = document.createElement('span');
    dot.className = 'wb-dot';
    const txt = document.createElement('span');
    txt.textContent = label;
    txt.style.overflow = 'hidden';
    txt.style.textOverflow = 'ellipsis';
    el.appendChild(dot);
    el.appendChild(txt);
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return el;
  }

  function openMenu() {
    if (!visible || !menu) return;
    clearTimeout(closeTimer);
    const first = !menuOpen;
    if (first) renderMenu();
    menu.style.visibility = 'hidden';
    menu.style.display = 'block';
    placeMenu();
    menu.style.visibility = 'visible';
    menuOpen = true;
  }

  /* ================= 提问 ================= */

  async function ask(opts) {
    const text = selectedText;
    /*
     * 【手势优先】runtime.sendMessage 必须在点击的同步执行栈里第一时间发出。
     * 用户手势标记存活极短，它要跨「页面 → 后台」这一跳，中途任何拖沓都会让后台的
     * sidePanel.open() 被 Chrome 静默忽略。所以先发消息，收 UI 排在后面。
     */
    let pending = null;
    try {
      pending = chrome.runtime.sendMessage({
        type: 'ask-selection',
        text,
        promptId: opts.promptId || '',
        custom: !!opts.custom
      });
    } catch {
      pending = null;
    }
    hideAll();

    let res = null;
    if (pending) {
      try {
        res = await pending;
      } catch {
        pending = null;
      }
    }
    if (!pending) {
      toast('webbuddy was reloaded — refresh the page and try again.');
      return;
    }
    if (!res || res.ok !== true) {
      toast((res && res.error) || "Couldn't reach webbuddy.");
    }
  }

  /* ================= 选区采集 ================= */

  /* 归一化选中文本：折掉行内多余空格，但**保留换行**（多行选中时 AI 看得懂结构） */
  function selectionText(sel) {
    return String(sel.toString() || '')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function selectionRect(sel) {
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    let rects = [];
    try {
      rects = Array.prototype.slice.call(range.getClientRects());
    } catch {
      rects = [];
    }
    const good = rects.filter((r) => r && r.width > 0 && r.height > 0);
    const rect = good.length ? good[good.length - 1] : range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    // 选区可能滚出视口，这时不弹（否则图标会贴在边上很奇怪）
    if (rect.bottom < 0 || rect.top > window.innerHeight) return null;
    return rect;
  }

  /** 选中的是输入框/可编辑区里的文字？那属于编辑操作，不打扰 */
  function isEditableNode(sel) {
    let node = sel.anchorNode;
    if (!node) return false;
    if (node.nodeType === 3) node = node.parentElement;
    if (!node || !node.closest) return false;
    if (node.isContentEditable) return true;
    return !!node.closest('input, textarea');
  }

  function captureSelection(force) {
    if (!enabled && !force) {
      hideAll();
      return;
    }
    let sel = null;
    try {
      sel = window.getSelection();
    } catch {
      sel = null;
    }
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hideAll();
      return;
    }
    const text = selectionText(sel);
    if (!text) {
      hideAll();
      return;
    }
    if (isEditableNode(sel)) {
      hideAll();
      return;
    }
    const rect = selectionRect(sel);
    if (!rect) {
      hideAll();
      return;
    }
    selectedText = text;
    showBubble(rect);
  }

  /* ================= 事件 ================= */

  /* 捕获阶段挂在 window 上（比 document 更早），保证任何页面脚本都拦不到我们：
     ① 落在气泡上的 mousedown/mouseup 就地截住 —— preventDefault 保住选区，
        stopPropagation 让页面完全察觉不到这次点击（很多站点的「点空白关菜单」因此不会误触发）；
     ② 落在别处的 mousedown 收起气泡。 */
  window.addEventListener(
    'mousedown',
    (e) => {
      if (!visible || !host) return;
      if (isInHost(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      hideAll();
    },
    true
  );

  window.addEventListener(
    'mouseup',
    (e) => {
      if (!enabled) return; // 关掉开关后连选区都不用看，省掉每帧一次 getSelection
      if (host && isInHost(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.button !== 0) return;
      // 等一拍：双击选词 / 三击选段时，mouseup 早于选区最终定型
      setTimeout(() => captureSelection(false), 0);
    },
    true
  );

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      if (menuOpen) {
        closeMenuNow();
        return;
      }
      if (visible) hideAll();
    },
    true
  );

  // 选区被清掉（点空白、Ctrl+A 后取消等）就收起来；滚动/缩放会让定位失效，也收起
  document.addEventListener('selectionchange', () => {
    if (!visible) return;
    let sel = null;
    try {
      sel = window.getSelection();
    } catch {
      sel = null;
    }
    if (!sel || sel.isCollapsed || !selectionText(sel)) hideAll();
  });

  // scroll 不冒泡，但捕获阶段能从 window 一路传到内层滚动容器，所以这里也能盖住页内滚动
  window.addEventListener('scroll', () => visible && hideAll(), true);
  window.addEventListener('resize', () => visible && hideAll(), true);
  window.addEventListener('blur', () => visible && hideAll());

  loadConfig();
})();
