(() => {
  'use strict';

  const EXTENSION_FLAG = '__bilibiliNativeStealthPipExtensionLoaded__';
  const BUTTON_CLASS = 'bspip-stealth-btn';
  const ACTIVE_CLASS = 'bspip-active';
  const CONTROL_SELECTOR = '.bpx-player-control-bottom-right, .bpx-player-control-bottom, .bilibili-player-video-control-bottom-right';
  const NATIVE_PIP_SELECTOR = '.bpx-player-ctrl-pip, .bilibili-player-video-btn-pip';

  if (window[EXTENSION_FLAG]) {
    return;
  }
  window[EXTENSION_FLAG] = true;

  let activeButton = null;
  let opening = false;

  function showToast(message) {
    const oldToast = document.querySelector('.bspip-toast');
    oldToast?.remove();

    const toast = document.createElement('div');
    toast.className = 'bspip-toast';
    toast.textContent = message;
    document.documentElement.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3600);
  }

  function getVisibleArea(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0
    ) {
      return 0;
    }
    return rect.width * rect.height;
  }

  function findSourceVideo() {
    return Array.from(document.querySelectorAll('video'))
      .map((video) => ({ video, area: getVisibleArea(video) }))
      .filter(({ area }) => area > 0)
      .sort((a, b) => b.area - a.area)[0]?.video || null;
  }


  function buildHandoffUrl(sourceVideo) {
    const url = new URL(location.href);
    if (sourceVideo && Number.isFinite(sourceVideo.currentTime) && sourceVideo.currentTime > 1) {
      url.searchParams.set('t', String(Math.floor(sourceVideo.currentTime)));
    }
    return url.toString();
  }

  function setButtonActive(isActive) {
    activeButton = document.querySelector(`.${BUTTON_CLASS}`) || activeButton;
    activeButton?.classList.toggle(ACTIVE_CLASS, isActive);
  }

  function sendNativeOpenMessage(url) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'OPEN_NATIVE_STEALTH_PIP',
        url,
        title: document.title
      }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          resolve({ ok: false, error: runtimeError.message });
          return;
        }
        resolve(response || { ok: false, error: 'empty extension response' });
      });
    });
  }

  async function openNativeStealthPip() {
    if (opening) {
      return;
    }

    opening = true;
    setButtonActive(true);

    try {
      const sourceVideo = findSourceVideo();
      const response = await sendNativeOpenMessage(buildHandoffUrl(sourceVideo));
      if (!response.ok) {
        throw new Error(response.error || 'native helper unavailable');
      }

      if (sourceVideo && !sourceVideo.paused) {
        sourceVideo.pause();
      }

      showToast('已交给本地透明小窗：移出后透明并暂停，移回后恢复播放。');
    } catch (error) {
      setButtonActive(false);
      console.error('[Bilibili Native Stealth PiP] Failed to open native helper:', error);
      showToast('本地透明小窗未启动。请先在终端运行：cd bilibili-stealth-pip-native && npm start');
    } finally {
      opening = false;
    }
  }

  function createButton() {
    const button = document.createElement('div');
    button.className = `${BUTTON_CLASS} bpx-player-ctrl-btn`;
    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', '透明隐身画中画');
    button.setAttribute('title', '透明隐身画中画：交给本地 Electron 透明置顶小窗');
    button.textContent = '透明';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openNativeStealthPip();
    });
    return button;
  }

  function injectButton() {
    if (document.querySelector(`.${BUTTON_CLASS}`)) {
      return;
    }

    const nativePipButton = document.querySelector(NATIVE_PIP_SELECTOR);
    const controls = nativePipButton?.parentElement || document.querySelector(CONTROL_SELECTOR);
    if (!controls) {
      return;
    }

    const button = createButton();
    activeButton = button;
    if (nativePipButton?.parentElement) {
      nativePipButton.parentElement.insertBefore(button, nativePipButton);
    } else {
      controls.appendChild(button);
    }
  }

  function startObserver() {
    injectButton();
    const observer = new MutationObserver(() => injectButton());
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else {
    startObserver();
  }
})();
