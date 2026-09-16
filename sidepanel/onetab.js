'use strict';

/*
 * 学习助手 · OneTab 侧栏入口
 * 侧栏定位是「随手收纳」：一键把当前窗口的标签收进来并关闭以释放内存。
 * 完整管理（分类计数 / 回收站 / 拖动归类 / ⋮ 更多菜单）在 onetab.html 管理页里。
 * 数据层与页面、Service Worker 共用 onetab-store.js。
 */

const otEl = {
  btn: document.getElementById('btn-onetab'),
  view: document.getElementById('onetab-view'),
  list: document.getElementById('ot-list'),
  empty: document.getElementById('ot-empty'),
  collect: document.getElementById('ot-collect'),
  openPage: document.getElementById('ot-open-page'),
  importBtn: document.getElementById('ot-import'),
  exportBtn: document.getElementById('ot-export'),
  file: document.getElementById('ot-file'),
  status: document.getElementById('ot-status'),
  thread: document.getElementById('thread'),
  footer: document.getElementById('footer-bar'),
  navDots: document.getElementById('nav-dots')
};

const OT_SIDE_LIMIT = 20;

let otActive = false;
let otState = otEmptyState();
let otStatusTimer = null;
let otExpanded = new Set();
let otSelfSaveAt = 0;

/* 收纳面板内的轻量状态提示（footer 在收纳模式下隐藏，故用面板内独立提示） */
function otStatus(text) {
  if (!otEl.status) return;
  otEl.status.textContent = text || '';
  otEl.status.hidden = !text;
  clearTimeout(otStatusTimer);
  if (text) {
    otStatusTimer = setTimeout(() => {
      otEl.status.hidden = true;
      otEl.status.textContent = '';
    }, 2400);
  }
}

async function otPersist() {
  otSelfSaveAt = Date.now();
  await otSaveState(otState);
  otRender();
}

function otHostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function otFavicon(tab) {
  const box = document.createElement('div');
  box.className = 'ot-fav';
  const fallback = () => {
    box.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = (otHostOf(tab.url) || '·').charAt(0).toUpperCase();
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

function otVisibleGroups() {
  return otGroupsFor(otState, 'all', {}).filter((g) => !g.archived);
}

function otRender() {
  if (!otEl.list) return;
  otEl.list.innerHTML = '';
  const groups = otVisibleGroups();

  if (!groups.length) {
    otEl.empty.hidden = false;
    otEl.list.hidden = true;
    return;
  }
  otEl.empty.hidden = true;
  otEl.list.hidden = false;

  const shown = groups.slice(0, OT_SIDE_LIMIT);
  shown.forEach((group) => otEl.list.appendChild(otBuildGroup(group)));

  if (groups.length > shown.length || otState.trash.length) {
    const hint = document.createElement('div');
    hint.className = 'ot-hint';
    const more = groups.length - shown.length;
    const parts = [];
    if (more > 0) parts.push('还有 ' + more + ' 个分组');
    if (otState.trash.length) parts.push('回收站 ' + otState.trash.length + ' 项');
    hint.textContent = parts.join(' · ') + ' — 打开管理页查看';
    otEl.list.appendChild(hint);
  }
}

/* 文字型操作：无边框无底色，hover 才着色 */
function otTxt(label, cls, title, onClick) {
  const b = document.createElement('button');
  b.className = 'ot-txt' + (cls ? ' ' + cls : '');
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/*
 * 一个分组 = 一行：标题/计数 · 时间 …… 恢复 展开 回收站
 * 命名组在标题显示名称、计数并入时间位；未命名组标题直接是「N tabs」。
 */
function otBuildGroup(group) {
  const box = document.createElement('div');
  box.className = 'ot-group';

  const head = document.createElement('div');
  head.className = 'ot-ghead';

  const name = otTitleOf(group);
  const title = document.createElement('div');
  title.className = 'ot-gtitle';
  title.textContent = name;
  title.title = name;
  if (group.pinned || group.star || group.locked) {
    const tag = document.createElement('span');
    tag.className = 'ot-gtag';
    tag.textContent = group.pinned ? '置顶' : group.star ? '★' : '锁定';
    title.appendChild(tag);
  }
  head.appendChild(title);

  const metaParts = [];
  if (String(group.name || '').trim()) metaParts.push(otCountLabel(group.tabs.length));
  metaParts.push(otRelative(group.ts));
  const meta = document.createElement('div');
  meta.className = 'ot-gmeta';
  meta.textContent = metaParts.join(' · ');
  head.appendChild(meta);

  const acts = document.createElement('div');
  acts.className = 'ot-gacts';

  acts.appendChild(
    otTxt(
      '恢复',
      'primary',
      '打开本组全部标签' + (group.locked ? '（已锁定：本组保留）' : '，并从列表移除'),
      async () => {
        try {
          const n = await otOpenTabs(group.tabs, 'this');
          if (!n) {
            otStatus('没有可恢复的网页');
            return;
          }
          if (!group.locked) otState.groups = otState.groups.filter((g) => g.id !== group.id);
          await otPersist();
          otStatus('已恢复 ' + n + ' 个标签' + (group.locked ? '（已锁定，保留本组）' : ''));
        } catch (e) {
          otStatus('打开失败：' + (e && e.message ? e.message : e));
        }
      }
    )
  );

  const expanded = otExpanded.has(group.id);
  acts.appendChild(
    otTxt(expanded ? '收起' : '展开', expanded ? 'on' : '', expanded ? '收起链接' : '展开 ' + group.tabs.length + ' 个链接', () => {
      if (otExpanded.has(group.id)) otExpanded.delete(group.id);
      else otExpanded.add(group.id);
      otRender();
    })
  );

  acts.appendChild(
    otTxt('回收站', 'danger', '移到回收站（管理页可恢复）', async () => {
      otMoveToTrash(otState, group.id);
      await otPersist();
      otStatus('已移到回收站');
    })
  );

  head.appendChild(acts);
  box.appendChild(head);

  if (expanded) {
    const tabs = document.createElement('div');
    tabs.className = 'ot-gtabs';
    group.tabs.forEach((tab) => {
      const row = document.createElement('div');
      row.className = 'ot-item';
      row.title = tab.title + '\n' + tab.url;
      row.appendChild(otFavicon(tab));
      const meta = document.createElement('div');
      meta.className = 'ot-meta';
      const t = document.createElement('div');
      t.className = 'ot-title';
      t.textContent = tab.title || tab.url;
      const u = document.createElement('div');
      u.className = 'ot-url';
      u.textContent = otHostOf(tab.url) || tab.url;
      meta.append(t, u);
      row.appendChild(meta);
      row.addEventListener('click', async () => {
        await otOpenOne(otState, group.id, tab.url);
        await otPersist();
        otStatus('已打开 1 个标签');
      });
      tabs.appendChild(row);
    });
    box.appendChild(tabs);
  }

  return box;
}

/* ---------- 模式切换 ---------- */

function otSetActive(on) {
  otActive = on;
  otEl.view.hidden = !on;
  otEl.thread.hidden = on;
  otEl.footer.hidden = on;
  otEl.navDots.hidden = on; // 收纳模式下隐藏对话历史导航
  otEl.btn.classList.toggle('active', on);
  if (on) {
    otLoadState().then((s) => {
      otState = s;
      otRender();
    });
  } else {
    otRender();
    // 退出收纳模式后，恢复对话历史导航（其显隐由 sidepanel 的 renderNavDots 控制）
    if (typeof renderNavDots === 'function') renderNavDots();
  }
}

async function otCollectCurrentWindow() {
  try {
    let tabs = await chrome.tabs.query({ currentWindow: true });
    if (!tabs.some((t) => otSavableUrl(t.url))) {
      tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    }
    const items = otTabsFromBrowser(tabs);
    if (!items.length) {
      otStatus('当前窗口没有可收集的网页标签');
      return;
    }
    otCollect(otState, items, '');
    await otPersist();
    const res = await otCloseBrowserTabs(tabs);
    otStatus('已收入 ' + items.length + ' 个标签，关闭 ' + res.closed + ' 个以释放内存');
  } catch (e) {
    otStatus('收纳失败：' + (e && e.message ? e.message : e));
  }
}

function otOpenManager() {
  chrome.tabs.create({ url: chrome.runtime.getURL('onetab.html') }).catch(() => {});
}

/* ---------- 导入 / 导出 ---------- */

function otExport() {
  const text = otExportText(otState);
  if (!text.trim()) {
    otStatus('列表为空，没有可导出的内容');
    return;
  }
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  a.href = URL.createObjectURL(blob);
  a.download = 'onetab-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  otStatus('已导出 ' + otState.groups.length + ' 个分组');
}

function otImport(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    const groups = otParseImport(String(reader.result || ''));
    if (!groups.length) {
      otStatus('没有解析到可导入的链接');
      return;
    }
    const total = groups.reduce((n, g) => n + g.tabs.length, 0);
    groups.slice().reverse().forEach((g) => otState.groups.unshift(g));
    await otPersist();
    otStatus('已导入 ' + groups.length + ' 个分组 / ' + total + ' 个链接');
  };
  reader.readAsText(file);
}

/* ---------- 事件绑定 ---------- */

if (otEl.btn) {
  otEl.btn.addEventListener('click', () => otSetActive(!otActive));
  otEl.collect.addEventListener('click', otCollectCurrentWindow);
  otEl.openPage.addEventListener('click', otOpenManager);
  otEl.importBtn.addEventListener('click', () => otEl.file.click());
  otEl.exportBtn.addEventListener('click', otExport);
  otEl.file.addEventListener('change', () => {
    if (otEl.file.files && otEl.file.files[0]) otImport(otEl.file.files[0]);
    otEl.file.value = '';
  });

  /* 跨端同步：管理页 / 右键菜单改动后，侧栏正在展示时即时刷新 */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[ONETAB_KEY]) return;
    if (Date.now() - otSelfSaveAt < 350) return;
    otLoadState().then((s) => {
      otState = s;
      if (otActive) otRender();
    });
  });

  otLoadState().then((s) => {
    otState = s;
  });
}
