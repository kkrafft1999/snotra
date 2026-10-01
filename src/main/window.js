const { app, BrowserWindow, screen, shell } = require('electron');
const path = require('path');
const { createRendererNavigationHandler } = require('./permissions');
const { isOpenableUrl } = require('./ipc/shell-handlers');
const { resolveWindowBounds, createWindowStateStore } = require('./window-state');
const { createHiddenFilesShortcutHandler } = require('./services/hidden-files-shortcut');
const { PUSH_CHANNELS: PUSH } = require('../shared/ipc-channels');

const projectRoot = path.resolve(__dirname, '..', '..');

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

function windowStateStore() {
  return createWindowStateStore({
    filePath: path.join(app.getPath('userData'), 'window-state.json'),
  });
}

/**
 * Der Zustand beim Start: der zuletzt eingestellte, gegen die heutigen
 * Bildschirme geprueft (Issue #209). Ohne gespeicherten Zustand die
 * Standardgroesse aus Issue #208.
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
    title: `Snotra AI ${app.getVersion()}`,
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

  // Ohne das setzt das <title> des Renderers den Fenstertitel sofort wieder
  // auf "Snotra AI" zurueck und die Version waere nur einen Wimpernschlag
  // lang zu sehen.
  window.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  let saveTimer = null;
  const saveLater = () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const state = captureWindowState(window);
      if (state) store.write(state);
    }, STATE_SAVE_DELAY_MS);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    window.on(event, saveLater);
  }
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

  window.loadFile(path.join(projectRoot, 'src', 'renderer', 'index.html'));
  return window;
}

function getMainWindow() {
  return mainWindow;
}

module.exports = {
  createWindow,
  getMainWindow,
};
