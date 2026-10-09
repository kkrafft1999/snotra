// Back and forward in the preview header (#822), against the real markup: the
// buttons, the way back through the tree's opener, and the place the reader
// left a file at.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const item = (name) => ({ path: `/ws/${name}`, name, size: 10, modified: 1 });
const text = (content) => ({ content, size: content.length, modified: 5 });

/** A view that reports a scroll position and keeps what it was given back. */
function placeView() {
  const mounts = [];
  const view = {
    id: 'place',
    kind: 'viewer',
    canHandle: ({ ext }) => ext === 'txt',
    mount(hostEl, context) {
      const entry = { path: context.file.path, viewState: context.viewState, fragment: context.fragment, top: 0 };
      mounts.push(entry);
      return {
        update() {},
        unmount() {},
        viewState: () => ({ top: entry.top }),
      };
    },
  };
  return { view, mounts };
}

async function mountHost(t, { files, exists = () => true } = {}) {
  const dom = setupRendererDom();
  const { createFileViewHost } = await importRenderer('file-views', 'host.js');
  const { createFileViewRegistry } = await importRenderer('file-views', 'registry.js');
  const { view, mounts } = placeView();
  const menus = [];
  const opened = [];
  const api = { readFile: async (path) => files[path] ?? { error: 'ENOENT' } };
  let host;
  // The tree's opener: it selects the row and shows the file through the host,
  // or answers 'not-found' for a file that is gone.
  const openFile = async (path) => {
    opened.push(path);
    if (!exists(path)) return { ok: false, reason: 'not-found' };
    await host.open(item(path.slice('/ws/'.length)));
    return { ok: true };
  };
  host = createFileViewHost({
    api,
    registry: createFileViewRegistry([view]),
    openFile,
    getWorkspaceRoot: () => '/ws',
    showHistoryMenu: async (request) => { menus.push(request); return { ok: true }; },
  });
  t.after(() => {
    host.dispose();
    dom.cleanup();
  });
  const back = () => document.querySelector('.preview-history__button[data-direction="back"]');
  const forward = () => document.querySelector('.preview-history__button[data-direction="forward"]');
  return { host, mounts, menus, opened, back, forward };
}

const files = {
  '/ws/a.txt': text('a'),
  '/ws/b.txt': text('b'),
  '/ws/c.txt': text('c'),
};

test('the header carries ‹ ›, both off until there is somewhere to go', async (t) => {
  const { host, back, forward } = await mountHost(t, { files });
  assert.equal(back(), null, 'no buttons on the welcome screen');

  await host.open(item('a.txt'));
  const lead = document.getElementById('preview-lead');
  assert.equal(lead.firstElementChild.classList.contains('preview-history'), true);
  assert.equal(lead.lastElementChild.id, 'preview-filename');
  assert.equal(back().disabled, true);
  assert.equal(forward().disabled, true);
  assert.equal(back().getAttribute('aria-label'), 'Back');
  assert.equal(lead.firstElementChild.getAttribute('role'), 'group');

  await host.open(item('b.txt'));
  assert.equal(back().disabled, false);
  assert.equal(back().getAttribute('aria-label'), 'Back to a.txt');
  assert.match(back().title, /^Back to a\.txt \(.+\)$/);
  assert.equal(forward().disabled, true);
});

test('back and forward go through the opener and land on the file before and after', async (t) => {
  const { host, opened, back, forward } = await mountHost(t, { files });
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await host.open(item(name));

  back().click();
  await flush();
  assert.equal(host.openPath(), '/ws/b.txt');
  assert.deepEqual(opened, ['/ws/b.txt']);
  assert.equal(forward().disabled, false);
  assert.equal(forward().getAttribute('aria-label'), 'Forward to c.txt');

  assert.equal(await host.goBack(), true);
  assert.equal(host.openPath(), '/ws/a.txt');
  assert.equal(back().disabled, true);

  assert.equal(await host.goForward(), true);
  assert.equal(await host.goForward(), true);
  assert.equal(host.openPath(), '/ws/c.txt');
  assert.equal(await host.goForward(), false);
});

test('a file opened after going back cuts off what lay ahead', async (t) => {
  const { host, forward } = await mountHost(t, { files });
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await host.open(item(name));
  await host.goBack();
  await host.goBack();
  await host.open(item('c.txt'));
  assert.equal(forward().disabled, true);
  assert.equal(host.canGoBack(), true);
  await host.goBack();
  assert.equal(host.openPath(), '/ws/a.txt');
});

test('the view gets back the place it reported when it was left', async (t) => {
  const { host, mounts } = await mountHost(t, { files });
  await host.open(item('a.txt'));
  mounts.at(-1).top = 640;
  await host.open(item('b.txt'));
  assert.equal(mounts.at(-1).viewState, null, 'a new step starts at the top');

  await host.goBack();
  assert.equal(mounts.at(-1).path, '/ws/a.txt');
  assert.deepEqual(mounts.at(-1).viewState, { top: 640 });

  // An ordinary click on the same file later is a new step, from the top.
  await host.open(item('b.txt'));
  await host.open(item('a.txt'));
  assert.equal(mounts.at(-1).viewState, null);
});

test('a file that is gone is skipped on the way back', async (t) => {
  const gone = new Set();
  const { host, opened } = await mountHost(t, { files, exists: (path) => !gone.has(path) });
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await host.open(item(name));
  gone.add('/ws/b.txt');

  assert.equal(await host.goBack(), true);
  assert.equal(host.openPath(), '/ws/a.txt');
  assert.deepEqual(opened, ['/ws/b.txt', '/ws/a.txt']);
  // Marked now: forward goes straight on to c.txt.
  assert.equal(await host.goForward(), true);
  assert.equal(host.openPath(), '/ws/c.txt');
});

test('a deleted file is struck from the choice, a renamed one followed', async (t) => {
  const { host, menus, back } = await mountHost(t, { files: { ...files, '/ws/d.txt': text('d') } });
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await host.open(item(name));
  host.forgetPath('/ws/b.txt');
  host.renamePath('/ws/a.txt', '/ws/d.txt');
  assert.equal(back().getAttribute('aria-label'), 'Back to d.txt');

  back().dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(menus.length, 1);
  assert.deepEqual(menus[0].entries, [
    { index: 1, name: 'b.txt', folder: '', gone: true },
    { index: 0, name: 'd.txt', folder: '', gone: false },
  ]);
});

test('a pick from the menu goes to that entry; an answer to an older menu does not', async (t) => {
  const { host, menus, back } = await mountHost(t, { files });
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await host.open(item(name));
  back().dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  back().dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await flush();
  const [older, latest] = menus;

  assert.equal(await host.chooseFromHistory(older.token, 0), false);
  assert.equal(host.openPath(), '/ws/c.txt');
  assert.equal(await host.chooseFromHistory(latest.token, 0), true);
  assert.equal(host.openPath(), '/ws/a.txt');
  assert.equal(host.canGoForward(), true);
  // One answer per menu.
  assert.equal(await host.chooseFromHistory(latest.token, 2), false);
});

test('the buttons follow to the info card of a file without a view', async (t) => {
  const { host, back } = await mountHost(t, { files });
  await host.open(item('a.txt'));
  await host.open(item('archive.zip'));
  const card = document.getElementById('file-info');
  assert.equal(card.firstElementChild.classList.contains('preview-history'), true);
  assert.equal(card.firstElementChild.classList.contains('preview-history--card'), true);
  assert.equal(back().disabled, false);
  await host.goBack();
  assert.equal(document.getElementById('preview-lead').firstElementChild === back().parentElement, true);
});

test('a button that runs out of steps hands the focus to its partner', async (t) => {
  const { host, back, forward } = await mountHost(t, { files });
  for (const name of ['a.txt', 'b.txt']) await host.open(item(name));
  back().focus();
  assert.equal(document.activeElement === back(), true);
  await host.goBack();
  assert.equal(back().disabled, true);
  // Nodes only as booleans: a failing compare of two would print the DOM.
  assert.equal(document.activeElement === forward(), true);
});

test('a new folder starts without a way back', async (t) => {
  const { host, back } = await mountHost(t, { files });
  for (const name of ['a.txt', 'b.txt']) await host.open(item(name));
  host.resetHistory();
  assert.equal(back().disabled, true);
  assert.equal(await host.goBack(), false);
});
