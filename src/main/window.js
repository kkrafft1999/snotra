const { BrowserWindow, shell } = require('electron');
const path = require('path');
const { createRendererNavigationHandler } = require('./permissions');
const { isOpenableUrl } = require('./ipc/shell-handlers');

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
};
