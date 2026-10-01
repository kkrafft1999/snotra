'use strict';

// Who may call main over IPC (#509, Electron security checklist item 17).

const test = require('node:test');
const assert = require('node:assert/strict');

const { guardIpcMain, isTrustedIpcSender } = require('../src/main/ipc/trusted-sender');
const { RENDERER_URL } = require('../src/main/permissions');

function eventFrom(url, { parent = null } = {}) {
  return { senderFrame: { url, parent } };
}

function makeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
    invoke: (channel, event, ...args) => handlers.get(channel)(event, ...args),
    emit: (channel, event, ...args) => listeners.get(channel)(event, ...args),
  };
}

test('only the top frame of the app renderer counts as trusted', () => {
  assert.equal(isTrustedIpcSender(eventFrom(RENDERER_URL)), true);
  assert.equal(isTrustedIpcSender(eventFrom(`${RENDERER_URL}#settings`)), true);
  assert.equal(isTrustedIpcSender(eventFrom('https://example.com/')), false);
  assert.equal(isTrustedIpcSender(eventFrom('file:///tmp/evil.html')), false);
  assert.equal(isTrustedIpcSender(eventFrom(RENDERER_URL, { parent: {} })), false, 'a sub-frame is not the app window');
  assert.equal(isTrustedIpcSender({ senderFrame: null }), false, 'a frame that navigated away or is gone');
  assert.equal(isTrustedIpcSender({}), false);
  assert.equal(isTrustedIpcSender(null), false);
  const throwing = { get senderFrame() { throw new Error('disposed'); } };
  assert.equal(isTrustedIpcSender(throwing), false);
});

test('a guarded handle runs for the app window and rejects anyone else', async () => {
  const ipcMain = makeIpcMain();
  const warnings = [];
  const guarded = guardIpcMain(ipcMain, { log: { warn: (message) => warnings.push(message) } });
  const seen = [];
  guarded.handle('fs:readFile', async (_event, file) => { seen.push(file); return 'content'; });

  assert.equal(await ipcMain.invoke('fs:readFile', eventFrom(RENDERER_URL), 'a.txt'), 'content');
  assert.throws(() => ipcMain.invoke('fs:readFile', eventFrom('https://example.com/'), 'b.txt'), /not the app window/);
  assert.deepEqual(seen, ['a.txt'], 'the handler never ran for the foreign sender');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fs:readFile/);
});

test('a guarded on drops a message from anyone but the app window', () => {
  const ipcMain = makeIpcMain();
  const guarded = guardIpcMain(ipcMain, { log: { warn: () => {} } });
  const seen = [];
  guarded.on('chat:abort', (_event, payload) => seen.push(payload));

  ipcMain.emit('chat:abort', eventFrom(RENDERER_URL), { requestId: 'ok' });
  ipcMain.emit('chat:abort', eventFrom('file:///tmp/evil.html'), { requestId: 'evil' });
  assert.deepEqual(seen, [{ requestId: 'ok' }]);
});

test('the check can be replaced, for a test or a second trusted page', async () => {
  const ipcMain = makeIpcMain();
  const guarded = guardIpcMain(ipcMain, { isTrustedSender: (event) => event.ok === true, log: { warn: () => {} } });
  guarded.handle('x', async () => 'yes');
  assert.equal(await ipcMain.invoke('x', { ok: true }), 'yes');
  assert.throws(() => ipcMain.invoke('x', { ok: false }));
});
