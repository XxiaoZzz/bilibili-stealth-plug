'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const path = require('node:path');
const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } = require('electron');

const HOST = '127.0.0.1';
const PORT = 39877;
const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 315;
const DEFAULT_VISIBLE_OPACITY = 1;
const MIN_VISIBLE_OPACITY = 0.2;
const MAX_VISIBLE_OPACITY = 1;
const HIDDEN_OPACITY = 0;
const POINTER_POLL_INTERVAL_MS = 80;
const OPEN_REVEAL_MS = 2400;
const MEMORY_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const MEMORY_GUARD_INTERVAL_MS = 60 * 1000;
const MEMORY_GUARD_COOLDOWN_MS = 10 * 60 * 1000;
const MEMORY_GUARD_RENDERER_THRESHOLD_MIB = 4096;
const MEMORY_GUARD_TOTAL_THRESHOLD_MIB = 6144;
const STANDBY_READY_TIMEOUT_MS = 20 * 1000;
const STANDBY_TARGET_LEAD_SECONDS = 0.6;
const STANDBY_MAX_BEHIND_SECONDS = 0.45;
const STANDBY_MAX_AHEAD_SECONDS = 2.5;
const STANDBY_MAX_ADJUSTMENTS = 5;
const ALLOWED_URL_PREFIXES = [
  'https://www.bilibili.com/video/',
  'https://m.bilibili.com/video/'
];
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

let server = null;
let playerWindow = null;
let standbyWindow = null;
let standbySwap = null;
let keeperWindow = null;
let lastLoadedUrl = null;
let pointerWatchTimer = null;
let pointerHidden = false;
let forceVisibleUntil = 0;
let keepAliveTimer = null;
let memorySampleTimer = null;
let memoryGuardTimer = null;
let lastMemorySnapshot = null;
let lastMemoryGuardAt = 0;
let recoveringFromMemoryPressure = false;
let activeSessionId = null;
let lastPlaybackState = null;
let visibleOpacity = DEFAULT_VISIBLE_OPACITY;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

function isAllowedBilibiliUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return false;
  }
  return ALLOWED_URL_PREFIXES.some((prefix) => rawUrl.startsWith(prefix));
}

function normalizeBilibiliUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.hostname === 'm.bilibili.com') {
    parsed.hostname = 'www.bilibili.com';
  }
  parsed.searchParams.delete('vd_source');
  return parsed.toString();
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  response.end(body);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 64) {
        reject(new Error('request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}


function createSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getWindowPlaybackPayload() {
  const hasWindow = Boolean(playerWindow && !playerWindow.isDestroyed());
  return {
    ok: true,
    hasWindow,
    sessionId: activeSessionId,
    state: lastPlaybackState
  };
}

function updatePlaybackState(payload = {}, reason = 'renderer') {
  const currentTime = Number(payload.currentTime);
  const duration = Number(payload.duration);
  const playbackRate = Number(payload.playbackRate);

  lastPlaybackState = {
    sessionId: activeSessionId,
    url: typeof payload.url === 'string' ? payload.url : playerWindow?.webContents.getURL() || lastLoadedUrl || '',
    currentTime: Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    paused: Boolean(payload.paused),
    ended: Boolean(payload.ended),
    playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : null,
    brightness: Number.isFinite(Number(payload.brightness)) ? Number(payload.brightness) : lastPlaybackState?.brightness || 1,
    visibleOpacity: Number.isFinite(Number(payload.visibleOpacity)) ? Number(payload.visibleOpacity) : visibleOpacity,
    danmakuVisible: typeof payload.danmakuVisible === 'boolean' ? payload.danmakuVisible : lastPlaybackState?.danmakuVisible ?? true,
    reason,
    updatedAt: Date.now()
  };
}

function kibToMiB(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric / 1024) : null;
}

function firstFiniteNumber(...values) {
  return values.find((value) => Number.isFinite(Number(value)));
}

function sumMiB(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function isRendererMetric(processType) {
  return /^(tab|renderer)$/i.test(String(processType || ''));
}

function getMemoryFields(metric = {}) {
  const memory = metric.memory || {};
  return {
    workingSetMiB: kibToMiB(firstFiniteNumber(memory.workingSetSize, memory.residentSet)),
    peakWorkingSetMiB: kibToMiB(memory.peakWorkingSetSize),
    privateBytesMiB: kibToMiB(firstFiniteNumber(memory.privateBytes, memory.private)),
    sharedBytesMiB: kibToMiB(firstFiniteNumber(memory.sharedBytes, memory.shared))
  };
}

async function collectMemorySnapshot(reason = 'manual') {
  const selfMemory = typeof process.getProcessMemoryInfo === 'function'
    ? await process.getProcessMemoryInfo().catch(() => null)
    : null;
  const processes = app.isReady()
    ? app.getAppMetrics().map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        cpuPercent: Number.isFinite(metric.cpu?.percentCPUUsage)
          ? Number(metric.cpu.percentCPUUsage.toFixed(2))
          : null,
        ...getMemoryFields(metric)
      }))
    : [];

  const rendererProcesses = processes.filter((metric) => isRendererMetric(metric.type));
  const totalWorkingSetMiB = sumMiB(processes.map((metric) => metric.workingSetMiB));
  const rendererWorkingSetMiB = sumMiB(rendererProcesses.map((metric) => metric.workingSetMiB));
  const largestProcess = processes
    .filter((metric) => Number.isFinite(metric.workingSetMiB))
    .sort((a, b) => b.workingSetMiB - a.workingSetMiB)[0] || null;

  lastMemorySnapshot = {
    ok: true,
    reason,
    updatedAt: Date.now(),
    totalWorkingSetMiB,
    rendererWorkingSetMiB,
    self: selfMemory
      ? {
          workingSetMiB: kibToMiB(firstFiniteNumber(selfMemory.workingSetSize, selfMemory.residentSet)),
          peakWorkingSetMiB: kibToMiB(selfMemory.peakWorkingSetSize),
          privateBytesMiB: kibToMiB(firstFiniteNumber(selfMemory.privateBytes, selfMemory.private)),
          sharedBytesMiB: kibToMiB(firstFiniteNumber(selfMemory.sharedBytes, selfMemory.shared))
        }
      : null,
    largestProcess,
    processes
  };

  return lastMemorySnapshot;
}

function logMemorySnapshot(snapshot) {
  if (!snapshot) {
    return;
  }

  const largest = snapshot.largestProcess
    ? `${snapshot.largestProcess.type || 'unknown'}:${snapshot.largestProcess.pid}=${snapshot.largestProcess.workingSetMiB}MiB`
    : 'n/a';
  console.log(
    `[Bilibili Stealth PiP Native] memory ${snapshot.reason}: total=${snapshot.totalWorkingSetMiB}MiB renderer=${snapshot.rendererWorkingSetMiB}MiB largest=${largest}`
  );
}

function getMemoryPressureReason(snapshot) {
  if (!snapshot) {
    return null;
  }
  if (snapshot.rendererWorkingSetMiB >= MEMORY_GUARD_RENDERER_THRESHOLD_MIB) {
    return `renderer working set ${snapshot.rendererWorkingSetMiB}MiB`;
  }
  if (snapshot.totalWorkingSetMiB >= MEMORY_GUARD_TOTAL_THRESHOLD_MIB) {
    return `total working set ${snapshot.totalWorkingSetMiB}MiB`;
  }
  return null;
}

async function clearPlayerSessionCache(reason = 'manual', win = playerWindow) {
  if (!win || win.isDestroyed()) {
    return { ok: false, error: 'no window' };
  }

  const startedAt = Date.now();
  await win.webContents.session.clearCache();
  return {
    ok: true,
    reason,
    elapsedMs: Date.now() - startedAt
  };
}

function getEstimatedPlaybackTime() {
  const currentTime = Number(lastPlaybackState?.currentTime);
  if (!Number.isFinite(currentTime) || currentTime < 0) {
    return 0;
  }

  if (lastPlaybackState?.paused || lastPlaybackState?.ended) {
    return currentTime;
  }

  const updatedAt = Number(lastPlaybackState?.updatedAt);
  const playbackRate = Number(lastPlaybackState?.playbackRate) > 0 ? Number(lastPlaybackState.playbackRate) : 1;
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    return currentTime;
  }

  return currentTime + Math.max((Date.now() - updatedAt) / 1000, 0) * playbackRate;
}

function getReloadUrlWithPlaybackTime(rawUrl, targetTime = getEstimatedPlaybackTime()) {
  const parsed = new URL(rawUrl);
  const currentTime = Number(targetTime);
  if (Number.isFinite(currentTime) && currentTime > 1) {
    parsed.searchParams.set('t', String(Math.floor(currentTime)));
  }
  return parsed.toString();
}

async function recoverFromMemoryPressure(snapshot) {
  if (!playerWindow || playerWindow.isDestroyed() || recoveringFromMemoryPressure) {
    return false;
  }
  if (Date.now() - lastMemoryGuardAt < MEMORY_GUARD_COOLDOWN_MS) {
    return false;
  }

  const pressureReason = getMemoryPressureReason(snapshot);
  const currentUrl = playerWindow.webContents.getURL() || lastLoadedUrl || '';
  if (!pressureReason || !isAllowedBilibiliUrl(currentUrl)) {
    return false;
  }

  recoveringFromMemoryPressure = true;
  lastMemoryGuardAt = Date.now();
  console.warn(`[Bilibili Stealth PiP Native] memory guard hot swap requested: ${pressureReason}`);

  try {
    updatePlaybackState({
      ...(lastPlaybackState || {})
    }, 'memory-guard');
    return await runStandbyHotSwap(currentUrl, pressureReason);
  } finally {
    recoveringFromMemoryPressure = false;
  }
}

function startMemoryMonitoring() {
  if (!memorySampleTimer) {
    const sample = async (reason) => {
      const snapshot = await collectMemorySnapshot(reason);
      logMemorySnapshot(snapshot);
    };
    sample('startup').catch(() => {});
    memorySampleTimer = setInterval(() => {
      sample('interval').catch(() => {});
    }, MEMORY_SAMPLE_INTERVAL_MS);
  }

  if (!memoryGuardTimer) {
    memoryGuardTimer = setInterval(async () => {
      const snapshot = await collectMemorySnapshot('guard');
      await recoverFromMemoryPressure(snapshot);
    }, MEMORY_GUARD_INTERVAL_MS);
  }
}

function stopMemoryMonitoring() {
  if (memorySampleTimer) {
    clearInterval(memorySampleTimer);
    memorySampleTimer = null;
  }
  if (memoryGuardTimer) {
    clearInterval(memoryGuardTimer);
    memoryGuardTimer = null;
  }
}


function pointInBounds(point, bounds) {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

function clampOpacity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_VISIBLE_OPACITY;
  }
  return Math.min(Math.max(numeric, MIN_VISIBLE_OPACITY), MAX_VISIBLE_OPACITY);
}

function getTargetOpacity(hidden) {
  return hidden ? HIDDEN_OPACITY : visibleOpacity;
}

function applyWindowOpacity(win, hidden, reason) {
  if (!win || win.isDestroyed()) {
    return;
  }

  const targetOpacity = getTargetOpacity(hidden);
  if (pointerHidden === hidden && Math.abs(win.getOpacity() - targetOpacity) < 0.001) {
    return;
  }

  pointerHidden = hidden;
  win.setOpacity(targetOpacity);
  win.webContents.send('stealth:state', { hidden });
  console.log(`[Bilibili Stealth PiP Native] ${hidden ? 'hidden' : 'visible'} by ${reason}`);
}

function keepVisibleBriefly(durationMs = OPEN_REVEAL_MS) {
  forceVisibleUntil = Date.now() + durationMs;
  if (playerWindow && !playerWindow.isDestroyed()) {
    applyWindowOpacity(playerWindow, false, 'temporary-reveal');
  }
}

function stopPointerWatcher() {
  if (pointerWatchTimer) {
    clearInterval(pointerWatchTimer);
    pointerWatchTimer = null;
  }
}

function startPointerWatcher(win) {
  stopPointerWatcher();
  pointerWatchTimer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      stopPointerWatcher();
      return;
    }
    if (!win.isVisible()) {
      return;
    }

    const now = Date.now();
    if (now < forceVisibleUntil) {
      applyWindowOpacity(win, false, 'startup-grace');
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const inside = pointInBounds(cursor, bounds);
    applyWindowOpacity(win, !inside, inside ? 'cursor-inside-window' : 'cursor-outside-window');
  }, POINTER_POLL_INTERVAL_MS);
}


function createKeeperWindow() {
  if (keeperWindow && !keeperWindow.isDestroyed()) {
    return keeperWindow;
  }

  keeperWindow = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  keeperWindow.loadURL('about:blank').catch(() => {});
  keeperWindow.on('closed', () => {
    keeperWindow = null;
  });
  return keeperWindow;
}

function applyAlwaysOnTopBehavior(win) {
  if (process.platform === 'win32') {
    win.setAlwaysOnTop(true, 'pop-up-menu');
    return;
  }

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function createStealthWindow({
  bounds = null,
  show = true,
  skipTaskbar = false,
  title = 'Bilibili Stealth PiP'
} = {}) {
  return new BrowserWindow({
    show,
    x: bounds?.x,
    y: bounds?.y,
    width: bounds?.width || DEFAULT_WIDTH,
    height: bounds?.height || DEFAULT_HEIGHT,
    minWidth: 320,
    minHeight: 180,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar,
    resizable: true,
    movable: true,
    fullscreenable: false,
    title,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false
    }
  });
}

function installWindowOpenHandler(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function notifyRendererLoaded(win) {
  if (!win || win.isDestroyed()) {
    return;
  }

  win.webContents.send('stealth:loaded', {
    hiddenOpacity: HIDDEN_OPACITY,
    visibleOpacity
  });
}

function createPlayerWindow() {
  if (playerWindow && !playerWindow.isDestroyed()) {
    return playerWindow;
  }

  const win = createStealthWindow();
  playerWindow = win;
  applyAlwaysOnTopBehavior(win);
  win.setOpacity(visibleOpacity);
  pointerHidden = false;
  startPointerWatcher(win);

  installWindowOpenHandler(win);

  win.webContents.on('dom-ready', () => {
    console.log('[Bilibili Stealth PiP Native] renderer dom-ready:', win.webContents.getURL());
    notifyRendererLoaded(win);
  });

  win.webContents.on('did-finish-load', () => {
    console.log('[Bilibili Stealth PiP Native] renderer did-finish-load:', win.webContents.getURL());
    notifyRendererLoaded(win);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[Bilibili Stealth PiP Native] renderer did-fail-load:', errorCode, errorDescription, validatedURL);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Bilibili Stealth PiP Native] render-process-gone:', details);
  });

  win.on('close', () => {
    clearPlayerSessionCache('window-close', win).catch(() => {});
  });

  win.on('closed', () => {
    if (playerWindow === win) {
      if (lastPlaybackState) {
        lastPlaybackState = {
          ...lastPlaybackState,
          reason: 'window-closed',
          updatedAt: Date.now()
        };
      }
      stopPointerWatcher();
      playerWindow = null;
      lastLoadedUrl = null;
      pointerHidden = false;
    }
  });

  return win;
}

function destroyStandbyWindow(reason = 'cleanup') {
  if (standbySwap?.timeout) {
    clearTimeout(standbySwap.timeout);
  }
  if (standbySwap?.reject) {
    standbySwap.reject(new Error(`standby swap cancelled: ${reason}`));
  }
  standbySwap = null;

  if (standbyWindow && !standbyWindow.isDestroyed()) {
    standbyWindow.destroy();
  }
  standbyWindow = null;
}

function createStandbyWindow(bounds) {
  destroyStandbyWindow('replace-standby');

  const win = createStealthWindow({
    bounds,
    show: false,
    skipTaskbar: true,
    title: 'Bilibili Stealth PiP Standby'
  });
  standbyWindow = win;
  applyAlwaysOnTopBehavior(win);
  installWindowOpenHandler(win);
  win.setOpacity(0);
  win.webContents.setAudioMuted(true);

  win.webContents.on('dom-ready', () => {
    console.log('[Bilibili Stealth PiP Native] standby dom-ready:', win.webContents.getURL());
    notifyRendererLoaded(win);
  });

  win.webContents.on('did-finish-load', () => {
    console.log('[Bilibili Stealth PiP Native] standby did-finish-load:', win.webContents.getURL());
    notifyRendererLoaded(win);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[Bilibili Stealth PiP Native] standby did-fail-load:', errorCode, errorDescription, validatedURL);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Bilibili Stealth PiP Native] standby render-process-gone:', details);
  });

  win.on('closed', () => {
    if (standbyWindow === win) {
      standbyWindow = null;
    }
    if (standbySwap?.standbyWindow === win) {
      const reject = standbySwap.reject;
      if (standbySwap.timeout) {
        clearTimeout(standbySwap.timeout);
      }
      standbySwap = null;
      reject?.(new Error('standby window closed before promotion'));
    }
  });

  return win;
}

function sendStandbyPrepare(swap, targetTime = getEstimatedPlaybackTime() + STANDBY_TARGET_LEAD_SECONDS) {
  if (!swap?.standbyWindow || swap.standbyWindow.isDestroyed()) {
    return false;
  }

  swap.targetTime = targetTime;
  swap.standbyWindow.webContents.send('stealth:prepare-standby', {
    token: swap.token,
    targetTime,
    playbackRate: Number(lastPlaybackState?.playbackRate) > 0 ? Number(lastPlaybackState.playbackRate) : 1,
    brightness: Number(lastPlaybackState?.brightness) > 0 ? Number(lastPlaybackState.brightness) : 1,
    visibleOpacity,
    danmakuVisible: lastPlaybackState?.danmakuVisible ?? true,
    shouldPlay: !lastPlaybackState?.paused && !lastPlaybackState?.ended
  });
  return true;
}

function settleStandbySwap(swap, error = null, result = false) {
  if (!swap) {
    return;
  }
  if (swap.timeout) {
    clearTimeout(swap.timeout);
  }
  if (standbySwap === swap) {
    standbySwap = null;
  }
  if (error) {
    swap.reject(error);
  } else {
    swap.resolve(result);
  }
}

async function promoteStandbySwap(swap, state = {}) {
  const oldWindow = swap.oldWindow;
  const nextWindow = swap.standbyWindow;
  if (!oldWindow || oldWindow.isDestroyed() || !nextWindow || nextWindow.isDestroyed()) {
    return false;
  }

  const bounds = oldWindow.getBounds();
  const wasVisible = oldWindow.isVisible();
  const wasFocused = oldWindow.isFocused();
  const wasHidden = pointerHidden;
  const nextOpacity = getTargetOpacity(wasHidden);

  oldWindow.webContents.setAudioMuted(true);
  nextWindow.setBounds(bounds);
  nextWindow.setSkipTaskbar(false);
  nextWindow.setOpacity(nextOpacity);
  applyAlwaysOnTopBehavior(nextWindow);

  playerWindow = nextWindow;
  standbyWindow = null;
  lastLoadedUrl = swap.targetUrl;
  startPointerWatcher(nextWindow);

  nextWindow.webContents.send('stealth:promote-standby', {
    hidden: wasHidden,
    visibleOpacity,
    shouldPlay: !lastPlaybackState?.paused && !lastPlaybackState?.ended
  });
  nextWindow.webContents.setAudioMuted(wasHidden);

  if (wasVisible) {
    if (typeof nextWindow.showInactive === 'function') {
      nextWindow.showInactive();
    } else {
      nextWindow.show();
    }
  }
  if (wasFocused) {
    nextWindow.focus();
  }

  updatePlaybackState({
    ...state,
    url: nextWindow.webContents.getURL() || swap.targetUrl,
    visibleOpacity
  }, 'memory-guard-hot-swap');

  oldWindow.destroy();
  console.warn('[Bilibili Stealth PiP Native] memory guard hot swap promoted standby window');
  return true;
}

function handleStandbyReady(win, payload = {}) {
  const swap = standbySwap;
  if (!swap || win !== swap.standbyWindow || payload.token !== swap.token) {
    return;
  }

  const state = payload.state || {};
  const standbyTime = Number(state.currentTime);
  const currentTime = getEstimatedPlaybackTime();
  const drift = standbyTime - currentTime;
  const playing = state.paused === false || lastPlaybackState?.paused === true;
  const ready = playing &&
    Number.isFinite(standbyTime) &&
    drift >= -STANDBY_MAX_BEHIND_SECONDS &&
    drift <= STANDBY_MAX_AHEAD_SECONDS;

  if (!ready && swap.adjustments < STANDBY_MAX_ADJUSTMENTS) {
    swap.adjustments += 1;
    sendStandbyPrepare(swap, currentTime + STANDBY_TARGET_LEAD_SECONDS);
    return;
  }

  if (!ready) {
    settleStandbySwap(swap, new Error(`standby did not catch up, drift=${Number.isFinite(drift) ? drift.toFixed(2) : 'n/a'}s`));
    return;
  }

  promoteStandbySwap(swap, state)
    .then((result) => settleStandbySwap(swap, null, result))
    .catch((error) => settleStandbySwap(swap, error));
}

async function runStandbyHotSwap(currentUrl, pressureReason) {
  const oldWindow = playerWindow;
  if (!oldWindow || oldWindow.isDestroyed()) {
    return false;
  }

  const targetTime = getEstimatedPlaybackTime() + STANDBY_TARGET_LEAD_SECONDS;
  const targetUrl = getReloadUrlWithPlaybackTime(currentUrl, targetTime);
  const token = createSessionId();
  const standby = createStandbyWindow(oldWindow.getBounds());

  console.warn(`[Bilibili Stealth PiP Native] memory guard preparing hidden standby: ${pressureReason}, url=${targetUrl}`);

  const readyPromise = new Promise((resolve, reject) => {
    const swap = {
      token,
      oldWindow,
      standbyWindow: standby,
      targetUrl,
      targetTime,
      adjustments: 0,
      resolve,
      reject,
      timeout: null
    };
    swap.timeout = setTimeout(() => {
      settleStandbySwap(swap, new Error('standby ready timeout'));
    }, STANDBY_READY_TIMEOUT_MS);
    standbySwap = swap;
  });

  try {
    await standby.loadURL(targetUrl, { userAgent: CHROME_UA });
    sendStandbyPrepare(standbySwap, getEstimatedPlaybackTime() + STANDBY_TARGET_LEAD_SECONDS);
    const result = await readyPromise;
    return Boolean(result);
  } catch (error) {
    console.warn('[Bilibili Stealth PiP Native] memory guard hot swap skipped:', error.message || String(error));
    destroyStandbyWindow('hot-swap-failed');
    return false;
  }
}

async function openBilibiliVideo(rawUrl, sessionId) {
  if (!isAllowedBilibiliUrl(rawUrl)) {
    throw new Error('only Bilibili video URLs are accepted');
  }

  const url = normalizeBilibiliUrl(rawUrl);
  activeSessionId = typeof sessionId === 'string' && sessionId ? sessionId : createSessionId();
  updatePlaybackState({
    url,
    currentTime: Number(new URL(url).searchParams.get('t')) || 0,
    paused: false,
    ended: false,
    playbackRate: null
  }, 'open');

  const win = createPlayerWindow();
  keepVisibleBriefly();
  win.show();
  win.focus();

  if (lastLoadedUrl !== url) {
    if (lastLoadedUrl) {
      await clearPlayerSessionCache('before-navigation').catch(() => null);
    }
    lastLoadedUrl = url;
    win.loadURL(url, { userAgent: CHROME_UA }).catch((error) => {
      console.error('[Bilibili Stealth PiP Native] loadURL failed:', error);
    });
  }

  return { ok: true, url, sessionId: activeSessionId };
}

async function handleOpenRequest(request, response) {
  try {
    const body = await readRequestBody(request);
    const payload = body ? JSON.parse(body) : {};
    const result = await openBilibiliVideo(payload.url, payload.sessionId);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message || String(error)
    });
  }
}

function startBridgeServer() {
  if (server) {
    return server;
  }

  server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${HOST}:${PORT}`);

    if (request.method === 'OPTIONS') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      sendJson(response, 200, {
        ok: true,
        app: 'bilibili-stealth-pip-native',
        hasWindow: Boolean(playerWindow && !playerWindow.isDestroyed()),
        hidden: pointerHidden,
        visibleOpacity,
        sessionId: activeSessionId,
        playbackState: lastPlaybackState
      });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/state') {
      const cursor = screen.getCursorScreenPoint();
      const bounds = playerWindow && !playerWindow.isDestroyed() ? playerWindow.getBounds() : null;
      sendJson(response, 200, {
        ok: true,
        hasWindow: Boolean(playerWindow && !playerWindow.isDestroyed()),
        hidden: pointerHidden,
        sessionId: activeSessionId,
        visibleOpacity,
        opacity: playerWindow && !playerWindow.isDestroyed() ? playerWindow.getOpacity() : null,
        cursor,
        bounds,
        cursorInsideWindow: bounds ? pointInBounds(cursor, bounds) : false,
        playbackState: lastPlaybackState
      });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/playback-state') {
      sendJson(response, 200, getWindowPlaybackPayload());
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/memory') {
      const snapshot = await collectMemorySnapshot('http');
      sendJson(response, 200, {
        ...snapshot,
        guard: {
          rendererThresholdMiB: MEMORY_GUARD_RENDERER_THRESHOLD_MIB,
          totalThresholdMiB: MEMORY_GUARD_TOTAL_THRESHOLD_MIB,
          cooldownMs: MEMORY_GUARD_COOLDOWN_MS,
          lastGuardAt: lastMemoryGuardAt || null,
          pressure: getMemoryPressureReason(snapshot)
        }
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/cleanup') {
      const result = await clearPlayerSessionCache('http-cleanup');
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/hot-swap') {
      const currentUrl = playerWindow && !playerWindow.isDestroyed() ? playerWindow.webContents.getURL() || lastLoadedUrl || '' : '';
      if (!currentUrl || !isAllowedBilibiliUrl(currentUrl)) {
        sendJson(response, 400, {
          ok: false,
          error: 'no active Bilibili player window'
        });
        return;
      }

      const swapped = await runStandbyHotSwap(currentUrl, 'manual-http');
      sendJson(response, swapped ? 200 : 500, {
        ok: swapped
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/open') {
      handleOpenRequest(request, response);
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: 'not found'
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`[Bilibili Stealth PiP Native] listening on http://${HOST}:${PORT}`);
  });

  server.on('error', (error) => {
    console.error('[Bilibili Stealth PiP Native] server error:', error);
  });

  return server;
}



ipcMain.on('stealth:playback-state', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win !== playerWindow) {
    return;
  }
  updatePlaybackState(payload, payload?.reason || 'renderer');
});

ipcMain.on('stealth:set-hidden', (event, isHidden) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win !== playerWindow) {
    return;
  }
  applyWindowOpacity(win, Boolean(isHidden), 'renderer-event');
});

ipcMain.on('stealth:set-visible-opacity', (event, value) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win !== playerWindow) {
    return;
  }

  visibleOpacity = clampOpacity(value);
  if (!pointerHidden) {
    win.setOpacity(visibleOpacity);
  }
});

ipcMain.on('stealth:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win === playerWindow) {
    win.close();
  }
});

ipcMain.on('stealth:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win === playerWindow) {
    win.minimize();
  }
});

ipcMain.on('stealth:standby-ready', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) {
    return;
  }
  handleStandbyReady(win, payload);
});

app.whenReady().then(() => {
  createKeeperWindow();
  startBridgeServer();
  startMemoryMonitoring();
  keepAliveTimer = setInterval(() => {}, 60 * 60 * 1000);

  globalShortcut.register('CommandOrControl+Shift+B', () => {
    if (playerWindow && !playerWindow.isDestroyed()) {
      keepVisibleBriefly(4000);
      playerWindow.show();
      playerWindow.focus();
    }
  });

  app.on('activate', () => {
    if (playerWindow) {
      playerWindow.show();
      playerWindow.focus();
    }
  });
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  stopPointerWatcher();
  stopMemoryMonitoring();
  destroyStandbyWindow('before-quit');
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (keeperWindow && !keeperWindow.isDestroyed()) {
    keeperWindow.destroy();
    keeperWindow = null;
  }
  if (server) {
    server.close();
    server = null;
  }
});

app.on('window-all-closed', () => {
  // Keep the local bridge alive until the terminal process is stopped.
  createKeeperWindow();
});
