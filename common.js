'use strict';

/*
 * 学习助手 · 公共模块
 * 被 background.js（importScripts）、sidepanel 与 options 页面（<script>）共享。
 * 注意：不能引用页面专属 API（document / marked 等）。
 */

const TASK_KEY = 'task';            // storage.session：最新任务
const THREAD_KEY = 'thread';        // storage.session：会话历史（仅浏览器会话内）
const MARKER_KEY = 'processedTaskId'; // storage.session：面板已消费的任务标记
const CTX_KEY = 'pageCtx';          // storage.session：最近捕获的页面上下文（自由提问用）
const IMG_KEY = 'imageControl';     // storage.local：图片控制配置 { mode }
const AD_KEY = 'adBlock';           // storage.local：免广告配置 { enabled }
const SETTINGS_BK_KEY = 'settingsBackup'; // storage.local：API 配置防丢备份（见 getMergedSettings）

/** 「解读当前页面」内置提示词（页面正文由 system 注入） */
const PAGE_SUMMARY_PROMPT =
  '请解读当前页面。先用一两句话说清这是什么页面、主题是什么；再分要点概括核心内容；最后列出 3–5 个读者可能想进一步了解的方向。用与页面相同的语言回答，善用 Markdown。';

/** 内置模型清单（侧边栏切换用，显示官方模型名；cap 标记能力，vision=支持图片） */
const MODEL_CATALOG = [
  { id: 'deepseek-flash', cap: 'vision' },
  { id: 'deepseek-v4-pro', cap: 'text' }
];

/** 已退役的模型别名 → 官方现名（视觉已并入 Flash，旧 vision-exp 同样并入） */
const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash'
};

/** 旧模型名归一化：避免已退役别名出现在模型选择器或请求里 */
function normalizeModel(name) {
  const trimmed = String(name || '').trim();
  return MODEL_ALIASES[trimmed.toLowerCase()] || trimmed;
}

const DEFAULT_SETTINGS = {
  api: {
    baseURL: '',
    apiKey: '',
    model: '',
    visionModel: '',
    temperature: 0.3,
    stream: true
  },
  prompts: [
    {
      id: 'p1',
      label: 'Summarize in 3 lines',
      template: '用三句话说清「{{text}}」是什么、为什么有人关心它。不要展开。',
      order: 1,
      enabled: true
    },
    {
      id: 'p2',
      label: 'Find an analogy',
      template: '「{{text}}」和我可能已经知道的哪个概念最接近？只讲区别。',
      order: 2,
      enabled: true
    },
    {
      id: 'p3',
      label: 'Why it matters',
      template: '「{{text}}」是为了解决什么问题出现的？之前人们怎么处理？',
      order: 3,
      enabled: true
    },
    {
      id: 'p4',
      label: 'Explain for a newcomer',
      template: '解释「{{text}}」，假设我是刚入行的外行，避免使用该领域术语；必须用到的要当场解释。',
      order: 4,
      enabled: true
    }
  ],
  ui: {
    sidebarScope: 'global',
    keepHistory: false,
    maxHistory: 50
  }
};

/** 读取 storage.local 的 settings 并与默认值合并（缺字段补全） */
function mergeSettings(saved) {
  const s = saved || {};
  const prompts =
    Array.isArray(s.prompts) && s.prompts.length
      ? s.prompts.map((p, i) => ({
          id: p.id || 'p' + (i + 1) + '-' + Math.random().toString(36).slice(2, 8),
          label: String(p.label || 'Question ' + (i + 1)),
          template: String(p.template || ''),
          order: Number.isFinite(p.order) ? p.order : i + 1,
          enabled: p.enabled !== false
        }))
      : DEFAULT_SETTINGS.prompts.map((p) => ({ ...p }));
  const api = { ...DEFAULT_SETTINGS.api, ...(s.api || {}) };
  // 模型名归一化：读取时就把退役别名映射到官方现名（选择器与请求都用新名）
  api.model = normalizeModel(api.model);
  api.visionModel = normalizeModel(api.visionModel);
  return {
    api,
    prompts,
    ui: { ...DEFAULT_SETTINGS.ui, ...(s.ui || {}) }
  };
}

/**
 * 配置读写入口（带「防丢」备份）：
 * 每次保存带 apiKey 的配置时，额外写一份 settingsBackup；
 * 读取时若发现 settings 整条记录不存在（扩展重装 / 存储被清 / 换了扩展 ID 导致命名空间变化），
 * 但备份还在，就自动恢复，避免用户重新填一遍 baseURL / Key / model。
 *
 * 注意：只在 settings **完全缺失**时才恢复。用户主动清空 Key 保存时 settings 仍存在
 * （只是字段为空），不会触发恢复，否则就永远清不掉了。
 */
/** 上一次读取是否由备份恢复（供 UI 提示「已自动找回配置」） */
let settingsRestoredFromBackup = false;
function wasSettingsRestored() {
  return settingsRestoredFromBackup;
}

async function getMergedSettings() {
  settingsRestoredFromBackup = false;
  const res = await chrome.storage.local.get(['settings', SETTINGS_BK_KEY]);
  let saved = res.settings;
  if (!saved) {
    const bk = res[SETTINGS_BK_KEY];
    if (bk && bk.api) {
      saved = bk;
      settingsRestoredFromBackup = true;
      await chrome.storage.local.set({ settings: saved });
    }
  }
  return mergeSettings(saved);
}

/** 保存完整 settings（options 页用，保证三个分区同时落盘） */
async function saveSettings(settings) {
  const api = settings && settings.api;
  // 只备份「有效配置」，避免用空配置把好备份冲掉
  if (api && api.apiKey) {
    await chrome.storage.local.set({ [SETTINGS_BK_KEY]: settings });
  }
  await chrome.storage.local.set({ settings });
}

/**
 * baseURL 归一化：
 * - 已以 /chat/completions 结尾 → 原样
 * - 路径以版本段结尾（/v1 /v2 /v1beta…）→ 补 /chat/completions
 * - 其他（裸域名、自定义网关路径）→ 补 /v1/chat/completions
 */
function normalizeChatURL(base) {
  const u = String(base || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v\d+[a-z]*$/i.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

/** 模板占位符渲染：{{text}} {{title}} {{url}} {{lang}} */
function renderTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => {
    if (key === 'lang') return (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN';
    return vars && key in vars ? vars[key] : m;
  });
}

function truncateText(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/**
 * OpenAI 兼容 chat/completions 调用（支持 SSE 流式）。
 * @param {object} opts { api, messages, signal, onDelta, extraBody }
 * @param {function(string):void} opts.onDelta 增量回调
 */
async function callOpenAICompatible({ api, messages, signal, onDelta, extraBody }) {
  const url = normalizeChatURL(api.baseURL);
  if (!url) throw new Error('API not configured (baseURL is empty)');

  const headers = { 'Content-Type': 'application/json' };
  if (api.apiKey) headers['Authorization'] = 'Bearer ' + api.apiKey;
  // Anthropic 直连浏览器的放行头（完整 Anthropic 协议支持在后续版本）
  if (/anthropic\.com/i.test(url)) {
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  const stream = api.stream !== false;
  const body = {
    model: api.model,
    messages,
    temperature: api.temperature,
    stream
  };
  if (extraBody) Object.assign(body, extraBody);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    try {
      err.body = (await res.text()).slice(0, 500);
    } catch {}
    throw err;
  }

  if (!stream) {
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    if (content) onDelta(String(content));
    return;
  }

  // SSE 流式解析
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // 跳过注释行 / 空行 / 事件名行
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const choice = json.choices && json.choices[0];
        const delta = choice ? (choice.delta ? choice.delta.content : choice.message ? choice.message.content : '') : '';
        if (typeof delta === 'string' && delta) onDelta(delta);
        else if (Array.isArray(delta)) onDelta(delta.map((x) => x.text || '').join(''));
      } catch {
        // 非 JSON 行（个别网关的心跳/提示），忽略
      }
    }
  }
}

/** Map fetch/HTTP errors to actionable messages (UI text: English) */
function describeAPIError(err, timedOut) {
  if (timedOut || err?.name === 'TimeoutError') {
    return 'Timed out: no response in 30s. Check that baseURL is reachable, then retry.';
  }
  if (err?.status === 400) {
    return 'Bad request (400): ' + (err.body || 'Check the model name and parameters.');
  }
  if (err?.status === 401) {
    return 'Unauthorized (401): the API key was rejected. Check the key in Settings.';
  }
  if (err?.status === 402) {
    // 余额不足 ≠ 配置丢失：Key 与 baseURL 都还在，充值后即可直接继续用，无需重新配置
    return (
      'Insufficient balance (402): your API key and settings are still saved — ' +
      'top up your account and ask again, no need to reconfigure.' +
      (err.body ? '\n' + err.body : '')
    );
  }
  if (err?.status === 403) {
    return 'Forbidden (403): the key has no access to this model.';
  }
  if (err?.status === 404) {
    return 'Endpoint not found (404). Check baseURL (usually ends with /v1) — use “Test connection” in Settings to see the final URL.';
  }
  if (err?.status === 429) {
    return 'Rate limited or quota exceeded (429). Try again later.';
  }
  if (err?.status >= 500) {
    return 'Server error (' + err.status + '), please retry later.' + (err.body ? '\n' + err.body : '');
  }
  if (err instanceof TypeError || /fetch|network|failed/i.test(err?.message || '')) {
    return 'Network request failed: offline, baseURL unreachable, or the origin permission was not granted (click “Allow” when saving in Settings).';
  }
  return 'Request failed: ' + (err?.message || String(err));
}
