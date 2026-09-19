const { app, BrowserWindow, screen, shell } = require('electron');
const path = require('path');
const { createRendererNavigationHandler } = require('./permissions');
const { isOpenableUrl } = require('./ipc/shell-handlers');

const projectRoot = path.resolve(__dirname, '..', '..');

let mainWindow = null;

// Startgroesse (Issue #208): 20 % mehr als die frueheren 1280 x 800. Drei
// Spalten brauchen Platz — kleiner faengt jedes frische Profil damit an, dass
// man das Fenster erst einmal aufzieht.
const DEFAULT_WINDOW_WIDTH = 1536;
const DEFAULT_WINDOW_HEIGHT = 960;

/**
 * Die Startgroesse darf nicht ueber die Arbeitsflaeche hinauswachsen: auf einem
 * 13-Zoll-Notebook ist der sichtbare Bereich keine 960 px hoch, und ein Fenster,
 * dessen Fuss unter der Bildschirmkante liegt, verdeckt die Chat-Eingabe.
 *
 * Reine Funktion, damit sie ohne laufendes Electron pruefbar ist.
 */
function fitToWorkArea(
  workArea,
  { width = DEFAULT_WINDOW_WIDTH, height = DEFAULT_WINDOW_HEIGHT } = {}
) {
  const available = (value) => (Number.isFinite(value) && value > 0 ? value : Infinity);
  return {
    width: Math.round(Math.min(width, available(workArea?.width))),
    height: Math.round(Math.min(height, available(workArea?.height))),
  };
}

function defaultWindowSize() {
  try {
    return fitToWorkArea(screen.getPrimaryDisplay().workAreaSize);
  } catch {
    // Ohne Display-Auskunft (Headless-Start in Tests) bleibt es beim Wunschmass.
    return fitToWorkArea(null);
  }
}

function createWindow() {
  const { width, height } = defaultWindowSize();
  const window = new BrowserWindow({
    title: `Snotra AI ${app.getVersion()}`,
    width,
    height,
    minWidth: 900,
    minHeight: 420,
    webPreferences: {
      preload: path.join(projectRoot, 'src', 'preload', 'bundle.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ffffff',
  });

  // Ohne das setzt das <title> des Renderers den Fenstertitel sofort wieder
  // auf "Snotra AI" zurueck und die Version waere nur einen Wimpernschlag
  // lang zu sehen.
  window.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  mainWindow = window;
  window.on('closed', () => {
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

  window.loadFile(path.join(projectRoot, 'src', 'renderer', 'index.html'));
  return window;
}

function getMainWindow() {
  return mainWindow;
}

module.exports = {
  createWindow,
  getMainWindow,
  fitToWorkArea,
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
};
