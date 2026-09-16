'use strict';

/*
 * 学习助手 · OneTab 数据层（三端共用）
 * 被 onetab.html（管理页）、sidepanel/onetab.js（侧栏）以及
 * background.js（importScripts，右键菜单收纳）共同加载。
 * 约束：纯逻辑 + chrome API，不引用 document / window，保证可被 SW 加载。
 *
 * 数据模型：storage.local['la_onetab_v2']
 * {
 *   v: 2,
 *   groups: [ Group ],   // 一次收纳 = 一个分组 = 界面上一张卡片
 *   trash:  [ Group ]    // 回收站（软删除）
 * }
 * Group = {
 *   id, name, note, ts,
 *   locked, star, pending, archived, pinned, collapsed,
 *   tabs: [{ url, title, favIconUrl }]
 * }
 */

const ONETAB_KEY = 'la_onetab_v2';
const ONETAB_KEY_LEGACY = 'la_onetab_list';

/* ---------- 基础工具 ---------- */

function otUid() {
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 只有 http/https/file 可被关闭或重新打开；chrome:// 等一律跳过 */
function otSavableUrl(url) {
  return typeof url === 'string' && /^(https?:|file:)/i.test(url);
}

function otPickTab(t) {
  const url = String((t && t.url) || '');
  return {
    url,
    title: String((t && t.title) || url),
    favIconUrl: String((t && t.favIconUrl) || '')
  };
}

/** 浏览器 tabs.query 结果 → 可存储的标签数组 */
function otTabsFromBrowser(tabs) {
  return (tabs || []).filter((t) => t && otSavableUrl(t.url)).map(otPickTab);
}

function otPad2(n) {
  return String(n).padStart(2, '0');
}

/** 9/15/26 16:43（对齐官方页面的日期样式） */
function otFormatStamp(ts) {
  const d = new Date(Number(ts) || Date.now());
  return (
    d.getMonth() + 1 + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2) +
    ' ' + otPad2(d.getHours()) + ':' + otPad2(d.getMinutes())
  );
}

/** 27 分钟前 */
function otRelative(ts) {
  const diff = Math.max(0, Math.floor((Date.now() - (Number(ts) || 0)) / 1000));
  if (diff < 60) return '刚刚';
  const m = Math.floor(diff / 60);
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  const d = Math.floor(h / 24);
  if (d < 30) return d + ' 天前';
  return Math.floor(d / 30) + ' 个月前';
}

/** 卡片主标题：有命名用命名，否则「N tabs」 */
function otTitleOf(group) {
  const name = String(group.name || '').trim();
  if (name) return name;
  return otCountLabel(group.tabs.length);
}

function otCountLabel(n) {
  return (Number(n) || 0) + ' tab' + (Number(n) === 1 ? '' : 's');
}

/* ---------- 状态 ---------- */

function otEmptyState() {
  return { v: 2, groups: [], trash: [] };
}

function otNormalizeGroup(g) {
  const src = g || {};
  const tabs = (Array.isArray(src.tabs) ? src.tabs : [])
    .map(otPickTab)
    .filter((t) => otSavableUrl(t.url));
  return {
    id: String(src.id || otUid()),
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
 * - 数组（v1 扁平列表 / OneTab 导出）→ 收敛为一个分组
 * - {groups, trash}
 */
function otNormalizeState(raw) {
  if (Array.isArray(raw)) {
    const tabs = otTabsFromBrowser(raw);
    return {
      v: 2,
      groups: tabs.length ? [otMakeGroup(tabs, '升级自旧列表')] : [],
      trash: []
    };
  }
  const s = raw && typeof raw === 'object' ? raw : {};
  const norm = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map(otNormalizeGroup)
      .filter((g) => g.tabs.length > 0);
  return { v: 2, groups: norm(s.groups), trash: norm(s.trash) };
}

function otMakeGroup(tabs, name) {
  return {
    id: otUid(),
    name: String(name || ''),
    note: '',
    ts: Date.now(),
    locked: false,
    star: false,
    pending: false,
    archived: false,
    pinned: false,
    collapsed: false,
    tabs: (tabs || []).map(otPickTab)
  };
}

async function otLoadState() {
  let res = {};
  try {
    res = await chrome.storage.local.get([ONETAB_KEY, ONETAB_KEY_LEGACY]);
  } catch {
    return otEmptyState();
  }
  const state = otNormalizeState(res[ONETAB_KEY]);
  if (!state.groups.length && !state.trash.length && Array.isArray(res[ONETAB_KEY_LEGACY]) && res[ONETAB_KEY_LEGACY].length) {
    // 老版本（扁平清单）首次升级
    const migrated = otNormalizeState(res[ONETAB_KEY_LEGACY]);
    await otSaveState(migrated);
    try {
      await chrome.storage.local.remove(ONETAB_KEY_LEGACY);
    } catch {}
    return migrated;
  }
  return state;
}

async function otSaveState(state) {
  const payload = {
    v: 2,
    groups: (state.groups || []).map(otNormalizeGroup).filter((g) => g.tabs.length),
    trash: (state.trash || []).map(otNormalizeGroup).filter((g) => g.tabs.length)
  };
  try {
    await chrome.storage.local.set({ [ONETAB_KEY]: payload });
  } catch (e) {
    console.error('[OneTab] 保存失败:', e);
  }
}

/* ---------- 查询 ---------- */

/** 视图定义（左栏） */
const ONETAB_FOLDERS = [
  { key: 'all', label: '全部' },
  { key: 'star', label: '星标' },
  { key: 'pending', label: '待办' },
  { key: 'archived', label: '已归档' },
  { key: 'trash', label: '回收站' }
];

function otGroupsFor(state, folderKey, opts) {
  const o = opts || {};
  if (folderKey === 'trash') {
    return (state.trash || []).slice().sort((a, b) => b.ts - a.ts);
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
  return list;
}

function otCountFor(state, folderKey) {
  if (folderKey === 'trash') return (state.trash || []).length;
  const list = state.groups || [];
  if (folderKey === 'star') return list.filter((g) => g.star).length;
  if (folderKey === 'pending') return list.filter((g) => g.pending).length;
  if (folderKey === 'archived') return list.filter((g) => g.archived).length;
  return list.length;
}

function otFindGroup(state, id) {
  const inGroups = (state.groups || []).find((g) => g.id === id);
  if (inGroups) return { group: inGroups, where: 'groups' };
  const inTrash = (state.trash || []).find((g) => g.id === id);
  if (inTrash) return { group: inTrash, where: 'trash' };
  return null;
}

/* ---------- 变更 ---------- */

/** 收纳：一次收纳 = 在最前面新增一个分组（官方行为：最新在最上） */
function otCollect(state, tabs, name) {
  const items = otTabsFromBrowser(tabs);
  if (!items.length) return null;
  const group = otMakeGroup(items, name || '');
  state.groups.unshift(group);
  return group;
}

function otMoveToTrash(state, id) {
  const i = state.groups.findIndex((g) => g.id === id);
  if (i < 0) return false;
  const [g] = state.groups.splice(i, 1);
  g.ts = g.ts || Date.now();
  state.trash.unshift(g);
  return true;
}

function otRestoreFromTrash(state, id) {
  const i = state.trash.findIndex((g) => g.id === id);
  if (i < 0) return false;
  const [g] = state.trash.splice(i, 1);
  state.groups.unshift(g);
  return true;
}

function otDeleteForever(state, id) {
  const before = state.trash.length;
  state.trash = state.trash.filter((g) => g.id !== id);
  return state.trash.length !== before;
}

function otEmptyTrash(state) {
  const n = state.trash.length;
  state.trash = [];
  return n;
}

function otMove(state, id, dir) {
  const i = state.groups.findIndex((g) => g.id === id);
  if (i < 0) return false;
  const j = dir === 'down' ? i + 1 : i - 1;
  if (j < 0 || j >= state.groups.length) return false;
  const [g] = state.groups.splice(i, 1);
  state.groups.splice(j, 0, g);
  return true;
}

function otPin(state, id) {
  const i = state.groups.findIndex((g) => g.id === id);
  if (i < 0) return false;
  const [g] = state.groups.splice(i, 1);
  g.pinned = true;
  state.groups.unshift(g);
  return true;
}

/** 全局去重：按 URL 保留首次出现（跨分组） */
function otRemoveDuplicates(state) {
  const seen = new Set();
  let removed = 0;
  state.groups.forEach((g) => {
    g.tabs = g.tabs.filter((t) => {
      if (seen.has(t.url)) {
        removed++;
        return false;
      }
      seen.add(t.url);
      return true;
    });
  });
  state.groups = state.groups.filter((g) => g.tabs.length);
  return removed;
}

/** 单组去重 */
function otRemoveDuplicatesIn(group) {
  const seen = new Set();
  let removed = 0;
  group.tabs = group.tabs.filter((t) => {
    if (seen.has(t.url)) {
      removed++;
      return false;
    }
    seen.add(t.url);
    return true;
  });
  return removed;
}

/* ---------- 打开标签 ---------- */

/**
 * @param {'this'|'new'|'incognito'} mode
 * @returns {Promise<number>} 实际打开数量
 */
async function otOpenTabs(tabs, mode) {
  const urls = (tabs || []).map((t) => t.url).filter(otSavableUrl);
  if (!urls.length) return 0;
  if (mode === 'new') {
    await chrome.windows.create({ url: urls });
    return urls.length;
  }
  if (mode === 'incognito') {
    await chrome.windows.create({ url: urls, incognito: true });
    return urls.length;
  }
  let n = 0;
  for (const u of urls) {
    try {
      await chrome.tabs.create({ url: u });
      n++;
    } catch {}
  }
  return n;
}

/** 单个标签：打开从浏览器标签中移除，空组则删除 */
async function otOpenOne(state, groupId, url) {
  const found = otFindGroup(state, groupId);
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
 * 否则该窗口会整体消失（侧边栏也会跟着没），比 OneTab 更激进，属于我们不想要的副作用。
 * @param {chrome.tabs.Tab[]} tabs
 * @returns {Promise<{closed:number, kept:number}>}
 */
async function otCloseBrowserTabs(tabs) {
  const list = (tabs || []).filter((t) => t && typeof t.id === 'number' && otSavableUrl(t.url));
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

function otExportText(state) {
  const lines = [];
  (state.groups || []).forEach((g) => {
    lines.push(otCountLabel(g.tabs.length));
    lines.push(otFormatStamp(g.ts));
    g.tabs.forEach((t) => {
      lines.push(t.title || t.url);
      lines.push(t.url);
    });
    lines.push('');
  });
  return lines.join('\n').trim() + '\n';
}

function otExportJSON(state) {
  return JSON.stringify({ v: 2, groups: state.groups, trash: state.trash }, null, 2);
}

/**
 * 宽松解析：兼容
 * 1) 本工具 JSON（{groups}）或数组
 * 2) OneTab 导出的纯文本（「N tabs」/日期行 / 标题行 / URL 行交替）
 * 3) 直接粘贴的一堆链接
 */
function otParseImport(text) {
  const raw = String(text || '');
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      const json = JSON.parse(trimmed);
      if (Array.isArray(json)) return [otNormalizeGroup({ tabs: json, name: '导入' })].filter((g) => g.tabs.length);
      if (json && Array.isArray(json.groups)) {
        return json.groups.map(otNormalizeGroup).filter((g) => g.tabs.length);
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
      cur = otMakeGroup([], '');
      groups.push(cur);
    }
    return cur;
  };

  raw.split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s) return;
    if (/^\d+\s+tabs?$/i.test(s)) {
      cur = otMakeGroup([], '');
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
    if (all.length) return [otMakeGroup(all, '导入')];
  }
  return groups.filter((g) => g.tabs.length);
}
