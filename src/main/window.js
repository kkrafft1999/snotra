const { BrowserWindow, shell } = require('electron');
const path = require('path');
const { createRendererNavigationHandler } = require('./permissions');

const projectRoot = path.resolve(__dirname, '..', '..');

let mainWindow = null;

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
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

  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('Preload failed:', preloadPath, error);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {
      /* ignore invalid URL */
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
};
