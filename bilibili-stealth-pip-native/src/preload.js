'use strict';

const { ipcRenderer } = require('electron');

const STATE = {
  ready: false,
  hidden: false,
  autoClickAttempts: 0,
  scrubbing: false,
  danmakuVisible: true,
  userPaused: false,
  stealthAutoPaused: false,
  suppressNextPauseAsUser: false,
  boundVideo: null
};

function injectStyle() {
  if (document.getElementById('bspip-native-style')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'bspip-native-style';
  style.textContent = `
    html.bspip-native-ready,
    html.bspip-native-ready body {
      background: transparent !important;
      overflow: hidden !important;
    }

    html.bspip-native-ready .bspip-native-toolbar {
      align-items: center;
      background: linear-gradient(180deg, rgba(0, 0, 0, 0.54), rgba(0, 0, 0, 0));
      color: #fff;
      display: flex;
      gap: 8px;
      height: 34px;
      justify-content: flex-end;
      left: 0;
      opacity: 0;
      padding: 6px 8px;
      pointer-events: none;
      position: fixed;
      right: 0;
      top: 0;
      transition: opacity 120ms ease;
      z-index: 2147483647;
      -webkit-app-region: drag;
    }

    html.bspip-native-ready body:hover .bspip-native-toolbar {
      opacity: 1;
      pointer-events: auto;
    }

    html.bspip-native-hidden .bspip-native-toolbar {
      opacity: 0 !important;
      pointer-events: none !important;
    }

    .bspip-native-button {
      appearance: none;
      background: rgba(255, 255, 255, 0.16);
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 999px;
      color: #fff;
      cursor: pointer;
      font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 6px 9px;
      -webkit-app-region: no-drag;
    }

    .bspip-native-button:hover {
      background: rgba(0, 174, 236, 0.82);
    }

    html.bspip-native-ready .bspip-native-controlbar {
      align-items: center;
      background: linear-gradient(0deg, rgba(0, 0, 0, 0.66), rgba(0, 0, 0, 0));
      bottom: 0;
      color: #fff;
      display: grid;
      gap: 8px;
      grid-template-columns: auto auto 1fr auto auto;
      left: 0;
      opacity: 0;
      padding: 22px 10px 9px;
      pointer-events: none;
      position: fixed;
      right: 0;
      transition: opacity 120ms ease;
      z-index: 2147483647;
      -webkit-app-region: no-drag;
    }

    html.bspip-native-ready body:hover .bspip-native-controlbar {
      opacity: 1;
      pointer-events: auto;
    }

    html.bspip-native-hidden .bspip-native-controlbar {
      opacity: 0 !important;
      pointer-events: none !important;
    }

    .bspip-native-time {
      color: rgba(255, 255, 255, 0.92);
      font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      min-width: 42px;
      text-align: center;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
      user-select: none;
    }

    .bspip-native-progress {
      accent-color: #00aeec;
      cursor: pointer;
      height: 18px;
      min-width: 120px;
      width: 100%;
    }

    html.bspip-native-danmaku-off .bpx-player-render-dm-wrap,
    html.bspip-native-danmaku-off .bpx-player-dm-mask-wrap,
    html.bspip-native-danmaku-off .bpx-player-adv-dm-wrap,
    html.bspip-native-danmaku-off .bpx-player-row-dm-wrap,
    html.bspip-native-danmaku-off .bpx-player-bas-dm-wrap,
    html.bspip-native-danmaku-off .bpx-player-cmd-dm-wrap,
    html.bspip-native-danmaku-off .bpx-player-cmd-dm-inside,
    html.bspip-native-danmaku-off .bili-danmaku,
    html.bspip-native-danmaku-off .b-danmaku {
      display: none !important;
      visibility: hidden !important;
    }

    html.bspip-native-ready #biliMainHeader,
    html.bspip-native-ready .bili-header,
    html.bspip-native-ready .bili-header__bar,
    html.bspip-native-ready .left-container-under-player,
    html.bspip-native-ready .right-container,
    html.bspip-native-ready .video-toolbar-left-main,
    html.bspip-native-ready .video-toolbar-right,
    html.bspip-native-ready .reply-warp,
    html.bspip-native-ready .recommend-list-v1,
    html.bspip-native-ready .ad-report,
    html.bspip-native-ready .fixed-sidenav-storage,
    html.bspip-native-ready .video-page-card-small,
    html.bspip-native-ready .float-nav,
    html.bspip-native-ready .palette-button-wrap,
    html.bspip-native-ready .vcd,
    html.bspip-native-ready .bpx-player-sending-area,
    html.bspip-native-ready .bpx-player-dm-root,
    html.bspip-native-ready .bpx-player-ending-panel {
      display: none !important;
    }

    html.bspip-native-ready .left-container,
    html.bspip-native-ready .video-container-v1,
    html.bspip-native-ready .video-content,
    html.bspip-native-ready .player-wrap,
    html.bspip-native-ready #bilibili-player,
    html.bspip-native-ready .bpx-player-container,
    html.bspip-native-ready .bpx-player-primary-area,
    html.bspip-native-ready .bpx-player-video-area,
    html.bspip-native-ready .bpx-player-video-wrap,
    html.bspip-native-ready .bpx-player-video-perch,
    html.bspip-native-ready video {
      height: 100vh !important;
      left: 0 !important;
      margin: 0 !important;
      max-height: none !important;
      max-width: none !important;
      min-height: 0 !important;
      min-width: 0 !important;
      padding: 0 !important;
      position: fixed !important;
      top: 0 !important;
      transform: none !important;
      width: 100vw !important;
    }

    html.bspip-native-ready video {
      object-fit: contain !important;
      z-index: 2147483600 !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function injectToolbar() {
  if (document.querySelector('.bspip-native-toolbar')) {
    return;
  }

  const toolbar = document.createElement('div');
  toolbar.className = 'bspip-native-toolbar';
  toolbar.innerHTML = `
    <button class="bspip-native-button" data-action="minimize" type="button">最小化</button>
    <button class="bspip-native-button" data-action="close" type="button">关闭</button>
  `;

  toolbar.addEventListener('click', (event) => {
    const action = event.target?.dataset?.action;
    if (action === 'close') {
      ipcRenderer.send('stealth:close');
    }
    if (action === 'minimize') {
      ipcRenderer.send('stealth:minimize');
    }
  });

  (document.body || document.documentElement).appendChild(toolbar);
}

function injectControlBar() {
  if (document.querySelector('.bspip-native-controlbar')) {
    return;
  }

  const controlbar = document.createElement('div');
  controlbar.className = 'bspip-native-controlbar';
  controlbar.innerHTML = `
    <button class="bspip-native-button bspip-native-play" data-action="play" type="button">播放</button>
    <span class="bspip-native-time bspip-native-current">00:00</span>
    <input class="bspip-native-progress" type="range" min="0" max="1000" step="1" value="0" aria-label="视频进度">
    <span class="bspip-native-time bspip-native-duration">--:--</span>
    <button class="bspip-native-button bspip-native-danmaku-toggle" data-action="danmaku" type="button">弹幕开</button>
  `;

  controlbar.addEventListener('click', (event) => {
    const action = event.target?.dataset?.action;
    if (action === 'play') {
      togglePlay();
    }
    if (action === 'danmaku') {
      toggleDanmaku();
    }
  });

  const progress = controlbar.querySelector('.bspip-native-progress');
  progress.addEventListener('pointerdown', () => {
    STATE.scrubbing = true;
  });
  progress.addEventListener('input', () => {
    seekFromProgress(progress);
  });
  progress.addEventListener('change', () => {
    seekFromProgress(progress);
    STATE.scrubbing = false;
    updateControlBar();
  });
  progress.addEventListener('pointerup', () => {
    STATE.scrubbing = false;
    updateControlBar();
  });
  progress.addEventListener('pointercancel', () => {
    STATE.scrubbing = false;
    updateControlBar();
  });

  (document.body || document.documentElement).appendChild(controlbar);
  updateControlBar();
}

function getVideo() {
  return document.querySelector('video');
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '--:--';
  }

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function seekFromProgress(progress) {
  const video = getVideo();
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
    return;
  }

  const ratio = Math.min(Math.max(Number(progress.value) / 1000, 0), 1);
  video.currentTime = ratio * video.duration;
  updateControlBar();
}

function togglePlay() {
  const video = getVideo();
  if (!video) {
    return;
  }

  if (video.paused) {
    STATE.userPaused = false;
    video.play().catch(() => {});
  } else {
    STATE.userPaused = true;
    STATE.autoClickAttempts = 999;
    video.pause();
  }
  updateControlBar();
}

function setDanmakuVisible(visible) {
  STATE.danmakuVisible = visible;
  document.documentElement.classList.toggle('bspip-native-danmaku-off', !visible);
  const button = document.querySelector('.bspip-native-danmaku-toggle');
  if (button) {
    button.textContent = visible ? '弹幕开' : '弹幕关';
  }
}

function toggleDanmaku() {
  setDanmakuVisible(!STATE.danmakuVisible);
}

function updateControlBar() {
  const controlbar = document.querySelector('.bspip-native-controlbar');
  const video = getVideo();
  if (!controlbar || !video) {
    return;
  }

  const current = controlbar.querySelector('.bspip-native-current');
  const duration = controlbar.querySelector('.bspip-native-duration');
  const progress = controlbar.querySelector('.bspip-native-progress');
  const play = controlbar.querySelector('.bspip-native-play');

  if (current) {
    current.textContent = formatTime(video.currentTime);
  }
  if (duration) {
    duration.textContent = formatTime(video.duration);
  }
  if (progress && !STATE.scrubbing) {
    const hasDuration = Number.isFinite(video.duration) && video.duration > 0;
    progress.disabled = !hasDuration;
    progress.value = hasDuration ? String(Math.round((video.currentTime / video.duration) * 1000)) : '0';
  }
  if (play) {
    play.textContent = video.paused ? '播放' : '暂停';
  }
}

function pauseForStealthHide() {
  const video = getVideo();
  bindVideoEvents();
  if (!video || video.paused || video.ended) {
    STATE.stealthAutoPaused = false;
    return;
  }

  STATE.stealthAutoPaused = true;
  STATE.suppressNextPauseAsUser = true;
  video.pause();
  updateControlBar();
}

function resumeAfterStealthReveal() {
  const video = getVideo();
  bindVideoEvents();
  if (!video || !STATE.stealthAutoPaused) {
    return;
  }

  STATE.stealthAutoPaused = false;
  if (STATE.userPaused || video.ended) {
    updateControlBar();
    return;
  }

  video.play()
    .then(() => {
      STATE.autoClickAttempts = 999;
      updateControlBar();
    })
    .catch(() => {
      STATE.autoClickAttempts = 0;
      tryClickBilibiliPlay();
    });
}

function applyHiddenState(hidden) {
  const nextHidden = Boolean(hidden);
  if (STATE.hidden === nextHidden) {
    return false;
  }

  STATE.hidden = nextHidden;
  document.documentElement.classList.toggle('bspip-native-hidden', nextHidden);

  if (nextHidden) {
    pauseForStealthHide();
  } else {
    resumeAfterStealthReveal();
  }

  updateControlBar();
  return true;
}

function setHidden(hidden) {
  const changed = applyHiddenState(hidden);
  if (changed) {
    ipcRenderer.send('stealth:set-hidden', Boolean(hidden));
  }
}

function bindMouseStealth() {
  window.addEventListener('mouseenter', () => setHidden(false));
  window.addEventListener('mousemove', () => setHidden(false), { passive: true });
  window.addEventListener('mouseleave', () => setHidden(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setHidden(false);
    }
  });
}

function bindVideoEvents() {
  const video = getVideo();
  if (!video || STATE.boundVideo === video) {
    return;
  }

  STATE.boundVideo = video;

  video.addEventListener('play', () => {
    STATE.userPaused = false;
    STATE.autoClickAttempts = 999;
    updateControlBar();
  });

  video.addEventListener('pause', () => {
    if (STATE.suppressNextPauseAsUser) {
      STATE.suppressNextPauseAsUser = false;
      updateControlBar();
      return;
    }

    if (!STATE.hidden && !STATE.scrubbing && !video.ended && Number.isFinite(video.currentTime) && video.currentTime > 0.2) {
      STATE.userPaused = true;
      STATE.autoClickAttempts = 999;
    }
    updateControlBar();
  });

  video.addEventListener('timeupdate', updateControlBar);
  video.addEventListener('loadedmetadata', updateControlBar);
  video.addEventListener('durationchange', updateControlBar);
}

function tryPlayVideo() {
  const video = getVideo();
  bindVideoEvents();
  if (!video || STATE.userPaused || STATE.hidden) {
    return;
  }

  video.muted = false;
  video.volume = Math.max(video.volume || 0, 0.6);
  if (!video.paused) {
    STATE.autoClickAttempts = 999;
    return;
  }

  video.play()
    .then(() => {
      STATE.autoClickAttempts = 999;
    })
    .catch(() => {});
}

function tryClickBilibiliPlay() {
  bindVideoEvents();
  const video = getVideo();
  if (STATE.hidden) {
    updateControlBar();
    return;
  }

  if (video && !video.paused) {
    STATE.autoClickAttempts = 999;
    updateControlBar();
    return;
  }

  if (STATE.userPaused || STATE.autoClickAttempts > 90) {
    return;
  }
  STATE.autoClickAttempts += 1;

  const playButton = document.querySelector('.bpx-player-ctrl-play, .bilibili-player-video-btn-start');
  if (video && video.paused && playButton) {
    playButton.click();
  }
  tryPlayVideo();
}

function boot() {
  if (STATE.ready || !document.documentElement) {
    return;
  }

  STATE.ready = true;
  document.documentElement.classList.add('bspip-native-ready');
  injectStyle();
  injectToolbar();
  injectControlBar();
  bindVideoEvents();
  bindMouseStealth();

  const observer = new MutationObserver(() => {
    injectStyle();
    injectToolbar();
    injectControlBar();
    bindVideoEvents();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.setInterval(tryClickBilibiliPlay, 800);
  window.setInterval(updateControlBar, 250);
}

ipcRenderer.on('stealth:loaded', () => {
  boot();
});

ipcRenderer.on('stealth:state', (_event, payload) => {
  applyHiddenState(Boolean(payload?.hidden));
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
