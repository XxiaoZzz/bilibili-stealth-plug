(() => {
  'use strict';

  const EXTENSION_FLAG = '__bilibiliNativeStealthPipExtensionLoaded__';
  const BUTTON_CLASS = 'bspip-stealth-btn';
  const ACTIVE_CLASS = 'bspip-active';
  const CONTROL_SELECTOR = '.bpx-player-control-bottom-right, .bpx-player-control-bottom, .bilibili-player-video-control-bottom-right';
  const NATIVE_PIP_SELECTOR = '.bpx-player-ctrl-pip, .bilibili-player-video-btn-pip';
  const PLAYBACK_SYNC_INTERVAL_MS = 1000;

  if (window[EXTENSION_FLAG]) {
    return;
  }
  window[EXTENSION_FLAG] = true;

  let activeButton = null;
  let opening = false;
  let activeSessionId = null;
  let playbackSyncTimer = null;
  let playbackSyncFailures = 0;
  let syncedSourceVideo = null;
  let buttonObserver = null;
  let injectButtonTimer = null;

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


  function createSessionId() {
    if (crypto?.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

  function sendNativeOpenMessage(url, sessionId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'OPEN_NATIVE_STEALTH_PIP',
        url,
        title: document.title,
        sessionId
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

  function getNativePlaybackState() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'GET_NATIVE_STEALTH_PIP_PLAYBACK'
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

  function applyPlaybackStateToSourceVideo(state) {
    const video = syncedSourceVideo?.isConnected ? syncedSourceVideo : findSourceVideo();
    const currentTime = Number(state?.currentTime);
    if (!video || !Number.isFinite(currentTime) || currentTime < 0) {
      return false;
    }

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    const nextTime = duration ? Math.min(currentTime, Math.max(duration - 0.1, 0)) : currentTime;
    if (Math.abs(video.currentTime - nextTime) > 0.35) {
      video.currentTime = nextTime;
    }
    if (!video.paused) {
      video.pause();
    }
    return true;
  }

  function stopPlaybackSync(markInactive = true) {
    if (playbackSyncTimer) {
      window.clearInterval(playbackSyncTimer);
      playbackSyncTimer = null;
    }
    playbackSyncFailures = 0;
    if (markInactive) {
      setButtonActive(false);
    }
  }

  function scheduleInjectButton() {
    if (injectButtonTimer) {
      return;
    }

    injectButtonTimer = window.setTimeout(() => {
      injectButtonTimer = null;
      injectButton();
    }, 250);
  }

  function cleanup() {
    stopPlaybackSync(false);
    if (injectButtonTimer) {
      window.clearTimeout(injectButtonTimer);
      injectButtonTimer = null;
    }
    if (buttonObserver) {
      buttonObserver.disconnect();
      buttonObserver = null;
    }
    syncedSourceVideo = null;
    activeButton = null;
  }

  function startPlaybackSync(sessionId) {
    stopPlaybackSync(false);
    activeSessionId = sessionId;

    const syncOnce = async () => {
      const response = await getNativePlaybackState();
      if (!response.ok) {
        playbackSyncFailures += 1;
        if (playbackSyncFailures >= 3) {
          stopPlaybackSync(true);
        }
        return;
      }

      playbackSyncFailures = 0;
      const data = response.data || {};
      const state = data.state || null;
      const stateSessionId = state?.sessionId || data.sessionId || null;
      if (!activeSessionId || stateSessionId !== activeSessionId) {
        return;
      }

      applyPlaybackStateToSourceVideo(state);

      if (!data.hasWindow) {
        stopPlaybackSync(true);
        showToast('透明小窗已关闭，网页播放进度已同步。');
      }
    };

    syncOnce().catch(() => {});
    playbackSyncTimer = window.setInterval(() => {
      syncOnce().catch(() => {});
    }, PLAYBACK_SYNC_INTERVAL_MS);
  }

  async function openNativeStealthPip() {
    if (opening) {
      return;
    }

    opening = true;
    setButtonActive(true);

    try {
      const sourceVideo = findSourceVideo();
      syncedSourceVideo = sourceVideo;
      const sessionId = createSessionId();
      const response = await sendNativeOpenMessage(buildHandoffUrl(sourceVideo), sessionId);
      if (!response.ok) {
        throw new Error(response.error || 'native helper unavailable');
      }

      if (sourceVideo && !sourceVideo.paused) {
        sourceVideo.pause();
      }
      startPlaybackSync(sessionId);

      showToast('已交给本地透明小窗：关闭小窗后会同步网页进度。');
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
    if (buttonObserver) {
      return;
    }

    injectButton();
    buttonObserver = new MutationObserver(() => scheduleInjectButton());
    buttonObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  window.addEventListener('pagehide', cleanup, { once: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else {
    startObserver();
  }
})();
