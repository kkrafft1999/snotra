'use strict';

/**
 * The help window (#790): the user manual that ships with the app, rendered
 * by `src/renderer/manual.html`.
 *
 * One window at most. *Help › User manual* opens it, or brings it to the front
 * and turns to the page asked for. Its page gets its own preload and its own
 * channels (`src/shared/manual-channels.js`); the app window's channels refuse
 * it like any other sender, since it is not the app's renderer URL.
 */

const path = require('path');
const { MANUAL_REQUEST_CHANNELS: REQ, MANUAL_PUSH_CHANNELS: PUSH } = require('../shared/manual-channels');
const { isManualRendererUrl } = require('./permissions');
const { guardIpcMain } = require('./ipc/trusted-sender');
const { matchPreviewHistoryShortcut } = require('./services/preview-history-shortcut');
const { manualWebUrl, normalizeManualLocale, MANUAL_WEB_BASE } = require('./services/manual-service');

const projectRoot = path.join(__dirname, '..', '..');
const WINDOW_BACKGROUND = '#FFFCF5';
const SHOW_FALLBACK_MS = 3000;

/** Only the top frame of the help page may call the manual channels. */
function isManualIpcSender(event) {
  let frame;
  try {
    frame = event?.senderFrame;
  } catch {
    return false;
  }
  if (!frame || frame.parent) return false;
  return isManualRendererUrl(frame.url);
}

/** Links of the manual that leave it: https only, nothing the OS would run. */
function isManualExternalUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Cmd/Ctrl with +, − or 0 zooms the page text, as in the preview. Matched
 * before the menu sees the key, which would otherwise zoom the whole window.
 */
function matchManualZoomShortcut(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown' || input.alt === true) return null;
  const modifier = platform === 'darwin' ? input.meta === true && input.control !== true
    : input.control === true && input.meta !== true;
  if (!modifier) return null;
  if (input.key === '+' || input.key === '=') return 'in';
  if (input.key === '-') return 'out';
  if (input.key === '0') return 'reset';
  return null;
}

function cleanTarget(target) {
  const slug = typeof target?.slug === 'string' && target.slug ? target.slug : 'index';
  const fragment = typeof target?.fragment === 'string' ? target.fragment : '';
  return { slug, fragment };
}

function createManualWindowController({
  BrowserWindow,
  ipcMain,
  shell,
  app,
  manual,
  getLocale,
  platform = process.platform,
  log = console,
}) {
  let window = null;

  const guarded = guardIpcMain(ipcMain, { isTrustedSender: isManualIpcSender, log });
  guarded.handle(REQ.CONTEXT, () => ({
    locale: normalizeManualLocale(getLocale()),
    version: app.getVersion(),
    webBase: MANUAL_WEB_BASE,
  }));
  guarded.handle(REQ.INDEX, (_event, locale) => manual.getIndex(locale));
  guarded.handle(REQ.PAGE, (_event, locale, slug) => manual.getPage(locale, slug));
  guarded.handle(REQ.PAGES, (_event, locale) => manual.getAllPages(locale));
  guarded.handle(REQ.SCREENSHOT, (_event, motif, locale, theme) => manual.getScreenshot(motif, locale, theme));
  guarded.handle(REQ.OPEN_EXTERNAL, async (_event, url) => {
    if (!isManualExternalUrl(url)) return false;
    await shell.openExternal(url.trim());
    return true;
  });

  function send(channel, payload) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }

  function create(target) {
    const created = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 480,
      minHeight: 360,
      title: 'Snotra Agent',
      backgroundColor: WINDOW_BACKGROUND,
      show: false,
      webPreferences: {
        preload: path.join(projectRoot, 'src', 'preload', 'manual-bundle.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    let shown = false;
    const show = () => {
      if (shown || created.isDestroyed()) return;
      shown = true;
      clearTimeout(showFallback);
      created.show();
    };
    const showFallback = setTimeout(show, SHOW_FALLBACK_MS);
    created.once('ready-to-show', show);

    // Nothing but the help page itself; links go through OPEN_EXTERNAL.
    created.webContents.on('will-navigate', (event, url) => {
      if (!isManualRendererUrl(url)) event.preventDefault();
    });
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (isManualExternalUrl(url)) {
        shell.openExternal(url.trim()).catch((error) => log.error?.('openExternal failed:', url, error));
      }
      return { action: 'deny' };
    });
    created.webContents.on('before-input-event', (event, input) => {
      const direction = matchPreviewHistoryShortcut(input, platform);
      if (direction) {
        event.preventDefault();
        if (input.isAutoRepeat !== true) send(PUSH.HISTORY, direction);
        return;
      }
      const zoom = matchManualZoomShortcut(input, platform);
      if (zoom) {
        event.preventDefault();
        send(PUSH.ZOOM, zoom);
      }
    });
    created.on('closed', () => {
      clearTimeout(showFallback);
      if (window === created) window = null;
    });

    const { slug, fragment } = cleanTarget(target);
    created.loadFile(path.join(projectRoot, 'src', 'renderer', 'manual.html'), {
      query: { page: slug, ...(fragment ? { section: fragment } : {}) },
    });
    window = created;
    return created;
  }

  /**
   * Opens the manual on a page — the overview unless `target` names one. With
   * no bundled manual, the web version opens in the browser instead.
   */
  function open(target) {
    const clean = cleanTarget(target);
    if (!manual.isAvailable()) {
      void shell.openExternal(manualWebUrl(getLocale(), clean.slug, clean.fragment));
      return null;
    }
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      if (target) send(PUSH.NAVIGATE, clean);
      return window;
    }
    return create(target);
  }

  return {
    open,
    getWindow: () => (window && !window.isDestroyed() ? window : null),
    isManualWindow: (candidate) => Boolean(candidate) && candidate === window,
    /** The View menu's Back and Forward, when the help window has the focus. */
    stepHistory: (direction) => send(PUSH.HISTORY, direction),
    onLocaleChanged: () => send(PUSH.LOCALE, normalizeManualLocale(getLocale())),
    close: () => {
      if (window && !window.isDestroyed()) window.close();
    },
  };
}

module.exports = {
  createManualWindowController,
  isManualIpcSender,
  isManualExternalUrl,
  matchManualZoomShortcut,
};
