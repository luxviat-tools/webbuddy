'use strict';

/*
 * webbuddy · Tab Dock 侧栏入口
 * 侧栏定位是「随手收纳」：一键把当前窗口的标签收进来并关闭以释放内存。
 * 完整管理（分类计数 / 回收站 / 拖动归类 / ⋮ 更多菜单）在 tabdock.html 管理页里。
 * 数据层与页面、Service Worker 共用 tabdock-store.js。
 */

const tdEl = {
  btn: document.getElementById('btn-tabdock'),
  view: document.getElementById('tabdock-view'),
  list: document.getElementById('td-list'),
  empty: document.getElementById('td-empty'),
  collect: document.getElementById('td-collect'),
  openPage: document.getElementById('td-open-page'),
  expandAll: document.getElementById('td-expand-all'),
  importBtn: document.getElementById('td-import'),
  exportBtn: document.getElementById('td-export'),
  file: document.getElementById('td-file'),
  status: document.getElementById('td-status'),
  thread: document.getElementById('thread'),
  footer: document.getElementById('footer-bar'),
  navDots: document.getElementById('nav-dots')
};

const OT_SIDE_LIMIT = 20;

let tdActive = false;
let tdState = tdEmptyState();
let tdStatusTimer = null;
let tdExpanded = new Set();
let tdSelfSaveAt = 0;

/* 收纳面板内的轻量状态提示（footer 在收纳模式下隐藏，故用面板内独立提示） */
function tdStatus(text) {
  if (!tdEl.status) return;
  tdEl.status.textContent = text || '';
  tdEl.status.hidden = !text;
  clearTimeout(tdStatusTimer);
  if (text) {
    tdStatusTimer = setTimeout(() => {
      tdEl.status.hidden = true;
      tdEl.status.textContent = '';
    }, 2400);
  }
}

async function tdPersist() {
  tdSelfSaveAt = Date.now();
  await tdSaveState(tdState);
  tdRender();
}

function tdHostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function tdFavicon(tab) {
  const box = document.createElement('div');
  box.className = 'td-fav';
  const fallback = () => {
    box.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = (tdHostOf(tab.url) || '·').charAt(0).toUpperCase();
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

/* ---------- 渲染 ---------- */

function tdVisibleGroups() {
  return tdGroupsFor(tdState, 'all', {}).filter((g) => !g.archived);
}

/** 一键展开/收起：全部已展开时收起，否则全部展开 */
function tdToggleExpandAll() {
  const groups = tdVisibleGroups();
  if (!groups.length) return;
  const allOpen = groups.every((g) => tdExpanded.has(g.id));
  if (allOpen) tdExpanded.clear();
  else groups.forEach((g) => tdExpanded.add(g.id));
  tdRender();
  tdStatus(allOpen ? 'Collapsed all' : 'Expanded ' + groups.length + ' group(s)');
}

function tdRender() {
  if (!tdEl.list) return;
  tdEl.list.innerHTML = '';
  const groups = tdVisibleGroups();

  // 按钮文案随状态切换：全部展开时显示 Collapse all
  if (tdEl.expandAll) {
    const allOpen = groups.length > 0 && groups.every((g) => tdExpanded.has(g.id));
    tdEl.expandAll.textContent = allOpen ? 'Collapse all' : 'Expand all';
  }

  if (!groups.length) {
    tdEl.empty.hidden = false;
    tdEl.list.hidden = true;
    return;
  }
  tdEl.empty.hidden = true;
  tdEl.list.hidden = false;

  const shown = groups.slice(0, OT_SIDE_LIMIT);
  shown.forEach((group) => tdEl.list.appendChild(tdBuildGroup(group)));

  if (groups.length > shown.length || tdState.trash.length) {
    const hint = document.createElement('div');
    hint.className = 'td-hint';
    const more = groups.length - shown.length;
    const parts = [];
    if (more > 0) parts.push(more + ' more group(s)');
    if (tdState.trash.length) parts.push('trash: ' + tdState.trash.length);
    hint.textContent = parts.join(' · ') + ' — open the manager';
    tdEl.list.appendChild(hint);
  }
}

/* 文字型操作：无边框无底色，hover 才着色 */
function tdTxt(label, cls, title, onClick) {
  const b = document.createElement('button');
  b.className = 'td-txt' + (cls ? ' ' + cls : '');
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/* 图标型操作：与文字按钮同规格，但用 SVG 图形，语义一眼可辨且不占宽度 */
const TD_ICONS = {
  pin:
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>' +
    '</svg>',
  trash:
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
    '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
    '<path d="M10 11v6"/><path d="M14 11v6"/>' +
    '</svg>'
};

function tdIcon(name, cls, title, onClick) {
  const b = document.createElement('button');
  b.className = 'td-ico' + (cls ? ' ' + cls : '');
  b.innerHTML = TD_ICONS[name] || '';
  if (title) b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return b;
}

/*
 * 一个分组 = 一行：标题/计数 · 时间 …… 恢复 展开 回收站
 * 命名组在标题显示名称、计数并入时间位；未命名组标题直接是「N tabs」。
 */
function tdBuildGroup(group) {
  const box = document.createElement('div');
  box.className = 'td-group';

  const head = document.createElement('div');
  head.className = 'td-ghead';

  const name = tdTitleOf(group);
  const title = document.createElement('div');
  title.className = 'td-gtitle';
  title.textContent = name;
  title.title = name;
  // 置顶由行尾的图钉按钮表达（可点击切换），这里只标星标 / 锁定
  if (group.star || group.locked) {
    const tag = document.createElement('span');
    tag.className = 'td-gtag';
    tag.textContent = group.star ? '★' : 'Locked';
    title.appendChild(tag);
  }
  head.appendChild(title);

  const metaParts = [];
  if (String(group.name || '').trim()) metaParts.push(tdCountLabel(group.tabs.length));
  metaParts.push(tdRelative(group.ts));
  const meta = document.createElement('div');
  meta.className = 'td-gmeta';
  meta.textContent = metaParts.join(' · ');
  head.appendChild(meta);

  const acts = document.createElement('div');
  acts.className = 'td-gacts';

  acts.appendChild(
    tdTxt(
      'Restore',
      'primary',
      'Open every page in this group' + (group.locked ? ' (locked: group is kept)' : ', then remove it from the list'),
      async () => {
        try {
          const r = await tdOpenTabs(group.tabs, 'this');
          if (!r.opened) {
            tdStatus(r.failed ? 'Chrome refused to open these pages' : 'No page to restore');
            return;
          }
          if (!group.locked) tdState.groups = tdState.groups.filter((g) => g.id !== group.id);
          await tdPersist();
          tdStatus(
            'Restored ' + r.opened + ' tab' + (r.opened === 1 ? '' : 's') +
              (r.failed ? ' · ' + r.failed + ' blocked' : '') +
              (group.locked ? ' (locked — group kept)' : '')
          );
        } catch (e) {
          tdStatus('Failed to open: ' + (e && e.message ? e.message : e));
        }
      }
    )
  );

  const expanded = tdExpanded.has(group.id);

  /* 置顶：钉住/取消，置顶组由 tdGroupsFor 统一排到列表最前 */
  acts.appendChild(
    tdIcon('pin', group.pinned ? 'on' : '', group.pinned ? 'Unpin' : 'Pin to top', async () => {
      group.pinned = !group.pinned;
      await tdPersist();
      tdStatus(group.pinned ? 'Pinned to top' : 'Unpinned');
    })
  );

  acts.appendChild(
    tdIcon('trash', 'danger', 'Move to trash (restorable in the manager)', async () => {
      tdMoveToTrash(tdState, group.id);
      await tdPersist();
      tdStatus('Moved to trash');
    })
  );

  /* 展开/折叠只用箭头，不写字；放最右侧，符合「箭头在行尾」的直觉 */
  acts.appendChild(
    tdTxt(expanded ? '▾' : '▸', expanded ? 'on arrow' : 'arrow', expanded ? 'Collapse' : 'Expand ' + group.tabs.length + ' pages', () => {
      if (tdExpanded.has(group.id)) tdExpanded.delete(group.id);
      else tdExpanded.add(group.id);
      tdRender();
    })
  );

  head.appendChild(acts);
  box.appendChild(head);

  if (expanded) {
    const tabs = document.createElement('div');
    tabs.className = 'td-gtabs';
    group.tabs.forEach((tab) => {
      const row = document.createElement('div');
      row.className = 'td-item';
      row.title = tab.title + '\n' + tab.url;
      row.appendChild(tdFavicon(tab));
      const meta = document.createElement('div');
      meta.className = 'td-meta';
      const t = document.createElement('div');
      t.className = 'td-title';
      t.textContent = tab.title || tab.url;
      const u = document.createElement('div');
      u.className = 'td-url';
      u.textContent = tdHostOf(tab.url) || tab.url;
      meta.append(t, u);
      row.appendChild(meta);
      const del = document.createElement('button');
      del.className = 'td-del';
      del.textContent = '✕';
      del.title = 'Remove from this group (without opening)';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        tdRemoveTab(tdState, group.id, tab.url);
        await tdPersist();
        tdStatus('Removed 1 page');
      });
      row.appendChild(del);

      row.addEventListener('click', async () => {
        await tdOpenOne(tdState, group.id, tab.url);
        await tdPersist();
        tdStatus('Opened 1 tab');
      });
      tabs.appendChild(row);
    });
    box.appendChild(tabs);
  }

  return box;
}

/* ---------- 模式切换 ---------- */

function tdSetActive(on) {
  tdActive = on;
  tdEl.view.hidden = !on;
  tdEl.thread.hidden = on;
  tdEl.footer.hidden = on;
  tdEl.navDots.hidden = on; // 收纳模式下隐藏对话历史导航
  tdEl.btn.classList.toggle('active', on);
  if (on) {
    tdLoadState().then((s) => {
      tdState = s;
      tdRender();
    });
  } else {
    tdRender();
    // 退出收纳模式后，恢复对话历史导航（其显隐由 sidepanel 的 renderNavDots 控制）
    if (typeof renderNavDots === 'function') renderNavDots();
  }
}

async function tdCollectCurrentWindow() {
  try {
    let tabs = await chrome.tabs.query({ currentWindow: true });
    if (!tabs.some((t) => tdSavableUrl(t.url))) {
      tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    }
    const items = tdTabsFromBrowser(tabs);
    if (!items.length) {
      tdStatus('No dockable tab in this window');
      return;
    }
    const skipped = tdSkippedCount(tabs, items);
    tdCollect(tdState, items, '');
    await tdPersist();
    const res = await tdCloseBrowserTabs(tabs);
    tdStatus(
      'Docked ' + items.length + ' tabs, closed ' + res.closed + ' to free memory' +
        (skipped ? ' · ' + skipped + ' duplicate(s) skipped' : '')
    );
  } catch (e) {
    tdStatus('Dock failed: ' + (e && e.message ? e.message : e));
  }
}

function tdOpenManager() {
  chrome.tabs.create({ url: chrome.runtime.getURL('tabdock.html') }).catch(() => {});
}

/* ---------- 导入 / 导出 ---------- */

function tdExport() {
  const text = tdExportText(tdState);
  if (!text.trim()) {
    tdStatus('Nothing to export');
    return;
  }
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  a.href = URL.createObjectURL(blob);
  a.download = 'tabdock-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  tdStatus('Exported ' + tdState.groups.length + ' group(s)');
}

function tdImport(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    const groups = tdParseImport(String(reader.result || ''));
    if (!groups.length) {
      tdStatus('No importable link found');
      return;
    }
    const total = groups.reduce((n, g) => n + g.tabs.length, 0);
    groups.slice().reverse().forEach((g) => tdState.groups.unshift(g));
    await tdPersist();
    tdStatus('Imported ' + groups.length + ' group(s) / ' + total + ' link(s)');
  };
  reader.readAsText(file);
}

/* ---------- 事件绑定 ---------- */

if (tdEl.btn) {
  tdEl.btn.addEventListener('click', () => tdSetActive(!tdActive));
  tdEl.collect.addEventListener('click', tdCollectCurrentWindow);
  tdEl.openPage.addEventListener('click', tdOpenManager);
  if (tdEl.expandAll) tdEl.expandAll.addEventListener('click', tdToggleExpandAll);
  tdEl.importBtn.addEventListener('click', () => tdEl.file.click());
  tdEl.exportBtn.addEventListener('click', tdExport);
  tdEl.file.addEventListener('change', () => {
    if (tdEl.file.files && tdEl.file.files[0]) tdImport(tdEl.file.files[0]);
    tdEl.file.value = '';
  });

  /* 跨端同步：管理页 / 右键菜单改动后，侧栏正在展示时即时刷新 */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[TABDOCK_KEY]) return;
    if (Date.now() - tdSelfSaveAt < 350) return;
    tdLoadState().then((s) => {
      tdState = s;
      if (tdActive) tdRender();
    });
  });

  tdLoadState().then((s) => {
    tdState = s;
  });
}
