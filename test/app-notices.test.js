const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppNotices, postStoreFileEvent } = require('../src/main/services/app-notices');
const { registerNoticeHandlers } = require('../src/main/ipc/notice-handlers');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const { NOTICE_KINDS, NOTICE_STORES, normalizeNotice } = require('../src/shared/contracts/notices');

/** The notice channel to the window (#1001, part of #978). */

const quiet = { warn() {} };

const SET_ASIDE = Object.freeze({
  type: 'set-aside',
  store: 'models',
  file: 'llm-config.json',
  path: '/profile/llm-config.json',
  keptAs: '/profile/llm-config.json.unreadable-1',
});

test('a notice that does not fit the contract is dropped', () => {
  const notices = createAppNotices({ log: quiet });
  assert.equal(notices.post({ id: 'x', kind: 'shout', store: 'models', file: 'a' }), null);
  assert.equal(notices.post({ id: 'x', kind: NOTICE_KINDS.STORE_SET_ASIDE, store: 'somewhere', file: 'a' }), null);
  assert.deepEqual(notices.list(), []);
});

test('every store the contract names has a file name', () => {
  for (const [file, store] of Object.entries(NOTICE_STORES)) {
    assert.ok(normalizeNotice({ id: file, kind: NOTICE_KINDS.STORE_NOT_SAVED, store, file }));
  }
});

test('one notice per file: a second set-aside replaces the first', () => {
  const notices = createAppNotices({ log: quiet });
  postStoreFileEvent(notices, SET_ASIDE);
  postStoreFileEvent(notices, { ...SET_ASIDE, keptAs: '/profile/llm-config.json.unreadable-2' });

  assert.deepEqual(notices.list().map((n) => n.location), ['/profile/llm-config.json.unreadable-2']);
});

test('a file saved again withdraws its warning, but not a set-aside', () => {
  const notices = createAppNotices({ log: quiet });
  const seen = [];
  notices.subscribe((event) => seen.push(event.type));

  postStoreFileEvent(notices, { ...SET_ASIDE, type: 'not-saved', keptAs: null });
  postStoreFileEvent(notices, { ...SET_ASIDE, type: 'saved-again', keptAs: null });
  assert.deepEqual(notices.list(), []);

  postStoreFileEvent(notices, SET_ASIDE);
  postStoreFileEvent(notices, { ...SET_ASIDE, type: 'saved-again', keptAs: null });
  assert.equal(notices.list().length, 1);
  assert.deepEqual(seen, ['posted', 'withdrawn', 'posted']);
});

test('a dismissed notice comes back when its file is set aside again', () => {
  const notices = createAppNotices({ log: quiet });
  postStoreFileEvent(notices, SET_ASIDE);
  assert.equal(notices.dismiss('store:llm-config.json'), true);
  assert.deepEqual(notices.list(), []);

  postStoreFileEvent(notices, SET_ASIDE);
  assert.equal(notices.list().length, 1);
});

function fakeIpc() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args),
  };
}

function fakeWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
  };
}

test('notices posted before the window exists wait for the list; later ones are pushed', async () => {
  const notices = createAppNotices({ log: quiet });
  const ipcMain = fakeIpc();
  let win = null;
  registerNoticeHandlers({ ipcMain, notices, REQ, PUSH, getMainWindow: () => win, platform: 'darwin' });

  postStoreFileEvent(notices, SET_ASIDE);
  win = fakeWindow();
  const listed = await ipcMain.invoke(REQ.NOTICES_LIST);
  assert.equal(listed.platform, 'darwin');
  assert.deepEqual(listed.notices.map((n) => n.id), ['store:llm-config.json']);
  assert.deepEqual(win.sent, []);

  postStoreFileEvent(notices, { ...SET_ASIDE, type: 'not-saved', store: 'webSearch', file: 'web-search-config.json' });
  postStoreFileEvent(notices, { type: 'saved-again', store: 'webSearch', file: 'web-search-config.json' });
  assert.deepEqual(win.sent.map(([channel]) => channel), [PUSH.NOTICE_POSTED, PUSH.NOTICE_WITHDRAWN]);
  assert.deepEqual(win.sent[1][1], { id: 'store:web-search-config.json' });
});

test('reveal shows the path main holds for the id, never one the renderer names', async () => {
  const notices = createAppNotices({ log: quiet });
  const ipcMain = fakeIpc();
  const shown = [];
  registerNoticeHandlers({
    ipcMain, notices, REQ, PUSH, getMainWindow: () => null, shell: { showItemInFolder: (p) => shown.push(p) },
  });
  postStoreFileEvent(notices, SET_ASIDE);

  assert.deepEqual(await ipcMain.invoke(REQ.NOTICES_REVEAL, 'store:llm-config.json'), { ok: true });
  assert.deepEqual(await ipcMain.invoke(REQ.NOTICES_REVEAL, '/etc/passwd'), { ok: false });
  assert.deepEqual(await ipcMain.invoke(REQ.NOTICES_REVEAL, { id: 'store:llm-config.json' }), { ok: false });
  assert.deepEqual(shown, [SET_ASIDE.keptAs]);

  assert.deepEqual(await ipcMain.invoke(REQ.NOTICES_DISMISS, 'store:llm-config.json'), { ok: true });
  assert.deepEqual(await ipcMain.invoke(REQ.NOTICES_REVEAL, 'store:llm-config.json'), { ok: false });
});

test('the background-error notice carries a count and the log file, and nothing of a store (#978)', () => {
  assert.deepEqual(
    normalizeNotice({ id: 'background-error', kind: NOTICE_KINDS.BACKGROUND_ERROR, count: 3, location: '/l/main.log', store: 'models' }),
    { id: 'background-error', kind: NOTICE_KINDS.BACKGROUND_ERROR, count: 3, location: '/l/main.log', canReveal: true },
  );
  assert.equal(normalizeNotice({ id: 'background-error', kind: NOTICE_KINDS.BACKGROUND_ERROR, count: 0 }), null);
  assert.equal(normalizeNotice({ id: 'background-error', kind: NOTICE_KINDS.BACKGROUND_ERROR, count: 1.5 }), null);
  assert.equal(
    normalizeNotice({ id: 'background-error', kind: NOTICE_KINDS.BACKGROUND_ERROR, count: 1 }).canReveal,
    false,
  );
});

test('the reveal handler shows the log file of the background-error notice (#978)', async () => {
  const handlers = new Map();
  const shown = [];
  const notices = createAppNotices({ log: quiet });
  registerNoticeHandlers({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    notices,
    REQ,
    PUSH,
    getMainWindow: () => null,
    shell: { showItemInFolder: (file) => shown.push(file) },
  });
  notices.post({ id: 'background-error', kind: NOTICE_KINDS.BACKGROUND_ERROR, count: 1, location: '/l/main.log' });
  assert.deepEqual(await handlers.get(REQ.NOTICES_REVEAL)({}, 'background-error'), { ok: true });
  assert.deepEqual(shown, ['/l/main.log']);
});
