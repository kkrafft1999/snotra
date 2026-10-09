// Back and forward in the preview (#822), main's side: the shortcut by the
// physical key, and the menu behind ‹ and ›.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchPreviewHistoryShortcut,
  createPreviewHistoryShortcutHandler,
} = require('../src/main/services/preview-history-shortcut');
const {
  sanitizeHistoryMenuRequest,
  buildHistoryMenuTemplate,
  registerPreviewHistoryMenuHandlers,
  MAX_ENTRIES,
} = require('../src/main/ipc/preview-history-menu-handlers');

const key = (code, mods = {}) => ({ type: 'keyDown', code, key: '?', ...mods });

test('macOS: Cmd+[ and Cmd+] by the physical key, whatever the layout types', () => {
  assert.equal(matchPreviewHistoryShortcut(key('BracketLeft', { meta: true, key: 'ü' }), 'darwin'), 'back');
  assert.equal(matchPreviewHistoryShortcut(key('BracketRight', { meta: true, key: '+' }), 'darwin'), 'forward');
  assert.equal(matchPreviewHistoryShortcut(key('BracketLeft', { control: true }), 'darwin'), null);
  assert.equal(matchPreviewHistoryShortcut(key('BracketLeft', { meta: true, shift: true }), 'darwin'), null);
  assert.equal(matchPreviewHistoryShortcut(key('BracketLeft', { meta: true, alt: true }), 'darwin'), null);
  // Alt+Left moves by word in a Mac text field: not taken there.
  assert.equal(matchPreviewHistoryShortcut(key('ArrowLeft', { alt: true }), 'darwin'), null);
});

for (const platform of ['win32', 'linux']) {
  test(`${platform}: Alt+Left and Alt+Right, as in the browsers there`, () => {
    assert.equal(matchPreviewHistoryShortcut(key('ArrowLeft', { alt: true }), platform), 'back');
    assert.equal(matchPreviewHistoryShortcut(key('ArrowRight', { alt: true }), platform), 'forward');
    assert.equal(matchPreviewHistoryShortcut(key('ArrowLeft', { alt: true, control: true }), platform), null);
    assert.equal(matchPreviewHistoryShortcut(key('ArrowLeft', { alt: true, shift: true }), platform), null);
    assert.equal(matchPreviewHistoryShortcut(key('ArrowLeft'), platform), null);
    assert.equal(matchPreviewHistoryShortcut(key('BracketLeft', { control: true }), platform), null);
    assert.equal(matchPreviewHistoryShortcut({ ...key('ArrowLeft', { alt: true }), type: 'keyUp' }, platform), null);
  });
}

test('the handler takes the key away from the page and ignores the repeat', () => {
  const steps = [];
  const handler = createPreviewHistoryShortcutHandler({ platform: 'darwin', onStep: (d) => steps.push(d) });
  let prevented = 0;
  const event = { preventDefault: () => { prevented += 1; } };
  handler(event, key('BracketLeft', { meta: true }));
  handler(event, key('BracketLeft', { meta: true, isAutoRepeat: true }));
  handler(event, key('KeyA', { meta: true }));
  assert.deepEqual(steps, ['back']);
  assert.equal(prevented, 2);
});

test('a menu request is checked and trimmed before it becomes a menu', () => {
  assert.equal(sanitizeHistoryMenuRequest(null), null);
  assert.equal(sanitizeHistoryMenuRequest({ token: 1, entries: [] }), null);
  assert.equal(sanitizeHistoryMenuRequest({ token: 'x', entries: [{ index: 0, name: 'a' }] }), null);
  assert.equal(sanitizeHistoryMenuRequest({ token: 1, entries: [{ index: -1, name: 'a' }] }), null);
  assert.equal(sanitizeHistoryMenuRequest({ token: 1, entries: [{ index: 0, name: '' }] }), null);

  const many = Array.from({ length: 80 }, (_, i) => ({ index: i, name: `f${i}.md`, folder: 'docs', gone: i === 1 }));
  const checked = sanitizeHistoryMenuRequest({ token: 7, entries: many, position: { x: 10.6, y: 'x' } });
  assert.equal(checked.entries.length, MAX_ENTRIES);
  assert.equal(checked.position, null);
  assert.deepEqual(checked.entries[1], { index: 1, name: 'f1.md', folder: 'docs', gone: true });
  assert.deepEqual(
    sanitizeHistoryMenuRequest({ token: 7, entries: many.slice(0, 1), position: { x: 10.6, y: 20.2 } }).position,
    { x: 11, y: 20 },
  );
});

test('the template names each file, with its folder, and disables the gone ones', () => {
  const picked = [];
  const request = {
    entries: [
      { index: 2, name: 'R&D.md', folder: '', gone: false },
      { index: 0, name: 'setup.md', folder: 'docs', gone: true },
    ],
  };
  const mac = buildHistoryMenuTemplate(request, { platform: 'darwin', onPick: (i) => picked.push(i) });
  assert.deepEqual(mac.map(({ label, sublabel, enabled }) => ({ label, sublabel, enabled })), [
    { label: 'R&D.md', sublabel: undefined, enabled: true },
    { label: 'setup.md', sublabel: 'docs', enabled: false },
  ]);
  mac[0].click();
  assert.deepEqual(picked, [2]);

  const win = buildHistoryMenuTemplate(request, { platform: 'win32', onPick: () => {} });
  assert.deepEqual(win.map((item) => item.label), ['R&&D.md', 'setup.md — docs']);
});

test('the handler shows the menu at the button and sends the pick back with its token', () => {
  const handlers = new Map();
  const sent = [];
  let popped = null;
  let template = null;
  const win = { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } };
  registerPreviewHistoryMenuHandlers({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    Menu: { buildFromTemplate: (t) => { template = t; return { popup: (options) => { popped = options; } }; } },
    REQ: { UI_SHOW_PREVIEW_HISTORY_MENU: 'req' },
    PUSH: { UI_PREVIEW_HISTORY_CHOICE: 'push' },
    getMainWindow: () => win,
    platform: 'darwin',
  });
  const handle = handlers.get('req');
  assert.deepEqual(handle({}, { token: 1, entries: [] }), { error: 'invalid-request' });

  const result = handle({}, { token: 4, entries: [{ index: 3, name: 'a.md' }], position: { x: 5, y: 9 } });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(popped, { window: win, x: 5, y: 9 });
  template[0].click();
  assert.deepEqual(sent, [['push', { token: 4, index: 3 }]]);
});
