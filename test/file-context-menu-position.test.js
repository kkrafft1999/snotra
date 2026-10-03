// Where the file context menu opens when the keyboard asked for it (#74):
// below the focused row, scaled by the zoom. Anything else from the renderer
// is no position, and the menu opens at the mouse pointer as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const { contextMenuPosition } = require('../src/main/ipc/fs-handlers');
const { createFileContextMenu } = require('../src/main/services/file-context-menu');

const windowWithZoom = (zoom) => ({
  isDestroyed: () => false,
  webContents: { getZoomFactor: () => zoom },
});

test('a position in CSS pixels becomes window coordinates at the current zoom', () => {
  assert.deepEqual(contextMenuPosition({ x: 40, y: 120 }, windowWithZoom(1)), { x: 40, y: 120 });
  assert.deepEqual(contextMenuPosition({ x: 40, y: 121 }, windowWithZoom(1.25)), { x: 50, y: 151 });
  assert.deepEqual(contextMenuPosition({ x: 40, y: 120 }, null), { x: 40, y: 120 });
});

test('anything but two sane numbers is no position', () => {
  const win = windowWithZoom(1);
  for (const position of [
    undefined,
    null,
    {},
    { x: 10 },
    { x: '10', y: '20' },
    { x: NaN, y: 1 },
    { x: Infinity, y: 1 },
    { x: -1, y: 1 },
    { x: 1, y: 1e9 },
  ]) {
    assert.equal(contextMenuPosition(position, win), null, JSON.stringify(position));
  }
});

test('popup hands the position to the menu, and leaves it out without one', () => {
  const popups = [];
  const menu = createFileContextMenu({
    Menu: { buildFromTemplate: () => ({ popup: (options) => popups.push(options) }) },
    shell: { openPath: async () => '', showItemInFolder() {}, trashItem: async () => {} },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    clipboard: { writeText() {} },
    platform: 'darwin',
    getLocale: () => 'en',
  });
  const win = { id: 1 };
  menu.popup('/ws/a.md', win, { position: { x: 5, y: 6 } });
  menu.popup('/ws/a.md', win);
  assert.deepEqual(popups, [{ window: win, x: 5, y: 6 }, { window: win }]);
});
