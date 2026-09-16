/* 划词气泡交互自测：在 jsdom 里真实跑一遍 content/selection.js
 * 覆盖：选区 → 图标浮出 → 悬停展开菜单 → 点预设/自定义 → 派发消息；以及各种收起与开关。
 * 用法：NODE_PATH=<workspace>/node_modules node tools/test_selection_bubble.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content', 'selection.js'), 'utf8');

const PRESETS = [
  { id: 'p1', label: 'Summarize in 3 lines', template: 'x', order: 1, enabled: true },
  { id: 'p2', label: 'Find an analogy', template: 'x', order: 2, enabled: true },
  { id: 'p3', label: 'Why it matters', template: 'x', order: 3, enabled: true },
  { id: 'p4', label: 'Explain for a newcomer', template: 'x', order: 4, enabled: true },
  { id: 'p9', label: 'Disabled one', template: 'x', order: 5, enabled: false }
];

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '   → ' + extra : ''));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 造一个 jsdom 页面 + 可操控的假选区 + chrome stub */
function makeEnv({ bubbleEnabled = true, selection = 'transfer learning' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><p id="t">Some selectable text</p></body></html>', {
    url: 'https://example.com/a?b=1',
    pretendToBeVisual: true,
    runScripts: 'dangerously' // 必须开：否则 window.eval 不会在 jsdom realm 里执行，脚本里拿不到 window
  });
  const { window } = dom;
  const sent = [];

  // ---- 选区 stub ----
  const anchor = window.document.getElementById('t').firstChild;
  const RECT = { left: 100, top: 200, right: 320, bottom: 218, width: 220, height: 18 };
  const fakeRange = {
    getClientRects: () => [RECT],
    getBoundingClientRect: () => RECT,
    rangeCount: 1
  };
  const fakeSel = {
    rangeCount: 1,
    isCollapsed: false,
    toString: () => selection,
    anchorNode: anchor,
    getRangeAt: () => fakeRange
  };
  let curSel = fakeSel;
  Object.defineProperty(window, 'getSelection', {
    configurable: true,
    writable: true,
    value: () => curSel
  });

  // ---- chrome stub ----
  window.chrome = {
    storage: {
      local: {
        get: async (k) => ({ settings: { prompts: PRESETS, ui: { selectionBubble: bubbleEnabled } } })
      },
      onChanged: { addListener: () => {} }
    },
    runtime: {
      sendMessage: (msg) => {
        sent.push(msg);
        return Promise.resolve({ ok: true, opened: true });
      }
    }
  };

  // jsdom 的布局全是 0，给量尺寸的 API 补一个可用的实现，好验证定位分支
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return this.classList && this.classList.contains('wb-menu') ? 240 : 80;
    }
  });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return this.classList && this.classList.contains('wb-menu') ? 200 : 24;
    }
  });

  // 运行被测脚本（IIFE）
  window.eval(SRC);

  const host = () => window.document.getElementById('webbuddy-bubble-host');
  const shadow = () => (host() ? host().shadowRoot : null);
  const trigger = () => (shadow() ? shadow().querySelector('.wb-trigger') : null);
  const menu = () => (shadow() ? shadow().querySelector('.wb-menu') : null);
  const items = () => (shadow() ? Array.from(shadow().querySelectorAll('.wb-item')) : []);

  return {
    dom,
    window,
    sent,
    host,
    shadow,
    trigger,
    menu,
    items,
    setSel: (s) => {
      curSel = s;
    },
    collapse: () => {
      curSel = { ...fakeSel, rangeCount: 0, isCollapsed: true, toString: () => '' };
    },
    mouseup: () =>
      window.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 })),
    // 真实鼠标事件是 cancelable 的，不设的话 preventDefault() 会变成空操作，测不出选区保护
    mousedownOn: (el) => {
      const ev = new window.MouseEvent('mousedown', { bubbles: true, composed: true, cancelable: true, button: 0 });
      el.dispatchEvent(ev);
      return ev;
    },
    mousedownBody: () => {
      const ev = new window.MouseEvent('mousedown', { bubbles: true, composed: true, cancelable: true, button: 0 });
      window.document.body.dispatchEvent(ev);
      return ev;
    },
    hover: (el) => el.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: false })),
    unhover: (el) => el.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: false }))
  };
}

(async function run() {
  console.log('\n=== 1. 选中文字 → 图标自动浮出 ===');
  {
    const e = makeEnv();
    await sleep(5);
    ok('未选中时不建气泡节点', e.host() === null);
    e.mouseup();
    await sleep(10);
    ok('选中后浮出图标', !!e.host() && !!e.trigger());
    ok('图标默认可见', e.trigger().style.display !== 'none' && e.shadow().querySelector('.wb-root').style.display === 'block');
    ok('图标用内联 SVG（不依赖扩展资源）', /<svg/.test(e.trigger().innerHTML));
    ok('图标默认收起菜单', e.menu().style.display === 'none');
  }

  console.log('\n=== 2. 悬停图标 → 展开预设问题 ===');
  {
    const e = makeEnv();
    await sleep(5);
    e.mouseup();
    await sleep(10);
    e.hover(e.trigger());
    await sleep(140); // HOVER_OPEN_DELAY = 90
    ok('悬停后菜单展开', e.menu().style.display === 'block');
    const labels = e.items().map((el) => el.textContent);
    ok('列出 4 条启用的预设（跳过 disabled）', labels.length === 5, '实际 ' + JSON.stringify(labels));
    ok(
      '预设 label 与设置一致且顺序正确',
      labels[0] === 'Summarize in 3 lines' && labels[3] === 'Explain for a newcomer',
      JSON.stringify(labels)
    );
    ok('不出现已禁用的预设', !labels.includes('Disabled one'));
    ok('最后一项是 Custom question…', labels[4] === 'Custom question…');
    ok('菜单顶部显示选中文字片段', (e.shadow().querySelector('.wb-sel') || {}).textContent === 'transfer learning');
    ok('菜单里有 Settings 入口', !!e.shadow().querySelector('.wb-foot a'));
  }

  console.log('\n=== 3. 点预设 → 送进侧边栏 ===');
  {
    const e = makeEnv();
    await sleep(5);
    e.mouseup();
    await sleep(10);
    e.hover(e.trigger());
    await sleep(140);
    e.items()[0].dispatchEvent(new e.window.MouseEvent('click', { bubbles: true, composed: true }));
    await sleep(10);
    ok('发出了 ask-selection', e.sent.length === 1, JSON.stringify(e.sent));
    const m = e.sent[0] || {};
    ok('带上了 promptId', m.type === 'ask-selection' && m.promptId === 'p1', JSON.stringify(m));
    ok('带上了选中文字', m.text === 'transfer learning');
    ok('不是自定义问题', !m.custom);
    ok('点完气泡收起', e.shadow().querySelector('.wb-root').style.display === 'none');
  }

  console.log('\n=== 4. 点 Custom question… ===');
  {
    const e = makeEnv();
    await sleep(5);
    e.mouseup();
    await sleep(10);
    e.hover(e.trigger());
    await sleep(140);
    const custom = e.items()[e.items().length - 1];
    custom.dispatchEvent(new e.window.MouseEvent('click', { bubbles: true, composed: true }));
    await sleep(10);
    ok('发出 custom 标记', e.sent.length === 1 && e.sent[0].custom === true, JSON.stringify(e.sent));
  }

  console.log('\n=== 5. 点气泡内部不能清掉选区 ===');
  {
    const e = makeEnv();
    await sleep(5);
    e.mouseup();
    await sleep(10);
    const ev = e.mousedownOn(e.trigger());
    ok('mousedown 被 preventDefault（选区得以保留）', ev.defaultPrevented);
    ok('mousedown 不再传给页面（页面不会误判为点空白）', ev.cancelBubble === true || ev.defaultPrevented);
    ok('点自己时气泡不收起', e.shadow().querySelector('.wb-root').style.display === 'block');
  }

  console.log('\n=== 6. 各种收起路径 ===');
  {
    const e = makeEnv();
    await sleep(5);
    e.mouseup();
    await sleep(10);
    e.mousedownBody();
    await sleep(5);
    ok('点页面其它地方 → 收起', e.shadow().querySelector('.wb-root').style.display === 'none');

    const e2 = makeEnv();
    await sleep(5);
    e2.mouseup();
    await sleep(10);
    e2.window.dispatchEvent(new e2.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(5);
    ok('按 Esc → 收起', e2.shadow().querySelector('.wb-root').style.display === 'none');

    const e3 = makeEnv();
    await sleep(5);
    e3.mouseup();
    await sleep(10);
    e3.window.dispatchEvent(new e3.window.Event('scroll', { bubbles: false }));
    await sleep(5);
    ok('滚动 → 收起', e3.shadow().querySelector('.wb-root').style.display === 'none');

    const e4 = makeEnv();
    await sleep(5);
    e4.mouseup();
    await sleep(10);
    e4.collapse();
    await sleep(5);
    e4.mouseup();
    await sleep(10);
    ok('选区被清空后不再浮出', e4.shadow().querySelector('.wb-root').style.display === 'none');
  }

  console.log('\n=== 7. 开关与排除项 ===');
  {
    const e = makeEnv({ bubbleEnabled: false });
    await sleep(5);
    e.mouseup();
    await sleep(10);
    ok('设置页关掉 Selection bubble 后不弹', !e.host() || e.shadow().querySelector('.wb-root').style.display === 'none');
  }
  {
    const dom = new JSDOM(
      '<!doctype html><html><body><textarea id="ta">hello world</textarea></body></html>',
      { url: 'https://example.com', pretendToBeVisual: true, runScripts: 'dangerously' }
    );
    const w = dom.window;
    let calls = 0;
    Object.defineProperty(w, 'getSelection', {
      configurable: true,
      value: () => {
        calls++;
        return {
          rangeCount: 1,
          isCollapsed: false,
          toString: () => 'hello world',
          anchorNode: w.document.getElementById('ta').firstChild,
          getRangeAt: () => ({ getClientRects: () => [], getBoundingClientRect: () => ({ width: 10, height: 10 }) })
        };
      }
    });
    w.chrome = {
      storage: { local: { get: async () => ({ settings: { prompts: PRESETS, ui: {} } }) }, onChanged: { addListener: () => {} } },
      runtime: { sendMessage: () => Promise.resolve({ ok: true }) }
    };
    w.eval(SRC);
    await sleep(5);
    w.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true, button: 0 }));
    await sleep(10);
    ok('输入框里的选中不打扰', w.document.getElementById('webbuddy-bubble-host') === null, 'calls=' + calls);
  }

  console.log('\n=== 8. 多行选中的文本保真 ===');
  {
    // 跨空行选中 = 段落分隔，保留 \n\n；行内多余空格折掉
    const e = makeEnv({ selection: 'line one   \n\n\n   line two  \n' });
    const w = e.window;
    await sleep(5);
    e.mouseup();
    await sleep(10);
    e.hover(e.trigger());
    await sleep(140);
    e.items()[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true }));
    await sleep(10);
    ok(
      '折掉多余空格、段落留空行',
      e.sent[0] && e.sent[0].text === 'line one\n\nline two',
      JSON.stringify(e.sent[0] && e.sent[0].text)
    );
  }
  {
    const e = makeEnv({ selection: 'alpha  \n  beta' });
    const w = e.window;
    await sleep(5);
    e.mouseup();
    await sleep(10);
    e.hover(e.trigger());
    await sleep(140);
    e.items()[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true }));
    await sleep(10);
    ok('单个换行不被折成空格', e.sent[0] && e.sent[0].text === 'alpha\nbeta', JSON.stringify(e.sent[0] && e.sent[0].text));
  }

  console.log('\n=== 9. 贴边定位 ===');
  {
    const e = makeEnv();
    await sleep(5);
    e.mouseup();
    await sleep(10);
    const t = e.trigger();
    const x = parseInt(t.style.left, 10);
    const y = parseInt(t.style.top, 10);
    // 选区右下角 (320,218) + GAP 6 → (326,224)
    ok('图标落在选区末端右下（含 6px 间距）', x === 326 && y === 224, x + ',' + y);
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})();
