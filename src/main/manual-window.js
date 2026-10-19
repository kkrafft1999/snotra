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
const { isManualRendererUrl, MANUAL_URL } = require('./permissions');
const { guardIpcMain } = require('./ipc/trusted-sender');
const { matchPreviewHistoryShortcut } = require('./services/preview-history-shortcut');
const { manualWebUrl, normalizeManualLocale, MANUAL_WEB_BASE } = require('./services/manual-service');

const projectRoot = path.join(__dirname, '..', '..');
const WINDOW_BACKGROUND = '#FFFCF5';
const SHOW_FALLBACK_MS = 3000;

/**
 * A page and section as the help window is asked for them.
 *
 * @typedef {{ slug?: unknown, fragment?: unknown }} ManualTarget
 * @typedef {{ slug: string, fragment: string }} CleanTarget
 */

/**
 * Only the top frame of the help page may call the manual channels.
 *
 * @param {{ senderFrame?: { parent?: unknown, url: string }|null }|null|undefined} event
 */
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

/**
 * Links of the manual that leave it: https only, nothing the OS would run.
 *
 * @param {unknown} url
 */
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
 *
 * @param {{ type?: string, alt?: boolean, meta?: boolean, control?: boolean, key?: string }|null|undefined} input
 * @param {string} [platform]
 * @returns {'in'|'out'|'reset'|null}
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

/**
 * @param {ManualTarget|null|undefined} target
 * @returns {CleanTarget}
 */
function cleanTarget(target) {
  const slug = typeof target?.slug === 'string' && target.slug ? target.slug : 'index';
  const fragment = typeof target?.fragment === 'string' ? target.fragment : '';
  return { slug, fragment };
}

/**
 * @param {object} deps
 * @param {typeof import('electron').BrowserWindow} deps.BrowserWindow
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} deps.ipcMain
 * @param {Pick<import('electron').Shell, 'openExternal'>} deps.shell
 * @param {Pick<import('electron').App, 'getVersion'>} deps.app
 * @param {Pick<ReturnType<typeof import('./services/manual-service').createManualService>,
 *   'isAvailable' | 'getIndex' | 'getPage' | 'getAllPages' | 'getScreenshot'>} deps.manual
 * @param {() => unknown} deps.getLocale
 * @param {string} [deps.platform]
 * @param {{ warn?: (message: string) => void, error?: (...args: unknown[]) => void }} [deps.log]
 */
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
  /** @type {import('electron').BrowserWindow|null} */
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

  /**
   * @param {string} channel
   * @param {unknown} payload
   */
  function send(channel, payload) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }

  /** @param {ManualTarget} [target] */
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
    const query = new URLSearchParams({ page: slug, ...(fragment ? { section: fragment } : {}) });
    created.loadURL(`${MANUAL_URL}?${query}`);
    window = created;
    return created;
  }

  /**
   * Opens the manual on a page — the overview unless `target` names one. With
   * no bundled manual, the web version opens in the browser instead.
   *
   * @param {ManualTarget} [target]
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
    /** @param {unknown} candidate */
    isManualWindow: (candidate) => Boolean(candidate) && candidate === window,
    /** The View menu's Back and Forward, when the help window has the focus. */
    /** @param {string} direction */
    stepHistory: (direction) => send(PUSH.HISTORY, direction),
    onLocaleChanged: () => send(PUSH.LOCALE, normalizeManualLocale(getLocale())),
    close: () => {
      if (window && !window.isDestroyed()) window.close();
    },
  };
}

const HELP_SLUG = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const HELP_FRAGMENT = /^[\p{L}\p{N}_-]{0,120}$/u;

/**
 * A page and section the app window may ask for: the shape a heading slug has, nothing else.
 *
 * @param {ManualTarget|null|undefined} target
 * @returns {CleanTarget|null}
 */
function cleanHelpTarget(target) {
  if (!target || typeof target !== 'object') return null;
  const { slug, fragment = '' } = target;
  if (typeof slug !== 'string' || !HELP_SLUG.test(slug)) return null;
  if (typeof fragment !== 'string' || !HELP_FRAGMENT.test(fragment)) return null;
  return { slug, fragment };
}

/**
 * The help links next to the settings (#848): the app window asks for a page
 * and section, and the help window opens there — or turns to it.
 *
 * @param {object} deps
 * @param {import('./ipc/trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {Record<string, string>} deps.REQ
 * @param {(target: CleanTarget) => unknown} deps.open
 * @param {(slug: string) => boolean} [deps.hasPage]
 */
function registerManualOpenHandler({ ipcMain, REQ, open, hasPage = () => true }) {
  ipcMain.handle(REQ.MANUAL_OPEN, (_event, target) => {
    const clean = cleanHelpTarget(target);
    // A link from the chat may name a page this version does not ship (#947);
    // then the caller opens the address in the browser instead.
    if (!clean || !hasPage(clean.slug)) return { ok: false };
    open(clean);
    return { ok: true };
  });
}

module.exports = {
  createManualWindowController,
  registerManualOpenHandler,
  cleanHelpTarget,
  isManualIpcSender,
  isManualExternalUrl,
  matchManualZoomShortcut,
};
