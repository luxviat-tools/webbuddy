'use strict';

/*
 * 学习助手 · OneTab 管理页
 * 1:1 复刻官方 OneTab 的布局与交互：
 *  顶栏搜索 / 左栏分类计数 / 分组卡片（N tabs + 时间 + 折叠）/ 恢复全部 / ⋮ 更多菜单
 * 额外能力：标签链接可拖拽 —— 跨分组搬运、组内重排。
 */

const el = (id) => document.getElementById(id);
const ui = {
  rail: el('rail'),
  cards: el('cards'),
  empty: el('empty'),
  chName: el('ch-name'),
  chCount: el('ch-count'),
  q: el('q'),
  namedOnly: el('named-only'),
  menu: el('menu'),
  toast: el('toast'),
  file: el('file'),
  btnIO: el('btn-io'),
  btnOptions: el('btn-options'),
  btnViewMore: el('btn-view-more'),
  btnCollectAll: el('btn-collect-all')
};

let state = otEmptyState();
let folder = 'all';
let query = '';
let namedOnly = false;
let toastTimer = null;
let selfSaveAt = 0;
let dragSrc = null; // { gid, url }

/* ---------- 小工具 ---------- */

const ICONS = {
  folder: 'M3 7a2 2 0 0 1 2-2h3.6l1.7 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  star: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z',
  clock: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM12 7v5l3.2 1.9',
  archive: 'M3 7h18v3H3zM5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9M9.5 14h5',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6'
};

function iconSvg(kind) {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' +
    (ICONS[kind] || ICONS.folder) +
    '"></path></svg>'
  );
}

function toast(text) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 2600);
}

async function persist() {
  selfSaveAt = Date.now();
  await otSaveState(state);
  render();
}

function closeMenu() {
  ui.menu.hidden = true;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/* ---------- 左栏 ---------- */

function renderRail() {
  ui.rail.innerHTML = '';
  ONETAB_FOLDERS.forEach((f, i) => {
    if (i === 4) {
      const sep = document.createElement('div');
      sep.className = 'rail-sep';
      ui.rail.appendChild(sep);
    }
    const b = document.createElement('button');
    b.className = 'rail-item' + (folder === f.key ? ' on' : '');
    b.innerHTML = iconSvg(f.key) + '<span class="name"></span><span class="num"></span>';
    b.querySelector('.name').textContent = f.label;
    b.querySelector('.num').textContent = String(otCountFor(state, f.key));
    b.addEventListener('click', () => {
      folder = f.key;
      render();
    });
    ui.rail.appendChild(b);
  });
}

/* ---------- 卡片 ---------- */

function buildFavicon(tab) {
  const box = document.createElement('div');
  box.className = 't-fav';
  const fallback = () => {
    box.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = (hostOf(tab.url) || '·').charAt(0).toUpperCase();
    box.appendChild(span);
  };
  if (tab.favIconUrl && /^https?:/i.test(tab.favIconUrl)) {
    const img = document.createElement('img');
    img.src = tab.favIconUrl;
    img.alt = '';
    img.addEventListener('error', fallback);
    box.appendChild(img);
  } else {
    fallback();
  }
  return box;
}

function buildRow(group, tab) {
  const row = document.createElement('div');
  row.className = 't-row';
  row.title = tab.title + '\n' + tab.url + '\n（点击打开；按住可拖到其它卡片）';
  row.appendChild(buildFavicon(tab));

  const text = document.createElement('span');
  text.className = 't-text';
  text.textContent = tab.title || tab.url;
  row.appendChild(text);

  const host = document.createElement('span');
  host.className = 't-url';
  host.textContent = hostOf(tab.url);
  row.appendChild(host);

  const del = document.createElement('button');
  del.className = 't-del';
  del.textContent = '✕';
  del.title = '从本组移除（不打开）';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    group.tabs = group.tabs.filter((t) => t.url !== tab.url);
    if (!group.tabs.length) state.groups = state.groups.filter((g) => g.id !== group.id);
    await persist();
  });
  row.appendChild(del);

  row.addEventListener('click', async () => {
    await otOpenOne(state, group.id, tab.url);
    await persist();
    toast('已打开 1 个标签');
  });

  if (folder !== 'trash') {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      dragSrc = { gid: group.id, url: tab.url };
      row.classList.add('dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.url);
      } catch {}
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      dragSrc = null;
      clearDropLines();
    });
  }
  return row;
}

function clearDropLines() {
  ui.cards.querySelectorAll('.drop-line').forEach((n) => n.remove());
  ui.cards.querySelectorAll('.card.dragover').forEach((n) => n.classList.remove('dragover'));
}

function buildTabsList(group) {
  const list = document.createElement('div');
  list.className = 'tabs';
  if (!group.tabs.length) list.classList.add('empty-list');
  group.tabs.forEach((tab) => list.appendChild(buildRow(group, tab)));
  return list;
}

function showDropLine(list, y) {
  list.querySelectorAll('.drop-line').forEach((n) => n.remove());
  const rows = [...list.querySelectorAll('.t-row')];
  const line = document.createElement('div');
  line.className = 'drop-line';
  let target = null;
  for (const r of rows) {
    const rect = r.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      target = r;
      break;
    }
  }
  if (target) list.insertBefore(line, target);
  else list.appendChild(line);
}

function moveTab(srcGid, url, dstGid, index) {
  const src = state.groups.find((g) => g.id === srcGid);
  const dst = state.groups.find((g) => g.id === dstGid);
  if (!src || !dst || folder === 'trash') return false;
  const si = src.tabs.findIndex((t) => t.url === url);
  if (si < 0) return false;
  const [tab] = src.tabs.splice(si, 1);
  if (src === dst) {
    let idx = index > si ? index - 1 : index;
    dst.tabs.splice(Math.max(0, Math.min(idx, dst.tabs.length)), 0, tab);
  } else {
    dst.tabs.splice(Math.max(0, Math.min(index, dst.tabs.length)), 0, tab);
    if (!src.tabs.length) state.groups = state.groups.filter((g) => g.id !== srcGid);
  }
  return true;
}

function buildBadges(group) {
  const box = document.createElement('span');
  box.className = 'badges';
  const add = (text, cls) => {
    const s = document.createElement('span');
    s.className = 'badge ' + cls;
    s.textContent = text;
    box.appendChild(s);
  };
  if (group.pinned) add('置顶', 'pin');
  if (group.star) add('★', 'star');
  if (group.locked) add('锁定', 'lock');
  if (group.pending) add('待办', '');
  if (group.archived) add('归档', '');
  return box;
}

function buildCard(group) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = group.id;

  const head = document.createElement('div');
  head.className = 'card-head';

  const left = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = otTitleOf(group);
  title.appendChild(buildBadges(group));
  left.appendChild(title);

  if (String(group.name || '').trim()) {
    const sub = document.createElement('div');
    sub.className = 'card-sub';
    sub.textContent = otCountLabel(group.tabs.length) + (group.locked ? ' · 已锁定，恢复后保留' : '');
    left.appendChild(sub);
  }
  if (String(group.note || '').trim()) {
    const note = document.createElement('div');
    note.className = 'card-note';
    note.textContent = group.note;
    left.appendChild(note);
  }
  head.appendChild(left);

  const right = document.createElement('div');
  right.className = 'card-right';

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const stamp = document.createElement('span');
  stamp.textContent = otFormatStamp(group.ts);
  const rel = document.createElement('span');
  rel.className = 'rel';
  rel.textContent = '· ' + otRelative(group.ts);
  const chev = document.createElement('button');
  chev.className = 'chev';
  chev.textContent = group.collapsed ? '▼' : '▲';
  chev.title = group.collapsed ? '展开' : '折叠';
  meta.append(stamp, rel, chev);
  right.appendChild(meta);

  const acts = document.createElement('div');
  acts.className = 'card-acts';

  if (folder === 'trash') {
    const back = document.createElement('button');
    back.className = 'link-act';
    back.textContent = '↗ 恢复出来';
    back.addEventListener('click', async () => {
      otRestoreFromTrash(state, group.id);
      await persist();
      toast('已移出回收站');
    });
    acts.appendChild(back);
  } else {
    const restore = document.createElement('button');
    restore.className = 'link-act';
    restore.textContent = '↗ 恢复全部';
    restore.title = '在当前位置打开本组全部标签' + (group.locked ? '（已锁定：打开后本组保留）' : '，并从列表中移除');
    restore.addEventListener('click', () => restoreGroup(group, 'this'));
    acts.appendChild(restore);
  }

  const more = document.createElement('button');
  more.className = 'link-act';
  more.textContent = '⋮ 更多…';
  more.addEventListener('click', (e) => {
    e.stopPropagation(); // 阻止冒泡到 document 的「点外部关闭」，否则菜单会刚开就被关
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r, folder === 'trash' ? trashMenu(group) : groupMenu(group));
  });
  acts.appendChild(more);
  right.appendChild(acts);
  head.appendChild(right);
  card.appendChild(head);

  const list = buildTabsList(group);
  list.hidden = !!group.collapsed;
  card.appendChild(list);

  /* 拖拽落点挂在整张卡片上：卡片空白处（含头部）也能接收，落到列表范围内时按行插入 */
  if (folder !== 'trash') {
    card.addEventListener('dragover', (e) => {
      if (!dragSrc) return;
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'move';
      } catch {}
      if (group.collapsed) {
        group.collapsed = false;
        list.hidden = false;
        chev.textContent = '▲';
      }
      card.classList.add('dragover');
      showDropLine(list, e.clientY);
    });
    card.addEventListener('dragleave', (e) => {
      if (card.contains(e.relatedTarget)) return;
      card.classList.remove('dragover');
      list.querySelectorAll('.drop-line').forEach((n) => n.remove());
    });
    card.addEventListener('drop', async (e) => {
      if (!dragSrc) return;
      e.preventDefault();
      const rows = [...list.querySelectorAll('.t-row')];
      let index = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) {
          index = i;
          break;
        }
      }
      const src = dragSrc;
      dragSrc = null;
      clearDropLines();
      if (moveTab(src.gid, src.url, group.id, index)) {
        await persist();
        toast('已移动 1 个标签');
      } else {
        render();
      }
    });
  }

  chev.addEventListener('click', async (e) => {
    e.stopPropagation();
    group.collapsed = !group.collapsed;
    list.hidden = group.collapsed;
    chev.textContent = group.collapsed ? '▼' : '▲';
    selfSaveAt = Date.now();
    await otSaveState(state);
  });

  return card;
}

/* ---------- 渲染 ---------- */

function render() {
  closeMenu();
  clearDropLines();
  renderRail();

  const def = ONETAB_FOLDERS.find((f) => f.key === folder) || ONETAB_FOLDERS[0];
  const groups = otGroupsFor(state, folder, { query, namedOnly });
  ui.chName.textContent = def.label + (query ? '（搜索：' + query + '）' : '');
  ui.chCount.textContent = String(groups.length);

  ui.cards.innerHTML = '';
  if (!groups.length) {
    ui.empty.hidden = false;
    const h = ui.empty.querySelector('h2');
    const ps = ui.empty.querySelectorAll('p');
    if (query) {
      h.textContent = '没有匹配的分组';
      ps[0].textContent = '换个关键词，或清空搜索框。';
      ps[1].textContent = '';
    } else if (folder === 'trash') {
      h.textContent = '回收站是空的';
      ps[0].textContent = '在任意卡片上「⋮ 更多… → 移到回收站」的条目会先落到这里，可随时恢复。';
      ps[1].textContent = '';
    } else {
      h.textContent = '这里还没有内容';
      ps[0].textContent = '点右上角「收入全部窗口」，或在浏览的网页上右键 → 🗂 OneTab → 收入当前 / 所有标签。';
      ps[1].textContent = '一次收纳生成一张卡片；卡片里的每个链接都能拖到别的卡片里重新归类。';
    }
    return;
  }
  ui.empty.hidden = true;
  groups.forEach((g) => ui.cards.appendChild(buildCard(g)));
}

/* ---------- 菜单 ---------- */

function openMenu(anchorRect, items) {
  const m = ui.menu;
  m.innerHTML = '';
  items.forEach((it) => {
    if (it.sep) {
      const d = document.createElement('div');
      d.className = 'sep';
      m.appendChild(d);
      return;
    }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.classList.add('danger');
    b.addEventListener('click', () => {
      closeMenu();
      it.action();
    });
    m.appendChild(b);
  });
  m.hidden = false;
  const r = m.getBoundingClientRect();
  let left = window.scrollX + anchorRect.right - r.width;
  let top = window.scrollY + anchorRect.bottom + 4;
  if (left < 8) left = window.scrollX + 8;
  if (r.top + r.height > window.innerHeight - 8) {
    top = window.scrollY + anchorRect.top - r.height - 4;
  }
  m.style.left = left + 'px';
  m.style.top = Math.max(window.scrollY + 8, top) + 'px';
}

function groupMenu(group) {
  const flag = (key, on, offLabel, onLabel) => ({
    label: group[key] ? onLabel : offLabel,
    action: async () => {
      group[key] = !group[key];
      await persist();
    }
  });
  return [
    { label: '恢复到新窗口', action: () => restoreGroup(group, 'new') },
    { label: '恢复到本窗口', action: () => restoreGroup(group, 'this') },
    { label: '恢复到无痕窗口', action: () => restoreGroup(group, 'incognito') },
    { sep: true },
    { label: '复制标题与链接', action: () => copyGroup(group) },
    { label: '重命名 / 加备注…', action: () => renameGroup(group) },
    flag('locked', true, '锁定（恢复全部时保留）', '取消锁定'),
    flag('star', true, '加星标', '取消星标'),
    flag('pending', true, '标记为待办', '取消待办'),
    flag('archived', true, '标记为已归档', '取消归档'),
    {
      label: group.pinned ? '取消置顶' : '置顶到最前',
      action: async () => {
        if (group.pinned) {
          group.pinned = false;
        } else {
          otPin(state, group.id);
        }
        await persist();
      }
    },
    { sep: true },
    { label: '在此处粘贴链接…', action: () => importInto(group) },
    { label: '在本组上方新建分组…', action: () => createNear(group, 'above') },
    { label: '在本组下方新建分组…', action: () => createNear(group, 'below') },
    {
      label: '移除本组重复项',
      action: async () => {
        const n = otRemoveDuplicatesIn(group);
        await persist();
        toast(n ? '已移除 ' + n + ' 个重复链接' : '本组没有重复链接');
      }
    },
    {
      label: '上移',
      action: async () => {
        if (!otMove(state, group.id, 'up')) toast('已经在最前面了');
        await persist();
      }
    },
    {
      label: '下移',
      action: async () => {
        if (!otMove(state, group.id, 'down')) toast('已经在最后面了');
        await persist();
      }
    },
    { sep: true },
    {
      label: '移到回收站',
      danger: true,
      action: async () => {
        otMoveToTrash(state, group.id);
        await persist();
        toast('已移到回收站，可随时恢复');
      }
    }
  ];
}

function trashMenu(group) {
  return [
    {
      label: '恢复到列表',
      action: async () => {
        otRestoreFromTrash(state, group.id);
        await persist();
        toast('已恢复到列表顶部');
      }
    },
    { label: '恢复到新窗口', action: () => restoreGroup(group, 'new', true) },
    {
      label: '复制标题与链接',
      action: () => copyGroup(group)
    },
    { sep: true },
    {
      label: '彻底删除',
      danger: true,
      action: async () => {
        if (!confirm('彻底删除这一组？无法恢复。')) return;
        otDeleteForever(state, group.id);
        await persist();
        toast('已彻底删除');
      }
    }
  ];
}

function topMenu() {
  const items = [];
  items.push({ label: '收入当前窗口标签', action: () => collect({ currentWindow: true }) });
  items.push({ label: '收入所有窗口标签', action: () => collect({}) });
  items.push({ sep: true });
  items.push({ label: '导出为文本（OneTab 兼容）', action: () => exportFile('txt') });
  items.push({ label: '导出为 JSON（完整备份）', action: () => exportFile('json') });
  items.push({ label: '从文件导入…', action: () => ui.file.click() });
  items.push({ label: '粘贴链接导入…', action: () => importPasted() });
  items.push({ sep: true });
  items.push({
    label: '移除全部重复项',
    action: async () => {
      const n = otRemoveDuplicates(state);
      await persist();
      toast(n ? '已移除 ' + n + ' 个重复链接' : '没有发现重复链接');
    }
  });
  if (folder === 'trash') {
    items.push({
      label: '清空回收站',
      danger: true,
      action: async () => {
        const n = otEmptyTrash(state);
        if (!n) {
          toast('回收站已经是空的');
          return;
        }
        if (!confirm('清空回收站？' + n + ' 个分组将被彻底删除。')) return;
        await persist();
        toast('已清空 ' + n + ' 个分组');
      }
    });
  }
  items.push({ sep: true });
  items.push({ label: '打开设置', action: () => chrome.runtime.openOptionsPage() });
  return items;
}

/* ---------- 动作 ---------- */

async function restoreGroup(group, mode, fromTrash) {
  try {
    const n = await otOpenTabs(group.tabs, mode);
    if (!n) {
      toast('没有可恢复的网页');
      return;
    }
    if (fromTrash) {
      otDeleteForever(state, group.id);
    } else if (!group.locked) {
      state.groups = state.groups.filter((g) => g.id !== group.id);
    }
    await persist();
    toast('已恢复 ' + n + ' 个标签' + (group.locked && !fromTrash ? '（已锁定，本组保留）' : ''));
  } catch (e) {
    toast(
      mode === 'incognito'
        ? '无痕窗口打开失败：请在扩展详情里开启「允许在无痕模式下使用」，然后重试'
        : '打开失败：' + (e && e.message ? e.message : e)
    );
  }
}

async function collect(opt) {
  try {
    const tabs = await chrome.tabs.query(opt);
    const items = otTabsFromBrowser(tabs);
    if (!items.length) {
      toast('当前没有可收纳的网页标签');
      return;
    }
    const group = otCollect(state, items, '');
    await persist();
    const res = await otCloseBrowserTabs(tabs);
    toast(
      '已收入 ' + items.length + ' 个标签，关闭 ' + res.closed + ' 个以释放内存' +
        (res.kept ? '（每个窗口保留最后一个页签，避免整窗被关掉）' : '')
    );
  } catch (e) {
    toast('收纳失败：' + (e && e.message ? e.message : e));
  }
}

async function copyGroup(group) {
  const text = group.tabs.map((t) => (t.title || t.url) + '\n' + t.url).join('\n\n');
  const ok = await copyText(text);
  toast(ok ? '已复制 ' + group.tabs.length + ' 条标题与链接' : '复制失败，请手动选择文本');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    return ok;
  }
}

async function renameGroup(group) {
  const name = prompt('分组名称（留空则显示为「N tabs」）', group.name || '');
  if (name === null) return;
  const note = prompt('备注 / 提示（可留空）', group.note || '');
  if (note === null) return;
  group.name = name.trim();
  group.note = note.trim();
  await persist();
}

async function importInto(group) {
  const text = prompt('粘贴链接（每行一个，可直接粘贴 OneTab 导出的文本）');
  if (!text) return;
  const parsed = otParseImport(text);
  const tabs = parsed.flatMap((g) => g.tabs);
  if (!tabs.length) {
    toast('没有解析到链接');
    return;
  }
  const seen = new Set(group.tabs.map((t) => t.url));
  let added = 0;
  tabs.forEach((t) => {
    if (seen.has(t.url)) return;
    group.tabs.push(otPickTab(t));
    seen.add(t.url);
    added++;
  });
  await persist();
  toast(added ? '已加入 ' + added + ' 条链接' : '链接都已存在，未新增');
}

async function createNear(group, where) {
  const name = prompt('新分组名称（可留空）', '');
  if (name === null) return;
  const text = prompt('粘贴该分组的链接（每行一个，或直接粘贴 OneTab 文本）');
  if (!text) return;
  const parsed = otParseImport(text);
  const tabs = parsed.flatMap((g) => g.tabs);
  if (!tabs.length) {
    toast('没有解析到链接，未创建分组');
    return;
  }
  const g = otMakeGroup(tabs, name.trim());
  const i = state.groups.findIndex((x) => x.id === group.id);
  state.groups.splice(where === 'above' ? i : i + 1, 0, g);
  await persist();
  toast('已新建分组（' + tabs.length + ' 个链接）');
}

async function importPasted() {
  const text = prompt('粘贴要导入的内容（OneTab 文本 / JSON / 一堆链接均可）');
  if (!text) return;
  applyImport(text, '粘贴');
}

function applyImport(text, source) {
  const groups = otParseImport(text);
  if (!groups.length) {
    toast('没有解析到可导入的链接');
    return;
  }
  const total = groups.reduce((n, g) => n + g.tabs.length, 0);
  groups.slice().reverse().forEach((g) => state.groups.unshift(g));
  persist();
  toast('已从' + source + '导入 ' + groups.length + ' 个分组 / ' + total + ' 个链接');
}

/* ---------- 导入导出 ---------- */

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  a.href = URL.createObjectURL(blob);
  a.download =
    filename + '-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function exportFile(kind) {
  if (!state.groups.length) {
    toast('列表为空，没有可导出的内容');
    return;
  }
  if (kind === 'json') {
    download('onetab-backup', otExportJSON(state), 'application/json');
  } else {
    download('onetab-export', otExportText(state), 'text/plain');
  }
  toast('已导出 ' + state.groups.length + ' 个分组');
}

/* ---------- 事件 ---------- */

function bind() {
  ui.q.addEventListener('input', () => {
    query = ui.q.value.trim();
    render();
  });
  ui.namedOnly.addEventListener('change', () => {
    namedOnly = ui.namedOnly.checked;
    render();
  });
  ui.btnCollectAll.addEventListener('click', () => collect({}));
  ui.btnViewMore.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r, topMenu());
  });
  ui.btnIO.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r, [
      { label: '导出为文本（OneTab 兼容）', action: () => exportFile('txt') },
      { label: '导出为 JSON（完整备份）', action: () => exportFile('json') },
      { sep: true },
      { label: '从文件导入…', action: () => ui.file.click() },
      { label: '粘贴链接导入…', action: () => importPasted() }
    ]);
  });
  ui.btnOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

  ui.file.addEventListener('change', () => {
    const f = ui.file.files && ui.file.files[0];
    ui.file.value = '';
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => applyImport(String(reader.result || ''), '文件 ' + f.name);
    reader.readAsText(f);
  });

  document.addEventListener('click', (e) => {
    if (!ui.menu.hidden && !ui.menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[ONETAB_KEY]) return;
      if (Date.now() - selfSaveAt < 350) return; // 自己刚写的，忽略回声
      otLoadState().then((s) => {
        state = s;
        render();
      });
    });
  }
}

boot();

async function boot() {
  state = await otLoadState();
  bind();
  render();
}
