'use strict';

/**
 * The channels of the HTML view (#479). The renderer names a file and says
 * where the view goes; everything else — whether the file may be shown, what
 * the page may load — `html-preview-service.js` decides. Arguments are
 * narrowed here to what the service expects, nothing more is passed through.
 */

function idOf(value) {
  return typeof value === 'string' && /^[a-f0-9]{8,64}$/.test(value) ? value : '';
}

function boundsOf(value) {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value;
  return { x, y, width, height };
}

function registerHtmlPreviewHandlers({ ipcMain, htmlPreview, REQ }) {
  ipcMain.handle(REQ.HTML_PREVIEW_OPEN, async (_event, filePath, options) =>
    htmlPreview.open(filePath, { fragment: typeof options?.fragment === 'string' ? options.fragment : '' }));
  ipcMain.handle(REQ.HTML_PREVIEW_SET_BOUNDS, async (_event, id, bounds) =>
    htmlPreview.setBounds(idOf(id), boundsOf(bounds)));
  ipcMain.handle(REQ.HTML_PREVIEW_RELOAD, async (_event, id) => htmlPreview.reload(idOf(id)));
  ipcMain.handle(REQ.HTML_PREVIEW_CHECK, async (_event, id) => htmlPreview.check(idOf(id)));
  ipcMain.handle(REQ.HTML_PREVIEW_FOCUS, async (_event, id) => htmlPreview.focus(idOf(id)));
  ipcMain.handle(REQ.HTML_PREVIEW_CLOSE, async (_event, id) => htmlPreview.close(idOf(id)));
  ipcMain.handle(REQ.HTML_PREVIEW_OPEN_IN_BROWSER, async (_event, filePath) => htmlPreview.openInBrowser(filePath));
}

module.exports = { registerHtmlPreviewHandlers };
