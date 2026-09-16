/* 划词气泡的 SW 侧自测：在 vm 里真实加载 common.js + tabdock-store.js + background.js，
 * 调 chrome.runtime.onMessage 里注册的监听器，检查落到 storage.session 的任务体与 open 调用。
 * 用法：node tools/test_background_ask.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

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

/** 造一个扩展运行环境：chrome stub + 记录调用 */
function makeSW({ prompts } = {}) {
  const store = {
    session: {},
    local: {}
  };
  const calls = { sidePanelOpen: [], sessionSet: [], tabsCreate: [] };
  const listeners = { message: [], installed: [], startup: [], menuClicked: [], storageChanged: [] };

  const p = () => Promise.resolve();

  const chrome = {
    storage: {
      session: {
        setAccessLevel: p,
        get: async (k) => (Array.isArray(k) ? pick(store.session, k) : { [k]: store.session[k] }),
        set: async (obj) => {
          calls.sessionSet.push(obj);
          Object.assign(store.session, obj);
        }
      },
      local: {
        get: async (k) => (Array.isArray(k) ? pick(store.local, k) : { [k]: store.local[k] }),
        set: async (obj) => Object.assign(store.local, obj)
      },
      onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) }
    },
    sidePanel: {
      setPanelBehavior: p,
      open: async (arg) => {
        calls.sidePanelOpen.push(arg);
      }
    },
    runtime: {
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      openOptionsPage: async () => {},
      getURL: (s) => 'chrome-extension://test/' + s,
      sendMessage: async () => {},
      lastError: undefined
    },
    contextMenus: {
      removeAll: async () => {},
      create: (opt, cb) => cb && cb(),
      onClicked: { addListener: (fn) => listeners.menuClicked.push(fn) }
    },
    action: { onClicked: { addListener: () => {} } },
    tabs: {
      query: async () => [],
      get: async () => ({}),
      create: async (o) => {
        calls.tabsCreate.push(o);
      },
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} }
    },
    scripting: { executeScript: async () => [] }
  };

  const sandbox = {
    chrome,
    console: { log: () => {}, error: () => {}, warn: () => {} },
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2, 10) },
    importScripts: () => {}, // 三个文件在同一个 context 里按顺序 eval，不需要真的 import
    setTimeout,
    clearTimeout,
    fetch: async () => {
      throw new Error('no network in test');
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const ctx = vm.createContext(sandbox);

  store.local.settings = {
    api: { baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-test', model: 'deepseek-flash', temperature: 0.3, stream: true },
    prompts:
      prompts ||
      [
        { id: 'p1', label: 'Summarize in 3 lines', template: '用三句话说清「{{text}}」是什么。', order: 1, enabled: true },
        { id: 'p2', label: 'Find an analogy', template: '「{{text}}」和哪个概念最接近？', order: 2, enabled: true },
        { id: 'p4', label: 'Off', template: 'x', order: 4, enabled: false }
      ],
    ui: {}
  };

  vm.runInContext(read('common.js'), ctx, { filename: 'common.js' });
  vm.runInContext(read('tabdock-store.js'), ctx, { filename: 'tabdock-store.js' });
  vm.runInContext(read('background.js'), ctx, { filename: 'background.js' });

  return { chrome, store, calls, listeners, ctx };
}

function pick(obj, keys) {
  const out = {};
  keys.forEach((k) => (out[k] = obj[k]));
  return out;
}

/** 模拟 content script 发消息：调监听器并等 sendResponse */
function sendMessage(listeners, msg, sender) {
  return new Promise((resolve) => {
    let done = false;
    const respond = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    listeners.message.forEach((fn) => {
      const keepAlive = fn(msg, sender, respond);
      if (keepAlive !== true && !done) respond(undefined);
    });
    setTimeout(() => respond(undefined), 500);
  });
}

(async function run() {
  console.log('\n=== A. 点预设 → 任务体正确 ===');
  {
    const sw = makeSW();
    const res = await sendMessage(
      sw.listeners,
      { type: 'ask-selection', text: 'transfer learning', promptId: 'p1', custom: false },
      { tab: { id: 7, title: 'A page', url: 'https://example.com/a' } }
    );
    await new Promise((r) => setTimeout(r, 30));

    ok('响应 ok', res && res.ok === true, JSON.stringify(res));
    ok('调用了 sidePanel.open 且指向该标签页', sw.calls.sidePanelOpen.length === 1 && sw.calls.sidePanelOpen[0].tabId === 7, JSON.stringify(sw.calls.sidePanelOpen));

    const task = sw.store.session.task;
    ok('任务已写入 storage.session', !!task);
    ok('type = preset', task && task.type === 'preset', task && task.type);
    ok('label 取的是该预设的英文 label', task && task.label === 'Summarize in 3 lines', task && task.label);
    ok('template 取的是该预设的中文模板', task && task.template === '用三句话说清「{{text}}」是什么。', task && task.template);
    ok('vars.text 是选中的文字', task && task.vars && task.vars.text === 'transfer learning', JSON.stringify(task && task.vars));
    ok('vars 带上标题与网址', task && task.vars.title === 'A page' && task.vars.url === 'https://example.com/a');
    ok('taskId / tabId / createdAt 齐备', !!(task && task.taskId && task.tabId === 7 && task.createdAt));
    ok('只写了一次任务（不重复派发）', sw.calls.sessionSet.filter((o) => o.task).length === 1);
  }

  console.log('\n=== B. 点 Custom question… ===');
  {
    const sw = makeSW();
    const res = await sendMessage(
      sw.listeners,
      { type: 'ask-selection', text: 'hello', promptId: '', custom: true },
      { tab: { id: 3, title: 'T', url: 'https://e.com' } }
    );
    await new Promise((r) => setTimeout(r, 30));
    const task = sw.store.session.task;
    ok('响应 ok', res && res.ok === true);
    ok('type = custom', task && task.type === 'custom', task && task.type);
    ok('label = Custom question', task && task.label === 'Custom question', task && task.label);
    ok('custom 不生成 template（由侧边栏输入框接管）', task && task.template === undefined, JSON.stringify(task && task.template));
  }

  console.log('\n=== C. 已禁用的预设不能被触发 ===');
  {
    const sw = makeSW();
    const res = await sendMessage(
      sw.listeners,
      { type: 'ask-selection', text: 'x', promptId: 'p4' },
      { tab: { id: 1, title: 'T', url: 'https://e.com' } }
    );
    await new Promise((r) => setTimeout(r, 30));
    ok('禁用项被拒（与右键菜单过滤一致）', res && res.ok === false, JSON.stringify(res));
    ok('不写任务', !sw.store.session.task);
  }

  console.log('\n=== D. 未知预设 id → 明确报错、不派发任务 ===');
  {
    const sw = makeSW();
    const res = await sendMessage(
      sw.listeners,
      { type: 'ask-selection', text: 'x', promptId: 'nope' },
      { tab: { id: 1, title: 'T', url: 'https://e.com' } }
    );
    await new Promise((r) => setTimeout(r, 30));
    ok('ok=false 且带原因', res && res.ok === false && /preset/i.test(res.error || ''), JSON.stringify(res));
    ok('不写任务', !sw.store.session.task);
  }

  console.log('\n=== E. 空选区 / 无标签页 ===');
  {
    const sw = makeSW();
    const res = await sendMessage(sw.listeners, { type: 'ask-selection', text: '   ', promptId: 'p1' }, { tab: { id: 1 } });
    await new Promise((r) => setTimeout(r, 30));
    ok('空选区直接拒绝', res && res.ok === false, JSON.stringify(res));
  }
  {
    const sw = makeSW();
    const res = await sendMessage(sw.listeners, { type: 'ask-selection', text: 'x', promptId: 'p1' }, {});
    await new Promise((r) => setTimeout(r, 30));
    ok('没有发送方标签页时拒绝', res && res.ok === false, JSON.stringify(res));
  }

  console.log('\n=== F. 侧边栏被拦时不崩，任务仍然留下 ===');
  {
    const sw = makeSW();
    sw.chrome.sidePanel.open = async () => {
      throw new Error('may only be called in response to a user gesture');
    };
    const res = await sendMessage(
      sw.listeners,
      { type: 'ask-selection', text: 'x', promptId: 'p1' },
      { tab: { id: 5, title: 'T', url: 'https://e.com' } }
    );
    await new Promise((r) => setTimeout(r, 30));
    ok('仍然返回 ok（任务可被侧栏 catchUp 消费）', res && res.ok === true, JSON.stringify(res));
    ok('opened=false 供气泡提示用户', res && res.opened === false, JSON.stringify(res));
    ok('任务照样写入了', !!sw.store.session.task);
  }

  console.log('\n=== G. open-options 消息 ===');
  {
    const sw = makeSW();
    let opened = false;
    sw.chrome.runtime.openOptionsPage = async () => {
      opened = true;
    };
    await sendMessage(sw.listeners, { type: 'open-options' }, {});
    await new Promise((r) => setTimeout(r, 20));
    ok('打开设置页', opened);
  }

  console.log('\n=== H. 右键菜单链路未被破坏 ===');
  {
    const sw = makeSW();
    await new Promise((r) => setTimeout(r, 30));
    const onClicked = sw.listeners.menuClicked[0];
    ok('onClicked 监听器已注册', typeof onClicked === 'function');
    onClicked({ menuItemId: 'prompt:p1' }, { id: 11, title: 'T', url: 'https://e.com' });
    await new Promise((r) => setTimeout(r, 40));
    const task = sw.store.session.task;
    ok('右键选预设仍然派发 preset 任务', task && task.type === 'preset' && task.label === 'Summarize in 3 lines', JSON.stringify(task));
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
  process.exit(fail ? 1 : 0);
})();
