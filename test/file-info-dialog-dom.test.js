// Snotra's own information dialog on the real index.html (#849).

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const INFO = Object.freeze({
  itemPath: '/ws/notes.md',
  name: 'notes.md',
  path: '/ws/notes.md',
  kind: 'file',
  type: 'File (.md)',
  summary: '2.2 KB',
  details: [['Size', '2.2 KB (2,296 bytes)'], ['Modified', '2026-09-12, 15:49'], ['Opens with', 'Typora']],
  revealLabel: 'Reveal in Finder',
});

async function mount({ api: overrides = {} } = {}) {
  const dom = setupRendererDom();
  const { initFileInfoDialog } = await importRenderer('components', 'FileInfoDialog.js');
  const calls = [];
  let push = () => {};
  const api = {
    onFsShowInfo: (cb) => { push = cb; },
    writeClipboardText: async (text) => { calls.push(`copy:${text}`); return { ok: true }; },
    revealItem: async (p) => { calls.push(`reveal:${p}`); return { ok: true }; },
    ...overrides,
  };
  const dialog = initFileInfoDialog({ api });
  const $ = (id) => dom.document.getElementById(id);
  return {
    dom,
    dialog,
    calls,
    $,
    show: async (info = INFO) => { push(info); await flush(); },
    isOpen: () => !$('modal-file-info').classList.contains('hidden'),
  };
}

test('the pushed facts fill the header card, the path and the list (#849)', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  assert.equal(ui.isOpen(), false);
  await ui.show();

  assert.equal(ui.isOpen(), true);
  assert.equal(ui.$('modal-file-info').getAttribute('aria-hidden'), 'false');
  assert.equal(ui.$('modal-file-info-name').textContent, 'notes.md');
  assert.equal(ui.$('modal-file-info-summary').textContent, 'File (.md) · 2.2 KB');
  assert.equal(ui.$('modal-file-info-path').textContent, '/ws/notes.md');
  const terms = Array.from(ui.$('modal-file-info-details').querySelectorAll('dt')).map((el) => el.textContent);
  const values = Array.from(ui.$('modal-file-info-details').querySelectorAll('dd')).map((el) => el.textContent);
  assert.deepEqual(terms, ['Size', 'Modified', 'Opens with']);
  assert.deepEqual(values, ['2.2 KB (2,296 bytes)', '2026-09-12, 15:49', 'Typora']);
  assert.equal(ui.$('modal-file-info-reveal-label').textContent, 'Reveal in Finder');
  assert.equal(ui.dom.document.activeElement, ui.$('modal-file-info-ok'));
});

test('a folder gets the folder icon, a file the file icon (#849)', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  const dialog = ui.dom.document.querySelector('.file-info-dialog');
  await ui.show({ ...INFO, kind: 'folder', name: 'docs', summary: '' , type: 'Folder' });
  assert.equal(dialog.classList.contains('file-info-dialog--folder'), true);
  assert.equal(ui.$('modal-file-info-summary').textContent, 'Folder');
  await ui.show();
  assert.equal(dialog.classList.contains('file-info-dialog--folder'), false);
});

test('names are text, never markup (#849)', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  await ui.show({ ...INFO, name: '<img src=x onerror=alert(1)>.md', details: [['<b>x</b>', '<i>y</i>']] });
  assert.equal(ui.$('modal-file-info-name').querySelector('img'), null);
  assert.equal(ui.$('modal-file-info-details').querySelector('b, i'), null);
});

test('copy puts the full path on the clipboard and confirms it (#849)', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  await ui.show();
  ui.$('modal-file-info-copy').click();
  await flush();

  assert.deepEqual(ui.calls, ['copy:/ws/notes.md']);
  assert.equal(ui.$('modal-file-info-status').textContent, 'Path copied');
  assert.equal(ui.$('modal-file-info-copy').classList.contains('file-info-dialog__copy--done'), true);
  assert.equal(ui.$('modal-file-info-copy').getAttribute('aria-label'), 'Path copied');
  assert.equal(ui.isOpen(), true, 'copying keeps the dialog open');
});

test('a failed copy says so instead of confirming (#849)', async (t) => {
  const ui = await mount({ api: { writeClipboardText: async () => ({ ok: false, error: 'busy' }) } });
  t.after(ui.dom.cleanup);
  await ui.show();
  ui.$('modal-file-info-copy').click();
  await flush();

  assert.equal(ui.$('modal-file-info-status').textContent, 'The path could not be copied.');
  assert.equal(ui.$('modal-file-info-status').classList.contains('file-info-dialog__status--error'), true);
  assert.equal(ui.$('modal-file-info-copy').classList.contains('file-info-dialog__copy--done'), false);
});

test('reveal sends the tree\'s path back and closes the dialog (#849)', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  await ui.show();
  ui.$('modal-file-info-reveal').click();
  await flush();

  assert.deepEqual(ui.calls, ['reveal:/ws/notes.md']);
  assert.equal(ui.isOpen(), false);
});

test('a refused reveal keeps the dialog open with a note (#849)', async (t) => {
  const ui = await mount({ api: { revealItem: async () => ({ error: 'outside' }) } });
  t.after(ui.dom.cleanup);
  await ui.show();
  ui.$('modal-file-info-reveal').click();
  await flush();

  assert.equal(ui.isOpen(), true);
  assert.equal(ui.$('modal-file-info-status').textContent, 'The folder could not be shown.');
});

test('OK, the close button, the backdrop and Escape all close it and return focus (#849)', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  const { document, window } = ui.dom;
  const row = document.createElement('button');
  document.body.append(row);

  const closers = [
    () => ui.$('modal-file-info-ok').click(),
    () => ui.$('modal-file-info-close').click(),
    () => ui.$('modal-file-info-backdrop').click(),
    () => ui.$('modal-file-info').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  ];
  for (const closeIt of closers) {
    row.focus();
    await ui.show();
    assert.equal(ui.isOpen(), true);
    closeIt();
    await flush();
    assert.equal(ui.isOpen(), false);
    assert.equal(ui.$('modal-file-info').getAttribute('aria-hidden'), 'true');
    assert.ok(document.activeElement === row, 'focus is back on what opened it');
  }
});

test('without reveal or clipboard there is no dead button (#849)', async (t) => {
  const ui = await mount({ api: { revealItem: undefined, writeClipboardText: undefined } });
  t.after(ui.dom.cleanup);
  await ui.show();
  assert.equal(ui.$('modal-file-info-reveal').classList.contains('hidden'), true);
  assert.equal(ui.$('modal-file-info-copy').disabled, true);
});
