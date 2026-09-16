# webbuddy（浏览器扩展）

浏览网页时**选中文字 → 右键「问 AI」→ 选预设问题 → 右侧侧边栏流式输出答案**，全程无需手动输入，不打断阅读；也可在侧边栏底部输入框连续追问。同时提供**图片/视频一键隐藏或缩略**、**免广告**、**解读当前页面**、**截图问图**等一站式能力。

Manifest V3 · 无远程代码 · OpenAI 兼容协议一套通吃。

## 安装

1. Chrome 116+（或 Edge / 其他 Chromium 内核）
2. 打开 `chrome://extensions` → 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本目录

## 配置（首次使用）

侧边栏右上角 **⚙** 打开设置页：

| 服务商 | baseURL | model 示例 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-flash`（快速 · 原生视觉）/ `deepseek-v4-pro`（深度推理） |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5:7b` |

- baseURL 填写到 `/v1` 即可；程序会自动补全 `/chat/completions`，已填完整路径也能识别。
- model / 视觉模型均**自由填写**（下拉只是建议）；截图问图时 DeepSeek 会自动用 `deepseek-flash`（视觉已原生并入 Flash，无需单独填视觉模型）。
- 本插件已申请全局站点访问权限（用于图片控制/免广告等常开功能），保存 API 配置无需再单独授权域名。
- 「测试连接」会用当前配置发一条最小请求验证连通性。
- apiKey 仅存本机 `chrome.storage.local`，不上传、不同步。

## 图片 / 视频控制

侧边栏**顶部**有三段式开关：**正常 / 缩略 / 隐藏**（缩略：图片缩到 48px 见轮廓、视频缩到 96px）。切换即时生效，无需刷新页面。

实现方式：声明式注入 content script，监听配置变化后给 `<html>` 切 class，由纯 CSS 规则隐藏/缩小（含内联背景图），不拦截网络、不改页面 JS。

## 免广告

设置页「界面与会话」里可开关（**默认开启**）。用 CSS 隐藏常见广告容器（`.ad`、`[class*="advertisement"]`、`[id*="adsense"]` 等）。注意：这是"看不见"级拦截，**不阻止广告请求下载**、挡不住 JS 定时刷新，个别站点可能误伤界面，遇到可临时关闭。

## 内置 Tab Dock（标签收纳与管理）

内置一套标签收纳能力：**把打开的标签一次性收成一组并关掉它们释放内存，需要时再整组恢复**，完全本地、无服务器、可替代独立的同类插件。

- **侧栏入口**（顶栏最左的堆叠图标）：点「Dock window」把当前窗口所有网页标签收成一组并**关闭它们释放内存**；每个分组一行，右侧是 `Restore` ▸/▾ `Trash`（展开/折叠用箭头，不写字）；展开后每条网页右侧有 ✕ 可直接移除。
- **管理页**（侧栏点「Manager ↗」，或右键页面 → 🗂 Tab Dock → Open Tab Dock manager）＝全宽版：
  - 左栏分类：**All / Starred / Pending / Archived / Trash**（带计数），顶部搜索 + 「Named groups only」
  - 每张卡片 = 一次收纳 = 一组：标题（`N tabs` 或自定义名）、时间与相对时间、折叠、**Restore all**、**⋮ More…**
  - **⋮ More…**：恢复到新窗口 / 本窗口 / 无痕窗口、复制标题与链接、重命名 / 加备注、锁定（恢复后保留本组）、星标、待办、归档、置顶、粘贴链接、上下新建分组、移除本组重复项、上移 / 下移、移到回收站
  - **单条网页也能管**：每条网页右侧有 ★（星标）与 ⋮ —— ⋮ 里可「移动到其它分组」或直接**新建一个命名分组**（比如 Work Panel）把它单独放进去；打了星的网页会跨组汇总到左栏 **Starred**
  - **拖拽归类**：卡片里的每个链接都能拖动——拖到别的卡片即换个分组，拖到组内其它位置即重排；拖空的组自动消失
- **一次性收纳一批**：网页上右键 → 🗂 Tab Dock → Dock this tab / Dock all tabs（每窗口），同样会关闭标签释放内存。
- **收纳即去重**：一次 dock 内重复开的页面只保留一条（忽略 `#锚点`、结尾 `/`、主机名大小写与 `utm_*` 等追踪参数；`?id=1` 与 `?id=2` 仍视为不同页面），提示里会显示跳过了几条；该去重只作用于本次收纳，不会去动历史分组里已有的条目。
- **`chrome://` 也能收**：浏览器内部页（`chrome://extensions/`）和扩展页（`chrome-extension://…`）都能收纳、关闭、恢复；个别仍被 Chrome 拒绝打开的会单独提示，不会静默失败。
- **导入 / 导出**：导出 JSON（完整备份）/ 纯文本（通用的「标题 + URL」格式，同类工具互认）；导入支持 JSON、纯文本、或直接粘贴一堆链接。
- **取舍说明**：① 不提供「分享为网页」这类需要上传服务器的功能，纯本地存储；② 收纳时**不会关掉某个窗口的最后一个标签**，避免整窗（含侧边栏）一起消失；③ 数据在 `chrome.storage.local`，与侧栏/右键菜单实时同步。

## 使用

1. 在任意网页选中文字 → 右键 → 「问 AI」→ 选一条预设（默认四条：三句话说清 / 类比定位 / 为什么重要 / 外行版解释）
2. **「📄 解读当前页面」**：右键任意位置（无需选中文字）→ 问 AI ▸ 解读当前页面，AI 会先抓取当前页面正文，再输出总体概览与可深入方向
3. 侧边栏自动打开并流式输出；生成中可「停止」，完成后可「复制」，失败可「重试」
4. 「✏️ 自定义问题…」会聚焦输入框，首次发送时自动附带选中文本与页面上下文
5. 底部输入框可直接追问；无选区时，若通过工具栏图标打开过面板，自由提问会自动携带当前页面上下文（AI 能感知你在看哪一页）
6. **截图问图**：点输入框左侧「截」→ 在页面上拖拽框选区域（Esc 取消）→ 截图回到侧边栏，弹出几条默认问图问题（可点选或自行输入）→ 发送即用视觉模型回答
7. 「＋」新建会话（清空时间线）；历史仅保留在当前浏览器会话内，关闭浏览器自动清空

预设问题支持增删改、拖拽排序、启用/禁用、导入/导出 JSON，改动即时生效（右键菜单实时重建）。占位符：`{{text}}` 选中文本 · `{{title}}` 页面标题 · `{{url}}` 页面地址 · `{{lang}}` 浏览器语言。

### 页面上下文如何工作

- 用户点右键菜单或工具栏图标时，扩展借 `activeTab` 临时授权，用 `chrome.scripting.executeScript` 注入脚本抓取 `article/main/[role=main]` 或 `body` 的正文文本（节选约 8000 字），连同标题、URL、meta description 一起注入 system 提示。
- 抓取发生在用户手势内，无背景常驻监听、不缓存页面内容；`chrome://`、Chrome Web Store 等受限页无法注入，会自动退回仅标题+URL。

## 架构

技术方案与坑位清单见 [docs/学习助手-v1-技术方案.md](docs/学习助手-v1-技术方案.md)。核心数据流：

```
右键菜单(background.js) → chrome.storage.session 写任务 → 侧边栏 onChanged/兜底读取
  → 组装上下文(system=页面+选区) → fetch 流式 → marked + DOMPurify + highlight.js 渲染
```

## 目录说明

```
manifest.json       MV3 清单（host 权限 <all_urls> + content_scripts）
common.js           共享逻辑：默认配置 / URL 归一化 / OpenAI 兼容调用 / 错误映射
tabdock-store.js     Tab Dock 数据层（分组 / 回收站 / 恢复 / 去重 / 导入导出），页面·侧栏·SW 三端共用
tabdock.html/.css    内置 Tab Dock 管理页（全宽独立页：左栏分类 + 卡片 + 拖拽归类）
tabdock-page.js      管理页交互：分类计数、卡片、⋮ 更多菜单、拖拽归类
background.js       Service Worker：右键菜单 + 任务分发 + 页面上下文捕获 + Tab Dock 收纳
content/            图片控制 content script（三态 class 切换）+ CSS 规则
sidepanel/          侧边栏（会话、流式渲染、追问 + 图片三段开关 + Tab Dock 收纳入口）
options/            设置页（API / 预设 / 界面）
libs/               本地打包的第三方库（marked / DOMPurify / highlight.js，MIT）
icons/              扩展图标
tools/gen_icons.py  图标生成脚本（Pillow）
```

## 权限说明

- `contextMenus` / `sidePanel` / `storage` / `activeTab` / `scripting`：问答与页面上下文所需。
- `tabs`：内置 Tab Dock 需要读取所有标签的标题/网址才能收纳，并向 `chrome.tabs.create/remove` 恢复或关闭标签；仅本地使用，不联网。
- `host_permissions: <all_urls>`：图片控制需声明式注入所有页面才能「打开即生效」。安装/更新时浏览器会提示「读取所有网站数据」，此为本功能必需，不用于收集任何数据。

## 已知限制（v1.4）

- 页面正文抓取对超长页面只取节选（约 8000 字）；`chrome://`、Web Store 等受限页无法注入，退回仅标题+URL
- 图片隐藏覆盖 `<img>` / `<picture>` / `<video>`、常见视频站 `<iframe>` 及内联背景图；缩略模式对背景图无法缩小（只缩 `<img>`/`<video>`）
- 「隐藏 / 缩略 / 免广告」均不拦截网络下载，仅控制显示（不省流量）；免广告靠通用选择器，可能漏拦或误伤个别站点
- 截图问图：只截当前可见区域、不可滚动长截图；截图发给视觉模型，需 API 支持图片输入（DeepSeek 用 `deepseek-flash`，视觉已原生内置）
- 历史按设计仅存当前浏览器会话；跨设备/跨会话不留痕
- Tab Dock：空白新标签页（`about:blank` / `chrome://newtab`）没有收藏价值，不收纳；「恢复到无痕窗口」需在扩展详情里开启「允许在无痕模式下使用」；不提供需要上传服务器的「分享为网页」；收纳时不会关闭某窗口的最后一个标签，也不会关掉 Tab Dock 管理页自己
- 公式渲染（KaTeX）、场景分组（读代码/读论文/读财经）、多 API profile、快捷键、导出学习笔记在后续版本

## 开发

- 依赖全部本地打包（`libs/`），无构建步骤，改完代码在 `chrome://extensions` 刷新即可
- 重新生成图标：`python tools/gen_icons.py`（需 Pillow）
