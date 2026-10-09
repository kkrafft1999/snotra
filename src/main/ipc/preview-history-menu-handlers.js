'use strict';

/**
 * The menu behind ‹ and › in the preview header (#822): the files one side of
 * the one on show, nearest first, as a browser lists them on a right click.
 *
 * The renderer knows the history and sends what to list; main only shows it
 * and sends back which entry was picked, together with the number the
 * renderer gave the menu — an answer to a menu that is no longer the latest
 * is dropped there. Nothing here touches the file system: an entry is a name
 * to show and an index to send back, and the renderer opens the file through
 * the same checked path as a click in the tree.
 */

const MAX_ENTRIES = 50;
const MAX_TEXT = 512;

function text(value) {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
}

/** The request, checked; null when it is not one. */
function sanitizeHistoryMenuRequest(request) {
  if (!request || typeof request !== 'object') return null;
  const { token, entries, position } = request;
  if (!Number.isSafeInteger(token) || !Array.isArray(entries) || entries.length === 0) return null;
  const clean = [];
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    if (!entry || !Number.isSafeInteger(entry.index) || entry.index < 0) return null;
    const name = text(entry.name);
    if (!name) return null;
    clean.push({ index: entry.index, name, folder: text(entry.folder), gone: entry.gone === true });
  }
  const point = position
    && Number.isFinite(position.x) && Number.isFinite(position.y)
    && position.x >= 0 && position.y >= 0
    ? { x: Math.round(position.x), y: Math.round(position.y) }
    : null;
  return { token, entries: clean, position: point };
}

/**
 * The template: one item per entry. The folder goes into `sublabel` on macOS,
 * which shows it as a second, quieter line; elsewhere it follows the name. An
 * `&` would be an access key on Windows and Linux.
 */
function buildHistoryMenuTemplate({ entries }, { platform = process.platform, onPick }) {
  const mac = platform === 'darwin';
  const escape = (value) => (mac ? value : value.replaceAll('&', '&&'));
  return entries.map((entry) => ({
    label: escape(!mac && entry.folder ? `${entry.name} — ${entry.folder}` : entry.name),
    ...(mac && entry.folder ? { sublabel: entry.folder } : {}),
    enabled: !entry.gone,
    click: () => onPick(entry.index),
  }));
}

function registerPreviewHistoryMenuHandlers({
  ipcMain, Menu, REQ, PUSH, getMainWindow, platform = process.platform,
}) {
  ipcMain.handle(REQ.UI_SHOW_PREVIEW_HISTORY_MENU, (_event, request) => {
    const checked = sanitizeHistoryMenuRequest(request);
    if (!checked) return { error: 'invalid-request' };
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { error: 'no-window' };
    const menu = Menu.buildFromTemplate(buildHistoryMenuTemplate(checked, {
      platform,
      onPick: (index) => {
        if (!win.isDestroyed()) win.webContents.send(PUSH.UI_PREVIEW_HISTORY_CHOICE, { token: checked.token, index });
      },
    }));
    menu.popup({ window: win, ...(checked.position ?? {}) });
    return { ok: true };
  });
}

module.exports = {
  sanitizeHistoryMenuRequest,
  buildHistoryMenuTemplate,
  registerPreviewHistoryMenuHandlers,
  MAX_ENTRIES,
};
