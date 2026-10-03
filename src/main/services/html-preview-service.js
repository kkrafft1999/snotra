'use strict';

// HTML files as live pages in the file preview (#479).
//
// The page runs, scripts included, but nowhere near the app:
//
//   * its own `WebContentsView`, laid by main over the preview column — its
//     own renderer process, no preload, `sandbox`, `contextIsolation`, no
//     Node. The app's renderer keeps its CSP and its `webPreferences`; an
//     `<iframe>` would have needed both relaxed (`frame-src`, `script-src`).
//   * its own in-memory session. Nothing the page stores outlives the app,
//     and every page gets a host of its own, so no two pages share an origin.
//   * its own scheme, `snotra-html:`, which only that session knows. The URL
//     carries the absolute path of the file, so `../../..` and `/etc/x`
//     resolve to paths outside the folder and are refused by name instead of
//     being clamped to the root without a word.
//   * no network. Every request that is not `snotra-html:`, `data:`, `blob:`
//     or `about:` is cancelled and listed; a proxy that leads nowhere and the
//     WebRTC policy catch what does not pass `webRequest`.
//   * no permissions, no downloads, no dialogs, no popups, no navigation of
//     its own: a link leads out only after a click — another HTML file of the
//     folder opens in the preview, a web address in the browser.
//
// The renderer only says which file and where the view goes; it never sees a
// byte of the page. Main reads every file through the same checks as images
// and PDFs (`readWorkspaceFile`: inside the folder lexically and after
// `realpath`, a regular file, a size limit).

const nodePath = require('path');
const { randomBytes } = require('crypto');
const {
  HTML_PREVIEW_SCHEME,
  HTML_PREVIEW_PARTITION,
  MAX_HTML_PREVIEW_BYTES,
  MAX_HTML_ASSET_BYTES,
  MAX_HTML_PREVIEW_BLOCKED,
  HTML_PREVIEW_ERRORS: ERRORS,
  HTML_PREVIEW_BLOCK_REASONS: BLOCK,
  isHtmlFileName,
  htmlPreviewMimeType,
} = require('../../shared/contracts/html-preview');
const { isOpenableUrl } = require('../../shared/contracts/links');

const SCHEME_PREFIX = `${HTML_PREVIEW_SCHEME}:`;

// What never leaves the machine. `about:` for `about:blank` frames.
const LOCAL_SCHEMES = new Set([SCHEME_PREFIX, 'data:', 'blob:', 'about:']);

// A link leads out of the page only this long after a click or a key press:
// `location = 'https://…?' + document.body.innerText` must not open a tab.
const GESTURE_WINDOW_MS = 1000;
const GESTURE_INPUTS = new Set(['mouseDown', 'mouseUp', 'rawKeyDown', 'keyDown', 'gestureTap', 'touchEnd']);

// A page that does not answer within this time is taken to be stuck, and a
// reload starts its process anew instead of waiting on it.
const SCROLL_READ_TIMEOUT_MS = 500;

// The isolated world for reading and restoring the scroll position: the
// page's own script can neither see nor fake what runs there.
const ISOLATED_WORLD_ID = 1479;

const BLOCKED_PUSH_DELAY_MS = 100;
const MAX_LISTED_URL_LENGTH = 400;

// Requests that slip past `webRequest` — WebRTC over TCP, a preconnect — go
// to a proxy that is not there.
const NOWHERE_PROXY = 'http://127.0.0.1:9';

// Window coordinates beyond any screen are no position.
const MAX_COORDINATE = 100000;

const STATUS_FOR_REASON = {
  [ERRORS.OUTSIDE_WORKSPACE]: 403,
  [ERRORS.TOO_LARGE]: 413,
};

/** The scheme for the app's start, before `app.whenReady()`. */
const HTML_PREVIEW_SCHEME_PRIVILEGES = Object.freeze({
  scheme: HTML_PREVIEW_SCHEME,
  // `standard` for relative URLs and an origin per host, `secure` for the
  // APIs a page expects (`crypto.randomUUID`), fetch and CORS for a page that
  // reads `data.json` next to it. No service workers, no bypass of any CSP.
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
});

function schemeOf(url) {
  const match = /^([a-z][a-z0-9+.-]*:)/i.exec(String(url ?? ''));
  return match ? match[1].toLowerCase() : '';
}

/** The segments of an absolute path as they go into the URL, or null. */
function pathSegments(absPath, platform) {
  if (platform === 'win32') {
    const resolved = nodePath.win32.resolve(absPath);
    // A drive path only; a UNC share has no place in this scheme.
    if (!/^[A-Za-z]:\\/.test(resolved)) return null;
    const [drive, ...rest] = resolved.split('\\');
    return [drive, ...rest.filter(Boolean)];
  }
  return nodePath.posix.resolve(absPath).split('/').slice(1).filter(Boolean);
}

function previewUrl(host, absPath, platform) {
  const segments = pathSegments(absPath, platform);
  if (!segments) return null;
  return `${HTML_PREVIEW_SCHEME}://${host}/${segments.map(encodeURIComponent).join('/')}`;
}

/**
 * `{ host, absPath, fragment }` for a URL of the scheme, null for anything
 * else. `absPath` is null when the path cannot be a file — an encoded
 * separator, or on Windows no drive in front.
 */
function parsePreviewUrl(rawUrl, platform) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== SCHEME_PREFIX) return null;
  const fragment = url.hash ? safeDecode(url.hash.slice(1)) ?? '' : '';
  const base = { host: url.host.toLowerCase(), absPath: null, fragment };
  const segments = url.pathname.split('/').slice(1).filter(Boolean).map(safeDecode);
  if (segments.some((segment) => segment === null || /[\\/\0]/.test(segment))) return base;
  if (platform === 'win32') {
    const [drive, ...rest] = segments;
    if (!/^[A-Za-z]:$/.test(drive ?? '')) return base;
    return { ...base, absPath: nodePath.win32.join(`${drive}\\`, ...rest) };
  }
  return { ...base, absPath: `/${segments.join('/')}` };
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function createHtmlPreviewService({
  session,
  WebContentsView,
  shell,
  getMainWindow,
  getWorkspaceRoot,
  // (root, absPath, maxBytes) → { buffer, stats } | { reason, size? }
  readWorkspaceFile,
  // (absPath) → { absPath } | { error } — the folder check of the tree's menu.
  resolveCheckedWorkspacePath,
  stat,
  push = () => {},
  platform = process.platform,
  now = Date.now,
  newHost = () => randomBytes(16).toString('hex'),
  log = console,
}) {
  const path = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const pages = new Map();
  const pagesByContents = new Map();
  let sessionReady = null;
  let watchedWindow = null;

  function setUpSession() {
    const ses = session.fromPartition(HTML_PREVIEW_PARTITION);
    ses.protocol.handle(HTML_PREVIEW_SCHEME, (request) => serve(request));
    ses.webRequest.onBeforeRequest((details, callback) => {
      const scheme = schemeOf(details.url);
      if (LOCAL_SCHEMES.has(scheme)) {
        callback({});
        return;
      }
      const page = pagesByContents.get(details.webContentsId);
      if (page) record(page, details.url, scheme === 'file:' ? BLOCK.OUTSIDE_WORKSPACE : BLOCK.NETWORK);
      callback({ cancel: true });
    });
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler?.(() => false);
    ses.on('will-download', (event, item, contents) => {
      event.preventDefault();
      const page = pagesByContents.get(contents?.id);
      if (page) record(page, item?.getURL?.() ?? '', BLOCK.DOWNLOAD);
    });
    // The spell checker would fetch its dictionaries from the web.
    ses.setSpellCheckerEnabled?.(false);
    return Promise.resolve(ses.setProxy?.({ mode: 'fixed_servers', proxyRules: NOWHERE_PROXY, proxyBypassRules: '' }))
      .catch((err) => log.warn?.('HTML preview: the proxy could not be set:', err?.message ?? err))
      .then(() => ses);
  }

  function ensureSession() {
    if (!sessionReady) sessionReady = setUpSession();
    return sessionReady;
  }

  // ── What the page gets ──────────────────────────────────────────────────

  async function serve(request) {
    const target = parsePreviewUrl(request.url, platform);
    const page = target ? pages.get(target.host) : null;
    if (!page) return new Response(null, { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    if (!target.absPath) {
      // On Windows `../../..` climbs above the drive: no file path, but the
      // notice still says where it pointed.
      record(page, safeDecode(new URL(request.url).pathname) ?? request.url, BLOCK.OUTSIDE_WORKSPACE);
      return new Response(null, { status: 403 });
    }
    const max = isHtmlFileName(target.absPath) ? MAX_HTML_PREVIEW_BYTES : MAX_HTML_ASSET_BYTES;
    let read;
    try {
      read = await readWorkspaceFile(page.root, target.absPath, max);
    } catch {
      read = { reason: ERRORS.NOT_FOUND };
    }
    if (read.reason) {
      if (read.reason === ERRORS.NOT_FOUND) page.missing.add(target.absPath);
      record(page, describeLocal(page, target.absPath), blockReasonFor(read.reason));
      return new Response(null, { status: STATUS_FOR_REASON[read.reason] ?? 404 });
    }
    page.resources.set(target.absPath, { size: read.stats.size, mtimeMs: read.stats.mtimeMs });
    return new Response(request.method === 'HEAD' ? null : read.buffer, {
      status: 200,
      headers: {
        'Content-Type': htmlPreviewMimeType(target.absPath),
        'Content-Length': String(read.stats.size),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  function blockReasonFor(reason) {
    if (reason === ERRORS.TOO_LARGE) return BLOCK.TOO_LARGE;
    if (reason === ERRORS.OUTSIDE_WORKSPACE || reason === ERRORS.NO_WORKSPACE) return BLOCK.OUTSIDE_WORKSPACE;
    return BLOCK.NOT_FOUND;
  }

  /** A local path as the notice lists it: relative to the folder, else as it is. */
  function describeLocal(page, absPath) {
    const relative = path.relative(page.root, absPath);
    const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    return inside ? relative.split(path.sep).join('/') : absPath;
  }

  // ── What the page was refused ───────────────────────────────────────────

  function record(page, url, reason) {
    const text = String(url ?? '').slice(0, MAX_LISTED_URL_LENGTH);
    const key = `${reason} ${text}`;
    if (page.blockedKeys.has(key)) return;
    page.blockedKeys.add(key);
    page.blockedTotal += 1;
    if (page.blocked.length < MAX_HTML_PREVIEW_BLOCKED) page.blocked.push({ url: text, reason });
    scheduleBlockedPush(page);
  }

  function scheduleBlockedPush(page) {
    if (page.blockedTimer) return;
    page.blockedTimer = setTimeout(() => {
      page.blockedTimer = null;
      pushBlocked(page);
    }, BLOCKED_PUSH_DELAY_MS);
  }

  function pushBlocked(page) {
    if (page.closed) return;
    push({ id: page.host, type: 'blocked', entries: page.blocked.slice(), total: page.blockedTotal });
  }

  /** A new document: what the old one asked for is no longer of interest. */
  function resetDocument(page) {
    page.resources.clear();
    page.missing.clear();
    page.blocked = [];
    page.blockedKeys.clear();
    page.blockedTotal = 0;
    clearTimeout(page.blockedTimer);
    page.blockedTimer = null;
    pushBlocked(page);
  }

  // ── Where the page may go ───────────────────────────────────────────────

  function consumeGesture(page) {
    const fresh = page.gestureAt > 0 && now() - page.gestureAt <= GESTURE_WINDOW_MS;
    page.gestureAt = 0;
    return fresh;
  }

  /** A link the page wants followed: never inside the view, only after a click. */
  function follow(page, rawUrl) {
    const gesture = consumeGesture(page);
    const target = parsePreviewUrl(rawUrl, platform);
    if (target) {
      if (target.host !== page.host || !target.absPath) {
        record(page, rawUrl, BLOCK.OUTSIDE_WORKSPACE);
        return;
      }
      if (!gesture) {
        record(page, describeLocal(page, target.absPath), BLOCK.NAVIGATION);
        return;
      }
      push({ id: page.host, type: 'open-file', path: target.absPath, fragment: target.fragment });
      return;
    }
    if (isOpenableUrl(rawUrl)) {
      if (!gesture) {
        record(page, rawUrl, BLOCK.NAVIGATION);
        return;
      }
      Promise.resolve(shell?.openExternal?.(String(rawUrl).trim()))
        .catch((err) => log.warn?.('HTML preview: openExternal failed:', err?.message ?? err));
      return;
    }
    record(page, rawUrl, schemeOf(rawUrl) === 'file:' ? BLOCK.OUTSIDE_WORKSPACE : BLOCK.NETWORK);
  }

  function onWillFrameNavigate(page, details) {
    const url = details?.url ?? '';
    const target = parsePreviewUrl(url, platform);
    const own = Boolean(target && target.host === page.host && target.absPath);
    if (details?.isMainFrame) {
      // The page reloading itself stays; anything else leaves the view.
      if (own && target.absPath === page.filePath) return;
      details.preventDefault?.();
      follow(page, url);
      return;
    }
    // A frame inside the page may show its own files and inline content —
    // not those of another page's host.
    const scheme = schemeOf(url);
    if (own || (scheme !== SCHEME_PREFIX && LOCAL_SCHEMES.has(scheme))) return;
    details.preventDefault?.();
    record(page, url, schemeOf(url) === 'file:' ? BLOCK.OUTSIDE_WORKSPACE : BLOCK.NETWORK);
  }

  // ── The view ────────────────────────────────────────────────────────────

  function watchWindow(win) {
    if (watchedWindow === win) return;
    watchedWindow = win;
    // A renderer that reloads or dies has lost its views; they must not
    // stay on top of a pane that no longer knows them.
    win.webContents.on('did-start-navigation', (details) => {
      if (details?.isMainFrame !== false && !details?.isSameDocument) closeAll();
    });
    win.webContents.on('render-process-gone', () => closeAll());
    win.on('closed', () => {
      closeAll();
      if (watchedWindow === win) watchedWindow = null;
    });
  }

  function createView(page, ses, win) {
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        javascript: true,
        disableDialogs: true,
        navigateOnDragDrop: false,
        spellcheck: false,
        devTools: false,
        autoplayPolicy: 'user-gesture-required',
      },
    });
    // The page is shown as authored; white is what a browser puts behind one.
    view.setBackgroundColor?.('#FFFFFF');
    view.setVisible(false);
    const contents = view.webContents;
    contents.setWebRTCIPHandlingPolicy?.('disable_non_proxied_udp');
    contents.setWindowOpenHandler(({ url }) => {
      follow(page, url);
      return { action: 'deny' };
    });
    contents.on('will-frame-navigate', (details) => onWillFrameNavigate(page, details));
    contents.on('did-start-navigation', (details) => {
      if (details?.isMainFrame && !details.isSameDocument) resetDocument(page);
    });
    contents.on('input-event', (_event, input) => {
      if (GESTURE_INPUTS.has(input?.type)) page.gestureAt = now();
    });
    // F6 leaves the page, as it moves between panes in a browser. Tab stays
    // the page's own.
    contents.on('before-input-event', (event, input) => {
      if (input?.type !== 'keyDown' || input.key !== 'F6' || input.control || input.meta || input.alt) return;
      event.preventDefault();
      const main = getMainWindow();
      if (main && !main.isDestroyed()) main.webContents.focus();
      push({ id: page.host, type: 'focus-leave', reverse: input.shift === true });
    });
    contents.on('did-finish-load', () => {
      const scroll = page.restoreScroll;
      page.restoreScroll = null;
      if (scroll) {
        const [x, y] = scroll;
        contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: `window.scrollTo(${x}, ${y})` }])
          .catch(() => {});
      }
      push({ id: page.host, type: 'loaded' });
    });
    contents.on('unresponsive', () => {
      page.unresponsive = true;
      push({ id: page.host, type: 'unresponsive' });
    });
    contents.on('responsive', () => {
      page.unresponsive = false;
      push({ id: page.host, type: 'responsive' });
    });
    contents.on('render-process-gone', (_event, details) => {
      // A process ended on purpose, by a reload of a stuck page, is no news.
      if (page.closed) return;
      if (page.expectedExits > 0) {
        page.expectedExits -= 1;
        return;
      }
      push({ id: page.host, type: 'gone', reason: details?.reason ?? '' });
    });
    win.contentView.addChildView(view);
    return view;
  }

  function load(page, { fragment = '', scroll = null } = {}) {
    let url = page.url;
    if (fragment) {
      const withFragment = new URL(page.url);
      withFragment.hash = fragment;
      url = withFragment.href;
    }
    page.restoreScroll = scroll;
    resetDocument(page);
    page.view.webContents.loadURL(url).catch(() => {
      // An aborted load — a reload overtaking it, a page closed meanwhile —
      // is no failure worth a word; a page that is not there shows empty.
    });
  }

  /**
   * Opens `filePath` as a page. Answers `{ ok: true, id, size, mtimeMs }`
   * or `{ ok: false, reason, size? }` with a reason of HTML_PREVIEW_ERRORS.
   */
  async function open(filePath, { fragment = '' } = {}) {
    const root = getWorkspaceRoot();
    if (typeof root !== 'string' || !root) return { ok: false, reason: ERRORS.NO_WORKSPACE };
    if (typeof filePath !== 'string' || !filePath.trim() || !isHtmlFileName(filePath)) {
      return { ok: false, reason: ERRORS.NOT_FOUND };
    }
    const absPath = path.resolve(root, filePath);
    let checked;
    try {
      checked = await readWorkspaceFile(root, absPath, MAX_HTML_PREVIEW_BYTES);
    } catch {
      checked = { reason: ERRORS.NOT_FOUND };
    }
    if (checked.reason) {
      return { ok: false, reason: checked.reason, ...(Number.isFinite(checked.size) ? { size: checked.size } : {}) };
    }
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, reason: ERRORS.UNAVAILABLE };
    const host = newHost();
    const url = previewUrl(host, absPath, platform);
    if (!url) return { ok: false, reason: ERRORS.UNAVAILABLE };
    const page = {
      host,
      root: path.resolve(root),
      filePath: absPath,
      url,
      view: null,
      resources: new Map(),
      missing: new Set(),
      blocked: [],
      blockedKeys: new Set(),
      blockedTotal: 0,
      blockedTimer: null,
      gestureAt: 0,
      restoreScroll: null,
      unresponsive: false,
      expectedExits: 0,
      closed: false,
    };
    try {
      const ses = await ensureSession();
      watchWindow(win);
      page.view = createView(page, ses, win);
    } catch (err) {
      log.error?.('HTML preview: the view could not be created:', err);
      return { ok: false, reason: ERRORS.UNAVAILABLE };
    }
    pages.set(host, page);
    pagesByContents.set(page.view.webContents.id, page);
    load(page, { fragment: typeof fragment === 'string' ? fragment : '' });
    return { ok: true, id: host, size: checked.stats.size, mtimeMs: checked.stats.mtimeMs };
  }

  function livePage(id) {
    const page = pages.get(id);
    if (!page || page.closed) return null;
    if (page.view.webContents.isDestroyed?.()) {
      close(id);
      return null;
    }
    return page;
  }

  /**
   * Where the view goes, in the renderer's CSS pixels; null hides it. Main
   * turns them into window coordinates with the window's zoom.
   */
  function setBounds(id, bounds) {
    const page = livePage(id);
    if (!page) return { ok: false };
    const rect = windowRect(bounds);
    if (!rect) {
      page.view.setVisible(false);
      return { ok: true, visible: false };
    }
    page.view.setBounds(rect);
    page.view.setVisible(true);
    return { ok: true, visible: true };
  }

  function windowRect(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;
    const { x, y, width, height } = bounds;
    const sane = (v) => Number.isFinite(v) && v >= 0 && v <= MAX_COORDINATE;
    if (![x, y, width, height].every(sane) || width < 1 || height < 1) return null;
    const win = getMainWindow();
    const zoom = win && !win.isDestroyed() ? win.webContents.getZoomFactor() : 1;
    const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const left = Math.round(x * factor);
    const top = Math.round(y * factor);
    return {
      x: left,
      y: top,
      width: Math.max(1, Math.round((x + width) * factor) - left),
      height: Math.max(1, Math.round((y + height) * factor) - top),
    };
  }

  /** `[x, y]`, null when the page has none, 'stuck' when it does not answer. */
  async function readScroll(page) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('stuck'), SCROLL_READ_TIMEOUT_MS);
    });
    const read = page.view.webContents
      .executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: '[window.scrollX, window.scrollY]' }])
      .then((value) => (Array.isArray(value) && value.every(Number.isFinite) ? value : null), () => null);
    try {
      return await Promise.race([read, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Loads the page again, where it was scrolled to. A page that does not
   * answer — an endless loop — gets a fresh process instead of a wait.
   */
  async function reload(id) {
    const page = livePage(id);
    if (!page) return { ok: false };
    let scroll = page.unresponsive ? 'stuck' : await readScroll(page);
    if (scroll === 'stuck') {
      try {
        page.view.webContents.forcefullyCrashRenderer();
        page.expectedExits += 1;
      } catch {
        // Already gone.
      }
      page.unresponsive = false;
      scroll = null;
    }
    if (page.closed) return { ok: false };
    load(page, { scroll });
    return { ok: true };
  }

  async function statOrNull(absPath) {
    try {
      const stats = await stat(absPath);
      return stats.isFile?.() === false ? null : stats;
    } catch {
      return null;
    }
  }

  /**
   * The file or something it loaded may have changed on disk: reloads when
   * the page, one of its files, or a file it missed differs. Answers
   * `{ ok: true, reloaded, size, mtimeMs }`, or `{ ok: false, reason, size? }`
   * when the page itself can no longer be shown.
   */
  async function check(id) {
    const page = livePage(id);
    if (!page) return { ok: false, reason: ERRORS.UNAVAILABLE };
    const own = await statOrNull(page.filePath);
    if (!own) return { ok: false, reason: ERRORS.NOT_FOUND };
    if (own.size > MAX_HTML_PREVIEW_BYTES) return { ok: false, reason: ERRORS.TOO_LARGE, size: own.size };
    let changed = false;
    for (const [absPath, seen] of page.resources) {
      const stats = await statOrNull(absPath);
      if (!stats || stats.size !== seen.size || stats.mtimeMs !== seen.mtimeMs) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      for (const absPath of page.missing) {
        if (await statOrNull(absPath)) {
          changed = true;
          break;
        }
      }
    }
    if (page.closed) return { ok: false, reason: ERRORS.UNAVAILABLE };
    if (changed) await reload(id);
    return { ok: true, reloaded: changed, size: own.size, mtimeMs: own.mtimeMs };
  }

  function focus(id) {
    const page = livePage(id);
    if (!page) return { ok: false };
    page.view.webContents.focus();
    return { ok: true };
  }

  function close(id) {
    const page = pages.get(id);
    if (!page) return { ok: false };
    page.closed = true;
    pages.delete(id);
    clearTimeout(page.blockedTimer);
    const contents = page.view?.webContents;
    for (const [contentsId, candidate] of pagesByContents) {
      if (candidate === page) pagesByContents.delete(contentsId);
    }
    try {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.contentView.removeChildView(page.view);
    } catch {
      // The window is gone, and the view with it.
    }
    try {
      if (contents && !contents.isDestroyed?.()) contents.close();
    } catch (err) {
      log.warn?.('HTML preview: the page could not be closed:', err?.message ?? err);
    }
    return { ok: true };
  }

  function closeAll() {
    for (const id of [...pages.keys()]) close(id);
  }

  /** "Open in browser": the file goes to the system, which picks the browser. */
  async function openInBrowser(filePath) {
    if (typeof filePath !== 'string' || !isHtmlFileName(filePath)) return { ok: false, reason: ERRORS.NOT_FOUND };
    const checked = await resolveCheckedWorkspacePath(filePath);
    if (!checked?.absPath) return { ok: false, reason: ERRORS.OUTSIDE_WORKSPACE };
    try {
      const failure = await shell.openPath(checked.absPath);
      return failure ? { ok: false, reason: ERRORS.UNAVAILABLE, error: failure } : { ok: true };
    } catch (err) {
      return { ok: false, reason: ERRORS.UNAVAILABLE, error: err?.message ?? String(err) };
    }
  }

  return {
    open,
    setBounds,
    reload,
    check,
    focus,
    close,
    closeAll,
    openInBrowser,
    /** For tests: the pages that are open, by id. */
    get openPages() {
      return [...pages.keys()];
    },
  };
}

module.exports = {
  createHtmlPreviewService,
  HTML_PREVIEW_SCHEME_PRIVILEGES,
  previewUrl,
  parsePreviewUrl,
  GESTURE_WINDOW_MS,
};
