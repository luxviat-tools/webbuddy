'use strict';

/*
 * webbuddy · Tab Dock 数据层（三端共用）
 * 被 tabdock.html（管理页）、sidepanel/tabdock.js（侧栏）以及
 * background.js（importScripts，右键菜单收纳）共同加载。
 * 约束：纯逻辑 + chrome API，不引用 document / window，保证可被 SW 加载。
 *
 * 数据模型：storage.local['la_tabdock_v1']
 * {
 *   v: 2,
 *   groups: [ Group ],   // 一次收纳 = 一个分组 = 界面上一张卡片
 *   trash:  [ Group ]    // 回收站（软删除）
 * }
 * Group = {
 *   id, name, note, ts,
 *   locked, star, pending, archived, pinned, collapsed,
 *   tabs: [{ url, title, favIconUrl, star }]   // star 为单条网页级星标
 * }
 */

const TABDOCK_KEY = 'la_tabdock_v1';
const TABDOCK_KEY_LEGACY = 'la_tabdock_legacy';

/* ---------- 基础工具 ---------- */

function tdUid() {
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * 可收纳的 URL：http(s) / file / chrome / chrome-extension / edge
 * Chrome 允许扩展用 tabs.create 打开特权页（chrome://extensions 等），所以这类页面
 * 也能正常收纳、关闭、重开；个别仍被拒绝的页面由 tdOpenTabs 统计进 failed 并提示，
 * 不会静默丢失。空白新标签页没有收藏价值，排除。
 */
const TD_BLOCKED_URL =
  /^(about:blank|about:newtab|chrome:\/\/(newtab|new-tab-page)|edge:\/\/(newtab|new-tab-page))/i;

function tdSavableUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (TD_BLOCKED_URL.test(url)) return false;
  return /^(https?:|file:|chrome:|chrome-extension:|edge:)/i.test(url);
}

function tdPickTab(t) {
  const url = String((t && t.url) || '');
  return {
    url,
    title: String((t && t.title) || url),
    favIconUrl: String((t && t.favIconUrl) || ''),
    star: !!(t && t.star)
  };
}

/**
 * 去重键：忽略锚点、结尾斜杠、主机名大小写与常见的 utm/sp 追踪参数。
 * 这样「同一页面开两份」「带 #锚点」「http 与 https 之外的大小写差异」都会被认成一条。
 * 刻意保留查询串（?id=1 与 ?id=2 是不同页面），只剔除不影响内容的追踪参数。
 */
function tdDedupeKey(url) {
  let s = String(url || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    u.hash = '';
    if (u.search) {
      const kept = [...u.searchParams].filter(([k]) => !/^(utm_|spm|from|ref|referrer|share_)/i.test(k));
      u.search = kept.length ? new URLSearchParams(kept).toString() : '';
    }
    return (
      u.protocol.toLowerCase() +
      '//' +
      u.hostname.toLowerCase() +
      (u.port ? ':' + u.port : '') +
      u.pathname.replace(/\/+$/, '') +
      u.search
    );
  } catch {
    return s.replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * 浏览器 tabs.query 结果 → 可存储的标签数组。
 * **只在本次收纳的这一批里去重**（同一窗口里重复开的页面不会再存两份）；
 * 不去动历史分组里已有的记录，避免误删用户以前特意保留的条目。
 * @returns {Array} 去重后的标签数组
 */
function tdTabsFromBrowser(tabs) {
  const seen = new Set();
  const out = [];
  (tabs || []).forEach((t) => {
    if (!t || !tdSavableUrl(t.url)) return;
    const k = tdDedupeKey(t.url);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(tdPickTab(t));
  });
  return out;
}

/** 本次收纳被去重掉的条数（用于提示），传入原始 tabs 与去重后的 items */
function tdSkippedCount(tabs, items) {
  const dockable = (tabs || []).filter((t) => t && tdSavableUrl(t.url)).length;
  return Math.max(0, dockable - (items || []).length);
}

function tdPad2(n) {
  return String(n).padStart(2, '0');
}

/** 9/15/26 16:43（对齐官方页面的日期样式） */
function tdFormatStamp(ts) {
  const d = new Date(Number(ts) || Date.now());
  return (
    d.getMonth() + 1 + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2) +
    ' ' + tdPad2(d.getHours()) + ':' + tdPad2(d.getMinutes())
  );
}

/** 27 分钟前 */
function tdRelative(ts) {
  const diff = Math.max(0, Math.floor((Date.now() - (Number(ts) || 0)) / 1000));
  if (diff < 60) return 'just now';
  const m = Math.floor(diff / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd ago';
  return Math.floor(d / 30) + 'mo ago';
}

/** 卡片主标题：有命名用命名，否则「N tabs」 */
function tdTitleOf(group) {
  const name = String(group.name || '').trim();
  if (name) return name;
  return tdCountLabel(group.tabs.length);
}

function tdCountLabel(n) {
  return (Number(n) || 0) + ' tab' + (Number(n) === 1 ? '' : 's');
}

/* ---------- 状态 ---------- */

function tdEmptyState() {
  return { v: 2, groups: [], trash: [] };
}

function tdNormalizeGroup(g) {
  const src = g || {};
  const tabs = (Array.isArray(src.tabs) ? src.tabs : [])
    .map(tdPickTab)
    .filter((t) => tdSavableUrl(t.url));
  return {
    id: String(src.id || tdUid()),
    name: String(src.name || ''),
    note: String(src.note || ''),
    ts: Number(src.ts) || Date.now(),
    locked: !!src.locked,
    star: !!src.star,
    pending: !!src.pending,
    archived: !!src.archived,
    pinned: !!src.pinned,
    collapsed: !!src.collapsed,
    tabs
  };
}

/**
 * 归一化任意来源的数据：
 * - 数组（v1 扁平列表 / Tab Dock 导出）→ 收敛为一个分组
 * - {groups, trash}
 */
function tdNormalizeState(raw) {
  if (Array.isArray(raw)) {
    const tabs = tdTabsFromBrowser(raw);
    return {
      v: 2,
      groups: tabs.length ? [tdMakeGroup(tabs, 'Imported from old list')] : [],
      trash: []
    };
  }
  const s = raw && typeof raw === 'object' ? raw : {};
  const norm = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map(tdNormalizeGroup)
      .filter((g) => g.tabs.length > 0);
  return { v: 2, groups: norm(s.groups), trash: norm(s.trash) };
}

function tdMakeGroup(tabs, name) {
  return {
    id: tdUid(),
    name: String(name || ''),
    note: '',
    ts: Date.now(),
    locked: false,
    star: false,
    pending: false,
    archived: false,
    pinned: false,
    collapsed: false,
    tabs: (tabs || []).map(tdPickTab)
  };
}

async function tdLoadState() {
  let res = {};
  try {
    res = await chrome.storage.local.get([TABDOCK_KEY, TABDOCK_KEY_LEGACY]);
  } catch {
    return tdEmptyState();
  }
  const state = tdNormalizeState(res[TABDOCK_KEY]);
  if (!state.groups.length && !state.trash.length && Array.isArray(res[TABDOCK_KEY_LEGACY]) && res[TABDOCK_KEY_LEGACY].length) {
    // 老版本（扁平清单）首次升级
    const migrated = tdNormalizeState(res[TABDOCK_KEY_LEGACY]);
    await tdSaveState(migrated);
    try {
      await chrome.storage.local.remove(TABDOCK_KEY_LEGACY);
    } catch {}
    return migrated;
  }
  return state;
}

async function tdSaveState(state) {
  const payload = {
    v: 2,
    groups: (state.groups || []).map(tdNormalizeGroup).filter((g) => g.tabs.length),
    trash: (state.trash || []).map(tdNormalizeGroup).filter((g) => g.tabs.length)
  };
  try {
    await chrome.storage.local.set({ [TABDOCK_KEY]: payload });
  } catch (e) {
    console.error('[Tab Dock] save failed:', e);
  }
}

/* ---------- 查询 ---------- */

/** 视图定义（左栏） */
const TABDOCK_FOLDERS = [
  { key: 'all', label: 'All' },
  { key: 'star', label: 'Starred' },
  { key: 'pending', label: 'Pending' },
  { key: 'archived', label: 'Archived' },
  { key: 'trash', label: 'Trash' }
];

/** 左栏「星标」专用的虚拟分组 id（只在渲染时生成，不写进存储） */
const TABDOCK_STARRED_ID = '__starred__';

/**
 * 汇总所有打了星的「单个网页」，跨分组平铺成一张虚拟卡片。
 * 每条 tab 带 __gid 记录它真正属于哪个分组，行级操作（移动 / 去星 / 删除）据此回写。
 */
function tdStarredGroup(state) {
  const tabs = [];
  let newest = 0;
  (state.groups || []).forEach((g) => {
    g.tabs.forEach((t) => {
      if (!t.star) return;
      tabs.push({
        url: t.url,
        title: t.title,
        favIconUrl: t.favIconUrl,
        star: true,
        __gid: g.id
      });
      if (Number(g.ts) > newest) newest = Number(g.ts);
    });
  });
  if (!tabs.length) return [];
  return [
    {
      id: TABDOCK_STARRED_ID,
      name: 'Starred pages',
      note: '',
      ts: newest || Date.now(),
      locked: true,
      star: true,
      pending: false,
      archived: false,
      pinned: false,
      collapsed: false,
      synthetic: true,
      tabs
    }
  ];
}

function tdGroupsFor(state, folderKey, opts) {
  const o = opts || {};
  if (folderKey === 'trash') {
    return (state.trash || []).slice().sort((a, b) => b.ts - a.ts);
  }
  if (folderKey === 'star') {
    const q = String(o.query || '').trim().toLowerCase();
    let starred = tdStarredGroup(state);
    if (q) {
      starred = starred
        .map((g) => Object.assign({}, g, {
          tabs: g.tabs.filter(
            (t) =>
              String(t.title || '').toLowerCase().includes(q) ||
              String(t.url || '').toLowerCase().includes(q)
          )
        }))
        .filter((g) => g.tabs.length);
    }
    return starred;
  }
  let list = (state.groups || []).slice();
  if (folderKey === 'star') list = list.filter((g) => g.star);
  else if (folderKey === 'pending') list = list.filter((g) => g.pending);
  else if (folderKey === 'archived') list = list.filter((g) => g.archived);
  if (o.namedOnly) list = list.filter((g) => String(g.name || '').trim());
  const q = String(o.query || '').trim().toLowerCase();
  if (q) {
    list = list.filter((g) => {
      if (String(g.name || '').toLowerCase().includes(q)) return true;
      if (String(g.note || '').toLowerCase().includes(q)) return true;
      return g.tabs.some(
        (t) =>
          String(t.title || '').toLowerCase().includes(q) ||
          String(t.url || '').toLowerCase().includes(q)
      );
    });
  }
  // 置顶组浮到最前，其余按收纳时间倒序（最新的在最上）
  list.sort((a, b) => {
    const pa = !!a.pinned;
    const pb = !!b.pinned;
    if (pa !== pb) return pb ? 1 : -1;
    return (Number(b.ts) || 0) - (Number(a.ts) || 0);
  });
  return list;
}

function tdCountFor(state, folderKey) {
  if (folderKey === 'trash') return (state.trash || []).length;
  const list = state.groups || [];
  if (folderKey === 'star') {
    return list.reduce((n, g) => n + g.tabs.filter((t) => t.star).length, 0);
  }
  if (folderKey === 'pending') return list.filter((g) => g.pending).length;
  if (folderKey === 'archived') return list.filter((g) => g.archived).length;
  return list.length;
}

function tdFindGroup(state, id) {
  const inGroups = (state.groups || []).find((g) => g.id === id);
  if (inGroups) return { group: inGroups, where: 'groups' };
  const inTrash = (state.trash || []).find((g) => g.id === id);
  if (inTrash) return { group: inTrash, where: 'trash' };
  return null;
}

/* ---------- 变更 ---------- */

/** 收纳：一次收纳 = 在最前面新增一个分组（官方行为：最新在最上） */
function tdCollect(state, tabs, name) {
  const items = tdTabsFromBrowser(tabs);
  if (!items.length) return null;
  const group = tdMakeGroup(items, name || '');
  state.groups.unshift(group);
  return group;
}

function tdMoveToTrash(state, id) {
  const i = state.groups.findIndex((g) => g.id === id);
  if (i < 0) return false;
  const [g] = state.groups.splice(i, 1);
  g.ts = g.ts || Date.now();
  state.trash.unshift(g);
  return true;
}

function tdRestoreFromTrash(state, id) {
  const i = state.trash.findIndex((g) => g.id === id);
  if (i < 0) return false;
  const [g] = state.trash.splice(i, 1);
  state.groups.unshift(g);
  return true;
}

function tdDeleteForever(state, id) {
  const before = state.trash.length;
  state.trash = state.trash.filter((g) => g.id !== id);
  return state.trash.length !== before;
}

function tdEmptyTrash(state) {
  const n = state.trash.length;
  state.trash = [];
  return n;
}

function tdMove(state, id, dir) {
  const i = state.groups.findIndex((g) => g.id === id);
  if (i < 0) return false;
  const j = dir === 'down' ? i + 1 : i - 1;
  if (j < 0 || j >= state.groups.length) return false;
  const [g] = state.groups.splice(i, 1);
  state.groups.splice(j, 0, g);
  return true;
}

function tdPin(state, id) {
  const i = state.groups.findIndex((g) => g.id === id);
  if (i < 0) return false;
  const [g] = state.groups.splice(i, 1);
  g.pinned = true;
  state.groups.unshift(g);
  return true;
}

/* ---------- 单条网页级操作 ---------- */
/*
 * 说明：星标视图里的 tab 带 __gid（真正所属分组），而渲染用的卡片可能是虚拟分组，
 * 所以这里一律以 gid 参数定位真实分组，不依赖传入的 group 对象身份。
 */

/** 切换单条网页的星标 */
function tdStarTab(state, gid, url, on) {
  const found = tdFindGroup(state, gid);
  if (!found) return false;
  const tab = found.group.tabs.find((t) => t.url === url);
  if (!tab) return false;
  tab.star = on == null ? !tab.star : !!on;
  return true;
}

/** 从所属分组移除单条网页（组空则整组删除） */
function tdRemoveTab(state, gid, url) {
  const found = tdFindGroup(state, gid);
  if (!found) return false;
  const before = found.group.tabs.length;
  found.group.tabs = found.group.tabs.filter((t) => t.url !== url);
  if (found.group.tabs.length === before) return false;
  if (!found.group.tabs.length && found.where === 'groups') {
    state.groups = state.groups.filter((g) => g.id !== gid);
  }
  return true;
}

/** 把单条网页移动到目标分组的指定位置（同组内则重排） */
function tdMoveTabTo(state, srcGid, url, dstGid, index) {
  const src = (state.groups || []).find((g) => g.id === srcGid);
  const dst = (state.groups || []).find((g) => g.id === dstGid);
  if (!src || !dst) return false;
  const si = src.tabs.findIndex((t) => t.url === url);
  if (si < 0) return false;
  const [tab] = src.tabs.splice(si, 1);
  let idx = index == null ? dst.tabs.length : index;
  if (src === dst && idx > si) idx -= 1;
  dst.tabs.splice(Math.max(0, Math.min(idx, dst.tabs.length)), 0, tab);
  if (src !== dst && !src.tabs.length) {
    state.groups = state.groups.filter((g) => g.id !== srcGid);
  }
  return true;
}

/** 以单条网页为种子新建一个命名分组（如「Work Panel」），新组置顶 */
function tdGroupFromTab(state, srcGid, url, name) {
  const src = (state.groups || []).find((g) => g.id === srcGid);
  if (!src) return null;
  const si = src.tabs.findIndex((t) => t.url === url);
  if (si < 0) return null;
  const [tab] = src.tabs.splice(si, 1);
  const group = tdMakeGroup([tab], name || '');
  state.groups.unshift(group);
  if (!src.tabs.length) state.groups = state.groups.filter((g) => g.id !== srcGid);
  return group;
}

/** 全局去重：按 URL 保留首次出现（跨分组） */
function tdRemoveDuplicates(state) {
  const seen = new Set();
  let removed = 0;
  state.groups.forEach((g) => {
    g.tabs = g.tabs.filter((t) => {
      const k = tdDedupeKey(t.url);
      if (seen.has(k)) {
        removed++;
        return false;
      }
      seen.add(k);
      return true;
    });
  });
  state.groups = state.groups.filter((g) => g.tabs.length);
  return removed;
}

/** 单组去重 */
function tdRemoveDuplicatesIn(group) {
  const seen = new Set();
  let removed = 0;
  group.tabs = group.tabs.filter((t) => {
    const k = tdDedupeKey(t.url);
    if (seen.has(k)) {
      removed++;
      return false;
    }
    seen.add(k);
    return true;
  });
  return removed;
}

/* ---------- 打开标签 ---------- */

/**
 * @param {'this'|'new'|'incognito'} mode
 * @returns {Promise<{opened:number, failed:number}>} 打开成功 / 被浏览器拒绝的数量
 * 逐个打开而非一次性丢给 windows.create：混有 chrome:// 等特权页时可以做到
 * 「能开的都开、开不了的单独计数」，不会因为一条失败导致整批都不开。
 */
async function tdOpenTabs(tabs, mode) {
  const urls = (tabs || []).map((t) => t.url).filter(tdSavableUrl);
  if (!urls.length) return { opened: 0, failed: 0 };
  let opened = 0;
  let failed = 0;
  if (mode === 'new' || mode === 'incognito') {
    let win = null;
    let winTried = false;
    for (const u of urls) {
      try {
        if (!winTried) {
          winTried = true;
          win = await chrome.windows.create({ url: u, incognito: mode === 'incognito' });
        } else if (win && win.id != null) {
          await chrome.tabs.create({ windowId: win.id, url: u, active: false });
        } else {
          throw new Error('window unavailable');
        }
        opened++;
      } catch {
        failed++;
      }
    }
    return { opened, failed };
  }
  for (const u of urls) {
    try {
      await chrome.tabs.create({ url: u });
      opened++;
    } catch {
      failed++;
    }
  }
  return { opened, failed };
}

/** 单个标签：打开从浏览器标签中移除，空组则删除 */
async function tdOpenOne(state, groupId, url) {
  const found = tdFindGroup(state, groupId);
  if (!found) return;
  const tb = found.group.tabs.find((t) => t.url === url);
  if (!tb) return;
  try {
    await chrome.tabs.create({ url: tb.url });
  } catch {}
  if (found.group.locked) return;
  found.group.tabs = found.group.tabs.filter((t) => t.url !== url);
  if (!found.group.tabs.length) state.groups = state.groups.filter((g) => g.id !== groupId);
}

/* ---------- 关闭标签（收纳时的省内存动作） ---------- */

/**
 * 关闭一批浏览器标签，但**绝不关闭某个窗口的最后一个标签**——
 * 否则该窗口会整体消失（侧边栏也会跟着没），比 Tab Dock 更激进，属于我们不想要的副作用。
 * @param {chrome.tabs.Tab[]} tabs
 * @returns {Promise<{closed:number, kept:number}>}
 */
/** 本扩展自己的管理页：收纳时不关它，否则在管理页点「收入全部窗口」会把自己关掉 */
function tdOwnPageUrl() {
  try {
    return chrome.runtime.getURL('tabdock.html');
  } catch {
    return '';
  }
}

async function tdCloseBrowserTabs(tabs) {
  const own = tdOwnPageUrl();
  const list = (tabs || []).filter((t) => {
    if (!t || typeof t.id !== 'number' || !tdSavableUrl(t.url)) return false;
    if (own && String(t.url).split('#')[0] === own) return false;
    return true;
  });
  if (!list.length) return { closed: 0, kept: 0 };

  const byWin = new Map();
  list.forEach((t) => {
    const key = t.windowId == null ? -1 : t.windowId;
    if (!byWin.has(key)) byWin.set(key, []);
    byWin.get(key).push(t);
  });

  const keep = new Set();
  for (const [winId, group] of byWin) {
    if (winId < 0) continue;
    try {
      const all = await chrome.tabs.query({ windowId: winId });
      if (all.length <= group.length) {
        const last = group[group.length - 1];
        if (last && typeof last.id === 'number') keep.add(last.id);
      }
    } catch {}
  }

  const ids = list.map((t) => t.id).filter((id) => !keep.has(id));
  let closed = 0;
  if (ids.length) {
    try {
      await chrome.tabs.remove(ids);
      closed = ids.length;
    } catch {}
  }
  return { closed, kept: keep.size };
}

/* ---------- 导入 / 导出 ---------- */

function tdExportText(state) {
  const lines = [];
  (state.groups || []).forEach((g) => {
    lines.push(tdCountLabel(g.tabs.length));
    lines.push(tdFormatStamp(g.ts));
    g.tabs.forEach((t) => {
      lines.push(t.title || t.url);
      lines.push(t.url);
    });
    lines.push('');
  });
  return lines.join('\n').trim() + '\n';
}

function tdExportJSON(state) {
  return JSON.stringify({ v: 2, groups: state.groups, trash: state.trash }, null, 2);
}

/**
 * 宽松解析：兼容
 * 1) 本工具 JSON（{groups}）或数组
 * 2) Tab Dock 导出的纯文本（「N tabs」/日期行 / 标题行 / URL 行交替）
 * 3) 直接粘贴的一堆链接
 */
function tdParseImport(text) {
  const raw = String(text || '');
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      const json = JSON.parse(trimmed);
      if (Array.isArray(json)) return [tdNormalizeGroup({ tabs: json, name: 'Imported' })].filter((g) => g.tabs.length);
      if (json && Array.isArray(json.groups)) {
        return json.groups.map(tdNormalizeGroup).filter((g) => g.tabs.length);
      }
    } catch {}
  }

  const urlOf = (s) => {
    const m = s.match(/(https?:\/\/[^\s"'<>]+|file:\/\/[^\s"'<>]+)/i);
    if (!m) return null;
    return { url: m[0].replace(/[),.;，。、]+$/, ''), at: m.index };
  };

  const groups = [];
  let cur = null;
  let pendingTitle = '';
  const ensure = () => {
    if (!cur) {
      cur = tdMakeGroup([], '');
      groups.push(cur);
    }
    return cur;
  };

  raw.split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s) return;
    if (/^\d+\s+tabs?$/i.test(s)) {
      cur = tdMakeGroup([], '');
      groups.push(cur);
      pendingTitle = '';
      return;
    }
    // 日期行：9/15/26 4:57 PM · 18 minutes ago
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}(\s|$)/.test(s)) return;
    const hit = urlOf(s);
    if (hit) {
      const before = s.slice(0, hit.at).trim().replace(/[-–—:：\s]+$/, '');
      const after = s.slice(hit.at + hit.url.length).trim().replace(/^[-–—:：\s]+/, '');
      const g = ensure();
      g.tabs.push({
        url: hit.url,
        title: before || after || pendingTitle || hit.url,
        favIconUrl: ''
      });
      pendingTitle = '';
      return;
    }
    pendingTitle = s;
  });

  if (!groups.length) {
    // 兜底：整段文本里所有链接合成一组
    const all = [];
    let m;
    const re = /(https?:\/\/[^\s"'<>]+)/gi;
    while ((m = re.exec(raw))) all.push({ url: m[1], title: m[1] });
    if (all.length) return [tdMakeGroup(all, 'Imported')];
  }
  return groups.filter((g) => g.tabs.length);
}
