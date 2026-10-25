const { app, BrowserWindow, screen, shell } = require('electron');
const path = require('path');
const { createRendererNavigationHandler, RENDERER_URL } = require('./permissions');
const { isOpenableUrl } = require('./ipc/shell-handlers');
const { resolveWindowBounds, createWindowStateStore } = require('./window-state');
const { createHiddenFilesShortcutHandler } = require('./services/hidden-files-shortcut');
const { createDeveloperModeShortcutHandler } = require('./services/developer-mode-shortcut');
const { createPreviewHistoryShortcutHandler } = require('./services/preview-history-shortcut');
const { windowTitle } = require('./services/window-title');
const { createRendererErrorForwarder } = require('./services/renderer-console');
const { PUSH_CHANNELS: PUSH } = require('../shared/ipc-channels');

const projectRoot = path.resolve(__dirname, '..', '..');

/** @type {import('electron').BrowserWindow|null} */
let mainWindow = null;

// Waehrend des Betriebs wird entprellt gesichert: Ziehen am Fensterrand feuert
// sonst dutzendfach pro Sekunde eine Datei auf die Platte.
const STATE_SAVE_DELAY_MS = 500;

// The window is shown once the page has painted (#509), so the theme is in
// place before anyone sees it. Should that signal never come — a renderer
// that dies on the way — it is shown anyway rather than staying invisible.
const SHOW_FALLBACK_MS = 3000;

// What shows behind the page while it lags behind a resize: `--ds-surface` of
// the light theme (tokens.css), not pure white, which is no surface there.
// The main process does not know the theme — it lives in the renderer's
// localStorage — so the dark one shows its own colour only once painted.
const WINDOW_BACKGROUND = '#FFFCF5';

// PRI-1 (#988): an idle session contacts nothing. Chromium's spell checker
// breaks that on Linux: it has no OS spell checker there, and fetches a Hunspell
// dictionary from a Google CDN (redirector.gvt1.com) the moment a session
// exists, before a window opens and before anyone types. The idle network test
// (e2e/idle-network.test.mjs) saw it on the Linux runner. macOS and Windows use
// the OS spell checker and fetch nothing. So Linux runs without spell checking;
// a local dictionary or a consent step would bring it back
// (docs/architecture/quality-requirements.md, PRI-1).
const SPELLCHECK_FETCHES_DICTIONARIES = process.platform === 'linux';

// Per session, as the session is created: the download starts with the session,
// and the first one is made by `session.defaultSession` early in start-up. An
// empty language list makes the session drop the dictionary it is loading.
// Called once from index.js, before the app is ready.
function keepSpellCheckerOffWhereItFetches() {
  if (!SPELLCHECK_FETCHES_DICTIONARIES) return;
  app.on('session-created', (ses) => {
    ses.setSpellCheckerEnabled(false);
    ses.setSpellCheckerLanguages([]);
  });
}

function windowStateStore() {
  return createWindowStateStore({
    filePath: path.join(app.getPath('userData'), 'window-state.json'),
  });
}

/**
 * Der Zustand beim Start: der zuletzt eingestellte, gegen die heutigen
 * Bildschirme geprueft (Issue #209). Ohne gespeicherten Zustand die
 * Standardgroesse aus Issue #208.
 *
 * @param {Pick<ReturnType<typeof createWindowStateStore>, 'read'>} store
 */
function startupWindowState(store) {
  try {
    return resolveWindowBounds({
      saved: store.read(),
      displays: screen.getAllDisplays(),
      primaryWorkArea: screen.getPrimaryDisplay().workArea,
    });
  } catch {
    // Ohne Display-Auskunft (Headless-Start in Tests) bleibt es beim Wunschmass.
    return resolveWindowBounds({});
  }
}

/**
 * Gesichert wird immer die Groesse *unter* Maximierung und Vollbild
 * (`getNormalBounds()`), sonst kaeme ein entmaximiertes Fenster spaeter
 * bildschirmfuellend zurueck.
 *
 * @param {import('electron').BrowserWindow} window
 * @returns {import('./window-state').WindowState|null}
 */
function captureWindowState(window) {
  if (window.isDestroyed() || window.isMinimized()) return null;
  return {
    ...window.getNormalBounds(),
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
  };
}

function createWindow() {
  const store = windowStateStore();
  const { maximized, fullScreen, ...bounds } = startupWindowState(store);
  const window = new BrowserWindow({
    title: `Snotra Agent ${app.getVersion()}`,
    ...bounds,
    minWidth: 900,
    minHeight: 420,
    // Maximiert bzw. im Vollbild verlassen heisst maximiert bzw. im Vollbild
    // zurueck; die Masse darunter stehen in `bounds`.
    ...(fullScreen ? { fullscreen: true } : {}),
    webPreferences: {
      preload: path.join(projectRoot, 'src', 'preload', 'bundle.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: !SPELLCHECK_FETCHES_DICTIONARIES,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: WINDOW_BACKGROUND,
    show: false,
  });

  let shown = false;
  const showWhenPainted = () => {
    if (shown || window.isDestroyed()) return;
    shown = true;
    clearTimeout(showFallback);
    // Before show: maximize() would show the window itself on Windows.
    if (maximized && !fullScreen) window.maximize();
    window.show();
    if (fullScreen && !window.isFullScreen()) window.setFullScreen(true);
  };
  const showFallback = setTimeout(showWhenPainted, SHOW_FALLBACK_MS);
  window.once('ready-to-show', showWhenPainted);

  // The renderer's <title> names the open workspace (#676); taken over as
  // it is, the version would go — main keeps it at the end.
  window.on('page-title-updated', (event, title) => {
    event.preventDefault();
    window.setTitle(windowTitle(title, app.getVersion()));
  });

  /** @type {ReturnType<typeof setTimeout>|null} */
  let saveTimer = null;
  const saveLater = () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const state = captureWindowState(window);
      if (state) store.write(state);
    }, STATE_SAVE_DELAY_MS);
  };
  window.on('resize', saveLater);
  window.on('move', saveLater);
  window.on('maximize', saveLater);
  window.on('unmaximize', saveLater);
  window.on('enter-full-screen', saveLater);
  window.on('leave-full-screen', saveLater);
  // Beim Schliessen sofort: nach dem Fenster ist der Prozess unter Umstaenden
  // weg, ein entprellter Schreibvorgang kaeme nie an.
  window.on('close', () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const state = captureWindowState(window);
    if (state) store.write(state);
  });

  mainWindow = window;
  window.on('closed', () => {
    clearTimeout(showFallback);
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('Preload failed:', preloadPath, error);
  });
  // What throws in the renderer and nobody catches shows up here too (#919).
  window.webContents.on('console-message', createRendererErrorForwarder());

  // Dieselbe Pruefung wie der IPC-Handler, damit http/https/mailto ueberall
  // gleich behandelt werden (Issue #82).
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isOpenableUrl(url)) {
      shell.openExternal(url.trim()).catch((e) => {
        console.error('openExternal failed:', url, e);
      });
    }
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', createRendererNavigationHandler());

  // Hidden files in the tree (#436). Before the page sees the key, so it works
  // with the focus in the chat input as well — like a menu accelerator would.
  window.webContents.on('before-input-event', createHiddenFilesShortcutHandler({
    onToggle: () => window.webContents.send(PUSH.UI_TOGGLE_HIDDEN_FILES),
  }));
  // Developer mode (#1213), the same way: the window asks main to switch it.
  window.webContents.on('before-input-event', createDeveloperModeShortcutHandler({
    onToggle: () => window.webContents.send(PUSH.UI_TOGGLE_DEVELOPER_MODE),
  }));
  // Back and forward in the preview (#822), the same way and for the same
  // reason: by the physical key, and with the focus anywhere in the window.
  window.webContents.on('before-input-event', createPreviewHistoryShortcutHandler({
    onStep: (direction) => window.webContents.send(
      direction === 'back' ? PUSH.UI_PREVIEW_BACK : PUSH.UI_PREVIEW_FORWARD,
    ),
  }));

  window.loadURL(RENDERER_URL);
  return window;
}

function getMainWindow() {
  return mainWindow;
}

module.exports = {
  createWindow,
  keepSpellCheckerOffWhereItFetches,
  getMainWindow,
};
