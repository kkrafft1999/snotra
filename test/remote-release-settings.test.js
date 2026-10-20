'use strict';

// The switch *Access from your phone* (#1195): opening a workspace asks the
// person at the desktop natively and hands the receipt to the release list
// (#1194); closing it asks nothing. Over the in-memory relay, a workspace
// closed again disappears from the phone's list and ends what it followed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { CONFIRMATION_ACTIONS, createConfirmationReceipts } = require('../src/application/permissions/user-confirmation');
const { createRemoteDispatcher } = require('../src/application/remote/remote-dispatcher');
const { registerRemoteHandlers } = require('../src/main/ipc/remote-handlers');
const { createRemoteReleaseSettings } = require('../src/main/remote/release-settings');
const { createRemoteReleaseStore } = require('../src/main/remote/release-store-adapter');
const { writeFileAtomic } = require('../src/main/services/atomic-write');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const { translateMessage } = require('../src/shared/i18n');
const { HELLO, createChannelFixture, createChannelPhone, pairedFixture } = require('./helpers/remote-channel');
const { createMockIpcMain } = require('./helpers/mock-ipc');
const { removeTempDir } = require('./helpers/temp-dir');

const ROOT = path.resolve('/projects/alpha');
const OTHER = path.resolve('/projects/beta');
const UNKNOWN = path.resolve('/projects/elsewhere');
const normalizeRoot = (root) => (typeof root === 'string' && root.trim() ? path.resolve(root.trim()) : null);

/** Reversible, and not the plain text: as in remote-release-store.test.js. */
function fakeSafeStorage({ available = true } = {}) {
  return {
    available,
    isEncryptionAvailable() { return this.available; },
    encryptString: (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64').split('').reverse().join(''), 'utf8'),
    decryptString: (data) => Buffer.from(data.toString('utf8').split('').reverse().join(''), 'base64').toString('utf8'),
  };
}

/** The desktop's native dialog: answers as told and hands out real receipts. */
function fakeConfirmations(receipts, { answer = true } = {}) {
  const asked = [];
  return {
    presence: 'desktop',
    canConfirm: () => true,
    answer,
    asked,
    async confirm(request) {
      asked.push(request);
      if (!this.answer) return { confirmed: false, reason: 'declined' };
      return { confirmed: true, receipt: receipts.issue({ action: request.action, subject: request.subject }) };
    },
  };
}

async function setup(t, { safeStorage = fakeSafeStorage(), answer = true, paired = true, active = ROOT, locale = 'en' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-release-settings-'));
  t.after(() => removeTempDir(dir));
  const receipts = createConfirmationReceipts();
  const releases = createRemoteReleaseStore({
    safeStorage, receipts, normalizeRoot, fs, path, dir, writeFileAtomic, log: { warn() {} },
  });
  const confirmations = fakeConfirmations(receipts, { answer });
  const pairing = { state: paired ? 'paired' : 'empty', getState: async () => ({ state: pairing.state }) };
  const settings = createRemoteReleaseSettings({
    releases,
    pairing,
    confirmations,
    normalizeRoot,
    getActiveWorkspaceRoot: () => active,
    listKnownWorkspaces: async () => [ROOT, `${OTHER}/`],
    getLocale: () => locale,
    log: { warn() {} },
  });
  return { settings, releases, confirmations, pairing, dir };
}

test('every workspace starts closed to the phone', async (t) => {
  const { settings } = await setup(t);
  assert.deepEqual(await settings.getState(), { available: true, paired: true, released: [] });
});

test('opening a workspace asks natively, bound to that root, with Cancel as the default', async (t) => {
  const { settings, confirmations } = await setup(t);
  assert.deepEqual(await settings.setReleased(ROOT, true), { ok: true, released: true });
  assert.equal(confirmations.asked.length, 1);
  const [request] = confirmations.asked;
  assert.equal(request.action, CONFIRMATION_ACTIONS.REMOTE_WORKSPACE);
  assert.equal(request.subject, ROOT);
  assert.equal(request.prompt.defaultId, 1);
  assert.equal(request.prompt.cancelId, 1);
  assert.deepEqual(request.prompt.buttons, ['Open to phone', 'Cancel']);
  assert.ok(request.prompt.detail.includes(ROOT), 'the dialog names the folder');
  assert.deepEqual((await settings.getState()).released, [ROOT]);
});

test('the dialog speaks the interface language', async (t) => {
  const { settings, confirmations } = await setup(t, { locale: 'de' });
  await settings.setReleased(ROOT, true);
  assert.deepEqual(confirmations.asked[0].prompt.buttons, ['Für Handy öffnen', 'Abbrechen']);
});

test('a cancelled dialog opens nothing and says so as a cancellation', async (t) => {
  const { settings } = await setup(t, { answer: false });
  const result = await settings.setReleased(ROOT, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cancelled');
  assert.deepEqual((await settings.getState()).released, []);
});

test('closing takes effect at once and asks nothing', async (t) => {
  const { settings, confirmations } = await setup(t);
  await settings.setReleased(ROOT, true);
  assert.deepEqual(await settings.setReleased(ROOT, false), { ok: true, released: false });
  assert.equal(confirmations.asked.length, 1, 'only the opening asked');
  assert.deepEqual((await settings.getState()).released, []);
});

test('only a folder Snotra knows can be switched — never a new path from the window', async (t) => {
  const { settings, confirmations } = await setup(t, { active: null });
  const result = await settings.setReleased(UNKNOWN, true);
  assert.equal(result.ok, false);
  assert.equal(result.error.key, 'remote.release.error.unknownWorkspace');
  assert.equal(confirmations.asked.length, 0, 'no dialog for a folder it may not switch');
  assert.equal((await settings.setReleased(42, true)).ok, false);
  // A known folder, however the window spelled it.
  assert.deepEqual(await settings.setReleased(OTHER, true), { ok: true, released: true });
  assert.deepEqual((await settings.getState()).released, [OTHER]);
});

test('a setting that is not true or false is refused', async (t) => {
  const { settings, confirmations } = await setup(t);
  const result = await settings.setReleased(ROOT, 'yes');
  assert.equal(result.error.key, 'remote.release.error.invalid');
  assert.equal(confirmations.asked.length, 0);
});

test('without real encryption nothing is asked and nothing opens', async (t) => {
  const { settings, confirmations } = await setup(t, { safeStorage: fakeSafeStorage({ available: false }) });
  assert.deepEqual(await settings.getState(), { available: false, paired: true, released: [] });
  const result = await settings.setReleased(ROOT, true);
  assert.equal(result.error.key, 'remote.release.error.encryption');
  assert.equal(confirmations.asked.length, 0, 'no confirmation that leads nowhere');
});

test('a workspace can be opened before a phone is paired; the state says there is none', async (t) => {
  const { settings, pairing } = await setup(t, { paired: false });
  assert.equal((await settings.getState()).paired, false);
  assert.deepEqual(await settings.setReleased(ROOT, true), { ok: true, released: true });
  pairing.state = 'paired';
  assert.deepEqual(await settings.getState(), { available: true, paired: true, released: [ROOT] });
});

test('the handlers: read and set by root, a push on every change of the list or the pairing', async (t) => {
  const { settings } = await setup(t);
  const ipcMain = createMockIpcMain();
  const pushed = [];
  const pairingListeners = [];
  const pairing = {
    getState: async () => ({ state: 'paired' }),
    start: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
    unpair: async () => ({ ok: true }),
    subscribe: (fn) => { pairingListeners.push(fn); },
  };
  registerRemoteHandlers({ ipcMain, pairing, releaseSettings: settings, pushToWindow: (channel) => pushed.push(channel), REQ, PUSH });
  assert.ok(ipcMain.handlers.has(REQ.REMOTE_RELEASE_GET));
  assert.ok(ipcMain.handlers.has(REQ.REMOTE_RELEASE_SET));

  assert.deepEqual(await ipcMain.invoke(REQ.REMOTE_RELEASE_SET, ROOT, true), { ok: true, released: true });
  assert.deepEqual(await ipcMain.invoke(REQ.REMOTE_RELEASE_GET), { available: true, paired: true, released: [ROOT] });
  assert.ok(pushed.includes(PUSH.REMOTE_RELEASE_CHANGED), 'the window hears of the change');

  pushed.length = 0;
  for (const listener of pairingListeners) listener({ state: 'empty' });
  assert.ok(pushed.includes(PUSH.REMOTE_RELEASE_CHANGED), 'and of a pairing that changed');
});

test('over the in-memory relay, closing a workspace hides it from the phone and ends what it followed', async (t) => {
  const { settings, releases } = await setup(t);
  await settings.setReleased(ROOT, true);

  const paired = await pairedFixture(t);
  const { fixture, phone, channelId, desktopKeys } = paired;
  const listeners = new Set();
  const desktop = {
    knownWorkspaces: async () => [ROOT],
    activeWorkspace: () => ROOT,
    listChats: async (roots) => (roots.includes(ROOT) ? [{ chatId: 'c1', root: ROOT, title: 'Notes', updatedAt: 5, messageCount: 1 }] : []),
    loadChat: async (chatId) => (chatId === 'c1'
      ? { chatId, root: ROOT, title: 'Notes', updatedAt: 5, messages: [{ role: 'user', content: 'Hello' }] }
      : null),
    runningChats: () => new Set(),
    awaitingApproval: () => new Set(),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const dispatcher = createRemoteDispatcher({
    desktop, releases, word: translateMessage, deltaBatchMs: 0,
    setTimer: fixture.clock.setTimer, clearTimer: fixture.clock.clearTimer, log: fixture.log,
  });
  const harness = createChannelFixture(t, paired, { messages: dispatcher });
  await harness.channel.start();
  await fixture.until(() => harness.channel.inspect().live, 'the channel to stand');
  const mobile = createChannelPhone(fixture.relay, phone, channelId, desktopKeys);
  await mobile.handshake({ until: fixture.until });
  await mobile.send(HELLO);
  const received = [];
  const next = (predicate, what) => fixture.until(() => {
    received.push(...mobile.receive().map((r) => r.message));
    return received.find(predicate) ?? null;
  }, what);
  let ids = 1;
  const request = async (method, params = {}) => {
    const id = (ids += 1);
    await mobile.send({ jsonrpc: '2.0', id, method, params });
    return next((m) => m.id === id, `the answer to ${method}`);
  };

  const before = await next((m) => m.method === 'state', 'the first state');
  assert.notEqual(before.params.activeWorkspaceId, null, 'the open workspace is the phone\'s');
  const listed = await request('workspaces.list');
  assert.equal(listed.result.workspaces.length, 1);
  await request('chat.open', { chatId: 'c1' });

  assert.deepEqual(await settings.setReleased(ROOT, false), { ok: true, released: false });
  const after = await next((m) => m.method === 'state' && m !== before, 'a state after closing');
  assert.equal(after.params.activeWorkspaceId, null, 'the desktop stays in the folder, the phone no longer sees it');

  for (const listener of listeners) listener({ kind: 'run', chatId: 'c1', runId: 'r1', type: 'delta', payload: { text: 'gone' } });
  assert.deepEqual((await request('workspaces.list')).result, { workspaces: [] });
  assert.equal(received.filter((m) => m.method === 'chat.delta').length, 0, 'nothing of the closed chat reaches the phone');
  assert.ok((await request('chat.open', { chatId: 'c1' })).error, 'the closed chat cannot be opened again');
  assert.ok(!JSON.stringify(received).includes(ROOT), 'no path reached the phone');
});
