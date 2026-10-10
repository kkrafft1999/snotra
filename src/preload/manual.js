// Preload of the help window (#790). Sandboxed like the app window's, and
// deliberately small: the help page reads the bundled manual and opens web
// links, nothing else. No file system, no settings, no chat.
const { contextBridge, ipcRenderer } = require('electron');
const { MANUAL_REQUEST_CHANNELS: REQ, MANUAL_PUSH_CHANNELS: PUSH } = require('../shared/manual-channels');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('manualApi', {
  context: () => ipcRenderer.invoke(REQ.CONTEXT),
  index: (locale) => ipcRenderer.invoke(REQ.INDEX, locale),
  page: (locale, slug) => ipcRenderer.invoke(REQ.PAGE, locale, slug),
  pages: (locale) => ipcRenderer.invoke(REQ.PAGES, locale),
  screenshot: (motif, locale, theme) => ipcRenderer.invoke(REQ.SCREENSHOT, motif, locale, theme),
  openExternal: (url) => ipcRenderer.invoke(REQ.OPEN_EXTERNAL, url),
  onNavigate: (callback) => subscribe(PUSH.NAVIGATE, callback),
  onLocale: (callback) => subscribe(PUSH.LOCALE, callback),
  onHistory: (callback) => subscribe(PUSH.HISTORY, callback),
  onZoom: (callback) => subscribe(PUSH.ZOOM, callback),
});
