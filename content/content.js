/* 学习助手 · content script（图片控制 + 免广告）
 * 通过给 <html> 切 class 由 CSS 规则生效，声明式匹配覆盖动态加载的内容。
 * 图片隐藏时额外「压缩图片容器」（figure / 图片 class / aspect-ratio 占位），避免留空白。
 * 图片控制键 'imageControl' = { mode: 'normal'|'thumb'|'hidden' }
 * 免广告键   'adBlock'      = { enabled: boolean }，默认开启。
 */
'use strict';

(function () {
  const IMG_KEY = 'imageControl';
  const AD_KEY = 'adBlock';
  // 图片类元素：img + video + Quora 式 canvas 占位
  const MEDIA_SEL = 'img, video, canvas[data-src]';

  function applyImg(mode) {
    const root = document.documentElement;
    if (!root) return;
    root.classList.remove('la-img-thumb', 'la-img-hidden');
    // 清理上一轮（如从 hidden 切回 normal）遗留的折叠标记
    root.querySelectorAll('.la-img-container-hidden').forEach((el) =>
      el.classList.remove('la-img-container-hidden')
    );
    if (mode === 'thumb') {
      root.classList.add('la-img-thumb');
    } else if (mode === 'hidden') {
      // 先加 class 让媒体 display:none 生效，再判断「纯图片容器」并折叠，
      // 这样被隐藏 img 的 alt 不会干扰正文判定。
      root.classList.add('la-img-hidden');
      setTimeout(compressAllContainers, 0);
    }
  }

  function applyAd(enabled) {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle('la-adblock', !!enabled);
  }

  /*
   * 折叠纯图片容器：媒体元素向上回溯祖先（最多 3 层），
   * 一旦遇到「包含文字或其他非媒体内容」的容器就停止折叠，
   * 从而只缩掉纯图区域、保留含正文的卡片（知乎 feed 等）。
   * 折叠仅打标记，真正的高度/比例约束清除由 CSS（.la-img-container-hidden）完成。
   */
  function compressContainer(mediaEl) {
    let p = mediaEl.parentElement;
    let hops = 0;
    while (p && p !== document.body && p !== document.documentElement && hops < 3) {
      if (containerHasContent(p)) break;
      p.classList.add('la-img-container-hidden');
      p = p.parentElement;
      hops++;
    }
  }

  /* 容器是否含有「可见的文字/非媒体内容」。含则视为有正文，不应被折叠。 */
  function containerHasContent(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.trim().length > 0) return true;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (
          tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS' ||
          tag === 'PICTURE' || tag === 'SOURCE' || tag === 'AREA' || tag === 'MAP'
        ) {
          continue;
        }
        if (node.classList && node.classList.contains('la-img-container-hidden')) continue;
        // innerText 会忽略 display:none 元素，被隐藏的媒体不计入
        if (node.innerText && node.innerText.trim().length > 0) return true;
        if (containerHasContent(node)) return true;
      }
    }
    return false;
  }

  function compressAllContainers() {
    const root = document.documentElement;
    if (!root || !root.classList.contains('la-img-hidden')) return;
    root.querySelectorAll(MEDIA_SEL).forEach(compressContainer);
    // 内联背景图（div style="background-image:..."）：纯装饰且无文字的也折叠
    root.querySelectorAll('[style*="background-image"]').forEach((el) => {
      if (!containerHasContent(el)) el.classList.add('la-img-container-hidden');
    });
  }

  let observer = null;
  function ensureObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      const root = document.documentElement;
      if (!root || !root.classList.contains('la-img-hidden')) return;
      for (const m of mutations) {
        if (m.type !== 'childList') continue;
        m.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          const tag = node.tagName;
          if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS') {
            compressContainer(node);
          } else if (node.querySelectorAll) {
            if (
              node.matches &&
              node.matches('[style*="background-image"]') &&
              !containerHasContent(node)
            ) {
              node.classList.add('la-img-container-hidden');
            }
            node.querySelectorAll(MEDIA_SEL).forEach(compressContainer);
            node.querySelectorAll('[style*="background-image"]').forEach((el) => {
              if (!containerHasContent(el)) el.classList.add('la-img-container-hidden');
            });
          }
        });
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function refresh() {
    let imgMode = 'normal';
    let adEnabled = true;
    try {
      const res = await chrome.storage.local.get([IMG_KEY, AD_KEY]);
      imgMode = (res[IMG_KEY] && res[IMG_KEY].mode) || 'normal';
      adEnabled = !res[AD_KEY] || res[AD_KEY].enabled !== false;
    } catch {}
    applyImg(imgMode);
    applyAd(adEnabled);
    ensureObserver();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[IMG_KEY] || changes[AD_KEY])) refresh();
  });

  function start() {
    if (document.documentElement) refresh();
    else document.addEventListener('DOMContentLoaded', refresh, { once: true });
  }
  start();
})();
