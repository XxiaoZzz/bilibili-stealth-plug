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
const ALLOWED_URL_PREFIXES = [
  'https://www.bilibili.com/video/',
  'https://m.bilibili.com/video/'
];
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

let server = null;
let playerWindow = null;
let keeperWindow = null;
let lastLoadedUrl = null;
let pointerWatchTimer = null;
let pointerHidden = false;
let forceVisibleUntil = 0;
let keepAliveTimer = null;
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
    reason,
    updatedAt: Date.now()
  };
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

function createPlayerWindow() {
  if (playerWindow && !playerWindow.isDestroyed()) {
    return playerWindow;
  }

  playerWindow = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: 320,
    minHeight: 180,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    movable: true,
    fullscreenable: false,
    title: 'Bilibili Stealth PiP',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  });

  if (process.platform === 'win32') {
    playerWindow.setAlwaysOnTop(true, 'pop-up-menu');
  } else {
    playerWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    playerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  playerWindow.setOpacity(visibleOpacity);
  pointerHidden = false;
  startPointerWatcher(playerWindow);

  playerWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const notifyRendererLoaded = () => {
    playerWindow?.webContents.send('stealth:loaded', {
      hiddenOpacity: HIDDEN_OPACITY,
      visibleOpacity
    });
  };

  playerWindow.webContents.on('dom-ready', () => {
    console.log('[Bilibili Stealth PiP Native] renderer dom-ready:', playerWindow?.webContents.getURL());
    notifyRendererLoaded();
  });

  playerWindow.webContents.on('did-finish-load', () => {
    console.log('[Bilibili Stealth PiP Native] renderer did-finish-load:', playerWindow?.webContents.getURL());
    notifyRendererLoaded();
  });

  playerWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[Bilibili Stealth PiP Native] renderer did-fail-load:', errorCode, errorDescription, validatedURL);
  });

  playerWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Bilibili Stealth PiP Native] render-process-gone:', details);
  });


  playerWindow.on('closed', () => {
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
  });

  return playerWindow;
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
  if (!win || win.isDestroyed()) {
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
  win?.close();
});

ipcMain.on('stealth:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.minimize();
});

app.whenReady().then(() => {
  createKeeperWindow();
  startBridgeServer();
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
