'use strict';

/*
 * webbuddy · Tab Dock 管理页
 * Tab Dock 管理页：布局与交互参照同类标签收纳工具的通行做法，
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

let state = tdEmptyState();
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
  await tdSaveState(state);
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
  TABDOCK_FOLDERS.forEach((f, i) => {
    if (i === 4) {
      const sep = document.createElement('div');
      sep.className = 'rail-sep';
      ui.rail.appendChild(sep);
    }
    const b = document.createElement('button');
    b.className = 'rail-item' + (folder === f.key ? ' on' : '');
    b.innerHTML = iconSvg(f.key) + '<span class="name"></span><span class="num"></span>';
    b.querySelector('.name').textContent = f.label;
    b.querySelector('.num').textContent = String(tdCountFor(state, f.key));
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
  // 星标视图是虚拟卡片，tab 上的 __gid 才是它真正所属的分组
  const gid = tab.__gid || group.id;
  const row = document.createElement('div');
  row.className = 't-row';
  row.title = tab.title + '\n' + tab.url + '\nClick to open · drag to move it to another group';
  row.appendChild(buildFavicon(tab));

  const text = document.createElement('span');
  text.className = 't-text';
  text.textContent = tab.title || tab.url;
  row.appendChild(text);

  const host = document.createElement('span');
  host.className = 't-url';
  host.textContent = hostOf(tab.url);
  row.appendChild(host);

  const star = document.createElement('button');
  star.className = 't-star' + (tab.star ? ' on' : '');
  star.textContent = '★';
  star.title = tab.star ? 'Unstar this page' : 'Star this page';
  star.addEventListener('click', async (e) => {
    e.stopPropagation();
    const next = !tab.star;
    tdStarTab(state, gid, tab.url, next);
    await persist();
    toast(next ? 'Starred — find it under ⭐ Starred' : 'Star removed');
  });
  row.appendChild(star);

  const more = document.createElement('button');
  more.className = 't-more';
  more.textContent = '⋮';
  more.title = 'More actions';
  more.addEventListener('click', (e) => {
    e.stopPropagation(); // 否则会被 document 的「点外部关闭」立刻关掉
    openMenu(e.currentTarget.getBoundingClientRect(), tabMenu(gid, tab));
  });
  row.appendChild(more);

  const del = document.createElement('button');
  del.className = 't-del';
  del.textContent = '✕';
  del.title = 'Remove from this group (without opening)';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    tdRemoveTab(state, gid, tab.url);
    await persist();
    toast('Removed 1 page');
  });
  row.appendChild(del);

  row.addEventListener('click', async () => {
    await tdOpenOne(state, gid, tab.url);
    await persist();
    toast('Opened 1 tab');
  });

  if (folder !== 'trash' && !group.synthetic) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      dragSrc = { gid, url: tab.url };
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

function buildBadges(group) {
  const box = document.createElement('span');
  box.className = 'badges';
  const add = (text, cls) => {
    const s = document.createElement('span');
    s.className = 'badge ' + cls;
    s.textContent = text;
    box.appendChild(s);
  };
  if (group.pinned) add('Pinned', 'pin');
  if (group.star) add('★', 'star');
  if (group.locked) add('Locked', 'lock');
  if (group.pending) add('Pending', '');
  if (group.archived) add('Archived', '');
  return box;
}

function buildCard(group) {
  const isSynth = !!group.synthetic; // 星标视图：虚拟卡片，不支持整组级操作
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = group.id;

  const head = document.createElement('div');
  head.className = 'card-head';

  const left = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = tdTitleOf(group);
  title.appendChild(buildBadges(group));
  left.appendChild(title);

  if (String(group.name || '').trim()) {
    const sub = document.createElement('div');
    sub.className = 'card-sub';
    sub.textContent = tdCountLabel(group.tabs.length) + (group.locked ? ' · locked, kept after restore' : '');
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
  stamp.textContent = tdFormatStamp(group.ts);
  const rel = document.createElement('span');
  rel.className = 'rel';
  rel.textContent = '· ' + tdRelative(group.ts);
  const chev = document.createElement('button');
  chev.className = 'chev';
  chev.textContent = group.collapsed ? '▼' : '▲';
  chev.title = group.collapsed ? 'Expand' : 'Collapse';
  meta.append(stamp, rel, chev);
  right.appendChild(meta);

  const acts = document.createElement('div');
  acts.className = 'card-acts';

  if (folder === 'trash') {
    const back = document.createElement('button');
    back.className = 'link-act';
    back.textContent = '↗ Restore';
    back.addEventListener('click', async () => {
      tdRestoreFromTrash(state, group.id);
      await persist();
      toast('Moved back to the list');
    });
    acts.appendChild(back);
  } else {
    const restore = document.createElement('button');
    restore.className = 'link-act';
    restore.textContent = '↗ Restore all';
    restore.title =
      'Open every page in this group' + (group.locked ? ' (locked: group is kept)' : ', then remove the group from the list');
    restore.addEventListener('click', () => {
      if (isSynth) openPages(group.tabs);
      else restoreGroup(group, 'this');
    });
    acts.appendChild(restore);
  }

  if (!isSynth) {
    const more = document.createElement('button');
    more.className = 'link-act';
    more.textContent = '⋮ More…';
    more.addEventListener('click', (e) => {
      e.stopPropagation(); // 阻止冒泡到 document 的「点外部关闭」，否则菜单会刚开就被关
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(r, folder === 'trash' ? trashMenu(group) : groupMenu(group));
    });
    acts.appendChild(more);
  }
  right.appendChild(acts);
  head.appendChild(right);
  card.appendChild(head);

  const list = buildTabsList(group);
  list.hidden = !!group.collapsed;
  card.appendChild(list);

  /* 拖拽落点挂在整张卡片上：卡片空白处（含头部）也能接收，落到列表范围内时按行插入 */
  if (folder !== 'trash' && !isSynth) {
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
      if (tdMoveTabTo(state, src.gid, src.url, group.id, index)) {
        await persist();
        toast('Moved 1 page');
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
    await tdSaveState(state);
  });

  return card;
}

/* ---------- 渲染 ---------- */

function render() {
  closeMenu();
  clearDropLines();
  renderRail();

  const def = TABDOCK_FOLDERS.find((f) => f.key === folder) || TABDOCK_FOLDERS[0];
  const groups = tdGroupsFor(state, folder, { query, namedOnly });
  ui.chName.textContent = def.label + (query ? ' (search: ' + query + ')' : '');
  ui.chCount.textContent = String(groups.length);

  ui.cards.innerHTML = '';
  if (!groups.length) {
    ui.empty.hidden = false;
    const h = ui.empty.querySelector('h2');
    const ps = ui.empty.querySelectorAll('p');
    if (query) {
      h.textContent = 'No matches';
      ps[0].textContent = 'Try another keyword, or clear the search box.';
      ps[1].textContent = '';
    } else if (folder === 'trash') {
      h.textContent = 'Trash is empty';
      ps[0].textContent = 'Groups you delete with “⋮ More… → Move to trash” land here first — you can restore them any time.';
      ps[1].textContent = '';
    } else if (folder === 'star') {
      h.textContent = 'No starred pages yet';
      ps[0].textContent = 'Hover any page and hit ★ (or use its ⋮ menu) to star it. Starred pages from every group show up here.';
      ps[1].textContent = '';
    } else {
      h.textContent = 'Nothing here yet';
      ps[0].textContent = 'Hit “Collect all windows” in the top-right, or right-click a page → 🗂 Tab Dock → Dock current / all tabs.';
      ps[1].textContent = 'Each dock action becomes one group; drag any page between groups to reorganise.';
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

/* 单条网页的 ⋮ 菜单：星标 / 移动到别的分组（或新建命名分组）/ 用新窗口打开 */
function tabMenu(gid, tab) {
  return [
    {
      label: tab.star ? '★ Unstar this page' : '☆ Star this page',
      action: async () => {
        tdStarTab(state, gid, tab.url, !tab.star);
        await persist();
        toast(tab.star ? 'Star removed' : 'Starred — find it under ⭐ Starred');
      }
    },
    { label: 'Move to group…', action: () => openMoveDialog(gid, tab) },
    { sep: true },
    { label: 'Open in new window', action: () => openPages([tab], 'new') },
    { label: 'Open in incognito window', action: () => openPages([tab], 'incognito') }
  ];
}

/** 打开一批页面（不改变列表内容），并反馈「被 Chrome 拒绝」的数量 */
async function openPages(tabs, mode) {
  const r = await tdOpenTabs(tabs, mode || 'this');
  if (!r.opened) {
    toast(r.failed ? 'Chrome refused to open this page' : 'Nothing to open');
    return;
  }
  toast(
    'Opened ' + r.opened + ' page' + (r.opened === 1 ? '' : 's') +
      (r.failed ? ' · ' + r.failed + ' blocked by Chrome' : '')
  );
}

/* ---------- 移动对话框 ---------- */

function closeDialog() {
  const d = document.getElementById('dialog');
  if (d) d.remove();
}

/**
 * 「移动到分组」：列出其它分组供一键搬运，或直接输入名字新建一个分组
 * （例如把散落各处的工作相关网页收进 Work Panel）。
 */
function openMoveDialog(gid, tab) {
  closeDialog();
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.id = 'dialog';

  const panel = document.createElement('div');
  panel.className = 'modal-panel';

  const h = document.createElement('h3');
  const label = String(tab.title || tab.url);
  h.textContent = 'Move “' + (label.length > 48 ? label.slice(0, 48) + '…' : label) + '” to…';
  panel.appendChild(h);

  const list = document.createElement('div');
  list.className = 'pick-list';
  const others = (state.groups || []).filter((g) => g.id !== gid);
  if (!others.length) {
    const tip = document.createElement('div');
    tip.className = 'pick-empty';
    tip.textContent = 'No other group yet — create one below.';
    list.appendChild(tip);
  }
  others.forEach((g) => {
    const b = document.createElement('button');
    b.className = 'pick-item';
    const nm = document.createElement('span');
    nm.className = 'pick-name';
    nm.textContent = String(g.name || '').trim() || tdCountLabel(g.tabs.length);
    const cnt = document.createElement('span');
    cnt.className = 'pick-count';
    cnt.textContent = g.tabs.length + ' tabs';
    b.append(nm, cnt);
    b.addEventListener('click', async () => {
      closeDialog();
      if (tdMoveTabTo(state, gid, tab.url, g.id, g.tabs.length)) {
        await persist();
        toast('Moved to “' + (String(g.name || '').trim() || tdCountLabel(g.tabs.length)) + '”');
      } else {
        render();
      }
    });
    list.appendChild(b);
  });
  panel.appendChild(list);

  const newRow = document.createElement('div');
  newRow.className = 'pick-new';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'New group name, e.g. Work Panel';
  const create = document.createElement('button');
  create.className = 'pick-create';
  create.textContent = '＋ Create';
  const doCreate = async () => {
    const name = input.value.trim();
    closeDialog();
    const g = tdGroupFromTab(state, gid, tab.url, name);
    if (!g) {
      render();
      return;
    }
    await persist();
    toast(name ? 'Created “' + name + '”' : 'Created a new group');
  };
  create.addEventListener('click', doCreate);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doCreate();
  });
  newRow.append(input, create);
  panel.appendChild(newRow);

  wrap.appendChild(panel);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) closeDialog();
  });
  document.body.appendChild(wrap);
  input.focus();
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
    { label: 'Restore in new window', action: () => restoreGroup(group, 'new') },
    { label: 'Restore here', action: () => restoreGroup(group, 'this') },
    { label: 'Restore in incognito window', action: () => restoreGroup(group, 'incognito') },
    { sep: true },
    { label: 'Copy titles & URLs', action: () => copyGroup(group) },
    { label: 'Rename / add note…', action: () => renameGroup(group) },
    flag('locked', true, 'Lock (keep this group after restore)', 'Unlock'),
    flag('star', true, 'Star this group', 'Unstar this group'),
    flag('pending', true, 'Mark as pending', 'Unmark pending'),
    flag('archived', true, 'Mark as archived', 'Unmark archived'),
    {
      label: group.pinned ? 'Unpin' : 'Pin to top',
      action: async () => {
        if (group.pinned) {
          group.pinned = false;
        } else {
          tdPin(state, group.id);
        }
        await persist();
      }
    },
    { sep: true },
    { label: 'Paste links here…', action: () => importInto(group) },
    { label: 'New group above…', action: () => createNear(group, 'above') },
    { label: 'New group below…', action: () => createNear(group, 'below') },
    {
      label: 'Remove duplicates in this group',
      action: async () => {
        const n = tdRemoveDuplicatesIn(group);
        await persist();
        toast(n ? 'Removed ' + n + ' duplicate links' : 'No duplicates in this group');
      }
    },
    {
      label: 'Move up',
      action: async () => {
        if (!tdMove(state, group.id, 'up')) toast('Already at the top');
        await persist();
      }
    },
    {
      label: 'Move down',
      action: async () => {
        if (!tdMove(state, group.id, 'down')) toast('Already at the bottom');
        await persist();
      }
    },
    { sep: true },
    {
      label: 'Move to trash',
      danger: true,
      action: async () => {
        tdMoveToTrash(state, group.id);
        await persist();
        toast('Moved to trash — restorable any time');
      }
    }
  ];
}

function trashMenu(group) {
  return [
    {
      label: 'Restore to list',
      action: async () => {
        tdRestoreFromTrash(state, group.id);
        await persist();
        toast('Restored to the top of the list');
      }
    },
    { label: 'Restore in new window', action: () => restoreGroup(group, 'new', true) },
    {
      label: 'Copy titles & URLs',
      action: () => copyGroup(group)
    },
    { sep: true },
    {
      label: 'Delete forever',
      danger: true,
      action: async () => {
        if (!confirm('Delete this group forever? This cannot be undone.')) return;
        tdDeleteForever(state, group.id);
        await persist();
        toast('Deleted');
      }
    }
  ];
}

function topMenu() {
  const items = [];
  items.push({ label: 'Dock tabs in current window', action: () => collect({ currentWindow: true }) });
  items.push({ label: 'Dock tabs in all windows', action: () => collect({}) });
  items.push({ sep: true });
  items.push({ label: 'Export as text (portable)', action: () => exportFile('txt') });
  items.push({ label: 'Export as JSON (full backup)', action: () => exportFile('json') });
  items.push({ label: 'Import from file…', action: () => ui.file.click() });
  items.push({ label: 'Import from pasted links…', action: () => importPasted() });
  items.push({ sep: true });
  items.push({
    label: 'Remove all duplicates',
    action: async () => {
      const n = tdRemoveDuplicates(state);
      await persist();
      toast(n ? 'Removed ' + n + ' duplicate links' : 'No duplicates found');
    }
  });
  if (folder === 'trash') {
    items.push({
      label: 'Empty trash',
      danger: true,
      action: async () => {
        const n = tdEmptyTrash(state);
        if (!n) {
          toast('Trash is already empty');
          return;
        }
        if (!confirm('Empty trash? ' + n + ' group(s) will be deleted forever.')) return;
        await persist();
        toast('Emptied ' + n + ' group(s)');
      }
    });
  }
  items.push({ sep: true });
  items.push({ label: 'Open settings', action: () => chrome.runtime.openOptionsPage() });
  return items;
}

/* ---------- 动作 ---------- */

async function restoreGroup(group, mode, fromTrash) {
  try {
    const r = await tdOpenTabs(group.tabs, mode);
    if (!r.opened) {
      toast(r.failed ? 'Chrome refused to open these pages' : 'No page to restore');
      return;
    }
    if (fromTrash) {
      tdDeleteForever(state, group.id);
    } else if (!group.locked) {
      state.groups = state.groups.filter((g) => g.id !== group.id);
    }
    await persist();
    toast(
      'Restored ' + r.opened + ' tab' + (r.opened === 1 ? '' : 's') +
        (r.failed ? ' · ' + r.failed + ' blocked by Chrome' : '') +
        (group.locked && !fromTrash ? ' (locked — group kept)' : '')
    );
  } catch (e) {
    toast(
      mode === 'incognito'
        ? 'Incognito failed: enable “Allow in incognito” for this extension, then retry'
        : 'Failed to open: ' + (e && e.message ? e.message : e)
    );
  }
}

async function collect(opt) {
  try {
    const tabs = await chrome.tabs.query(opt);
    const items = tdTabsFromBrowser(tabs);
    if (!items.length) {
      toast('No dockable tab in this window');
      return;
    }
    const skipped = tdSkippedCount(tabs, items);
    tdCollect(state, items, '');
    await persist();
    const res = await tdCloseBrowserTabs(tabs);
    toast(
      'Docked ' + items.length + ' tabs, closed ' + res.closed + ' to free memory' +
        (skipped ? ' · ' + skipped + ' duplicate(s) skipped' : '') +
        (res.kept ? ' (kept each window’s last tab so the window stays open)' : '')
    );
  } catch (e) {
    toast('Dock failed: ' + (e && e.message ? e.message : e));
  }
}

async function copyGroup(group) {
  const text = group.tabs.map((t) => (t.title || t.url) + '\n' + t.url).join('\n\n');
  const ok = await copyText(text);
  toast(ok ? 'Copied ' + group.tabs.length + ' titles & URLs' : 'Copy failed — select the text manually');
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
  const name = prompt('Group name (leave blank to show “N tabs”)', group.name || '');
  if (name === null) return;
  const note = prompt('Note (optional)', group.note || '');
  if (note === null) return;
  group.name = name.trim();
  group.note = note.trim();
  await persist();
}

async function importInto(group) {
  const text = prompt('Paste links (one per line)');
  if (!text) return;
  const parsed = tdParseImport(text);
  const tabs = parsed.flatMap((g) => g.tabs);
  if (!tabs.length) {
    toast('No link found');
    return;
  }
  const seen = new Set(group.tabs.map((t) => t.url));
  let added = 0;
  tabs.forEach((t) => {
    if (seen.has(t.url)) return;
    group.tabs.push(tdPickTab(t));
    seen.add(t.url);
    added++;
  });
  await persist();
  toast(added ? 'Added ' + added + ' link(s)' : 'All links already exist');
}

async function createNear(group, where) {
  const name = prompt('New group name (optional)', '');
  if (name === null) return;
  const text = prompt('Paste links for this group (one per line)');
  if (!text) return;
  const parsed = tdParseImport(text);
  const tabs = parsed.flatMap((g) => g.tabs);
  if (!tabs.length) {
    toast('No link found — group not created');
    return;
  }
  const g = tdMakeGroup(tabs, name.trim());
  const i = state.groups.findIndex((x) => x.id === group.id);
  state.groups.splice(where === 'above' ? i : i + 1, 0, g);
  await persist();
  toast('Group created (' + tabs.length + ' links)');
}

async function importPasted() {
  const text = prompt('Paste content to import (text / JSON / raw links)');
  if (!text) return;
  applyImport(text, 'Paste');
}

function applyImport(text, source) {
  const groups = tdParseImport(text);
  if (!groups.length) {
    toast('No importable link found');
    return;
  }
  const total = groups.reduce((n, g) => n + g.tabs.length, 0);
  groups.slice().reverse().forEach((g) => state.groups.unshift(g));
  persist();
  toast('Imported ' + groups.length + ' group(s) / ' + total + ' link(s) from ' + source);
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
    toast('Nothing to export');
    return;
  }
  if (kind === 'json') {
    download('tabdock-backup', tdExportJSON(state), 'application/json');
  } else {
    download('tabdock-export', tdExportText(state), 'text/plain');
  }
  toast('Exported ' + state.groups.length + ' group(s)');
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
      { label: 'Export as text (portable)', action: () => exportFile('txt') },
      { label: 'Export as JSON (full backup)', action: () => exportFile('json') },
      { sep: true },
      { label: 'Import from file…', action: () => ui.file.click() },
      { label: 'Import from pasted links…', action: () => importPasted() }
    ]);
  });
  ui.btnOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

  ui.file.addEventListener('change', () => {
    const f = ui.file.files && ui.file.files[0];
    ui.file.value = '';
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => applyImport(String(reader.result || ''), 'File ' + f.name);
    reader.readAsText(f);
  });

  document.addEventListener('click', (e) => {
    if (!ui.menu.hidden && !ui.menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeMenu();
    closeDialog();
  });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[TABDOCK_KEY]) return;
      if (Date.now() - selfSaveAt < 350) return; // 自己刚写的，忽略回声
      tdLoadState().then((s) => {
        state = s;
        render();
      });
    });
  }
}

boot();

async function boot() {
  state = await tdLoadState();
  bind();
  render();
}
