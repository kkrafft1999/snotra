'use strict';

// The pairing's way to the window (#1114): the IPC channels main registers,
// the state contract that guards them, and that the composition root wires
// the bridge without reaching the relay (R7).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createApplication } = require('../src/main/composition/create-application');
const { registerRemoteHandlers } = require('../src/main/ipc/remote-handlers');
const { createInMemoryRelayAdapter } = require('../src/main/remote/in-memory-relay-adapter');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const {
  REMOTE_PAIRING_STATES,
  normalizeRemotePairingState,
  normalizeRemotePairingResult,
} = require('../src/shared/contracts/remote/pairing-state');
const { SAFETY_WORDS } = require('../src/main/remote/pairing-protocol');
const { createMockIpcMain } = require('./helpers/mock-ipc');

const CODE = { display: '0111-EP9D-ZH4Q-PYT4-HWWF', qr: 'snotra-pair:v1/relay.example/0111EP9DZH4QPYT4HWWF', expiresAt: 1_700_000_000_000 };
const WORDS = ['coffeecake', 'groundhog', 'maestro', 'kangaroo', 'ozone', 'oncoming'];

test('the state contract lets the facts through and nothing else', () => {
  const state = normalizeRemotePairingState({
    state: 'code',
    encryptionAvailable: true,
    phone: { pairedAt: 5, connected: false, channelId: 'secret', keys: { sign: 'x' } },
    code: { ...CODE, secret: 'EP9DZH4QPYT4HWW' },
    words: WORDS,
    replacing: true,
    reason: null,
    desktopKeys: { sign: 'x', agree: 'y' },
    token: 'id-token',
  });
  assert.deepEqual(state, {
    state: 'code',
    encryptionAvailable: true,
    phone: { pairedAt: 5, connected: false },
    code: CODE,
    words: null,
    replacing: true,
    reason: null,
  });
});

test('the state contract: a code only while it is shown, words only while confirming', () => {
  assert.equal(normalizeRemotePairingState({ state: 'confirm', code: CODE, words: WORDS }).code, null);
  assert.deepEqual(normalizeRemotePairingState({ state: 'confirm', code: CODE, words: WORDS }).words, WORDS);
  assert.equal(normalizeRemotePairingState({ state: 'paired', words: WORDS }).words, null);
  assert.equal(normalizeRemotePairingState({ state: 'code', code: { ...CODE, qr: 'https://evil.example/' } }).state, 'opening', 'a code without its shape is no code');
  assert.equal(normalizeRemotePairingState({ state: 'code', code: { ...CODE, display: '0111-EP9D-ZH4Q-PYT4-HWWI' } }).code, null);
  assert.equal(normalizeRemotePairingState({ state: 'confirm', words: WORDS.slice(0, 5) }).words, null);
  assert.equal(normalizeRemotePairingState({ state: 'confirm', words: [...WORDS.slice(0, 5), 'Ozone'] }).words, null);
  assert.equal(normalizeRemotePairingState({ state: 'nonsense' }).state, 'empty');
  assert.equal(normalizeRemotePairingState(null).state, 'empty');
  assert.equal(normalizeRemotePairingState({ state: 'unreachable', reason: 'because' }).reason, null);
  assert.equal(normalizeRemotePairingState({ state: 'unreachable', reason: 'rate-limited' }).reason, 'rate-limited');
});

test('the state contract accepts every word of the list', () => {
  for (let at = 0; at < SAFETY_WORDS.length; at += 6) {
    const words = SAFETY_WORDS.slice(at, at + 6);
    while (words.length < 6) words.push(SAFETY_WORDS[0]);
    assert.deepEqual(normalizeRemotePairingState({ state: 'confirm', words }).words, words);
  }
});

test('the state names the panel\'s states', () => {
  assert.deepEqual(Object.values(REMOTE_PAIRING_STATES).sort(), [
    'code', 'confirm', 'denied', 'empty', 'expired', 'opening', 'paired', 'stopped', 'unreachable',
  ]);
});

test('results carry ok, a known reason and relayDeleted only', () => {
  assert.deepEqual(normalizeRemotePairingResult({ ok: true, extra: 1 }), { ok: true });
  assert.deepEqual(normalizeRemotePairingResult({ ok: false, reason: 'busy' }), { ok: false, reason: 'busy' });
  assert.deepEqual(normalizeRemotePairingResult({ ok: false, reason: 'Error: at /Users/x' }), { ok: false });
  assert.deepEqual(normalizeRemotePairingResult({ ok: true, relayDeleted: false }), { ok: true, relayDeleted: false });
  assert.deepEqual(normalizeRemotePairingResult(undefined), { ok: false });
});

test('the handlers: four requests without arguments, and a push per change', async () => {
  const ipcMain = createMockIpcMain();
  const pushed = [];
  let listener = null;
  const calls = [];
  const pairing = {
    getState: async () => ({ state: 'empty', token: 'id-token' }),
    start: async (...args) => { calls.push(['start', args]); return { ok: true, channelId: 'x' }; },
    cancel: async (...args) => { calls.push(['cancel', args]); return { ok: true }; },
    unpair: async (...args) => { calls.push(['unpair', args]); return { ok: true, relayDeleted: true }; },
    subscribe: (fn) => { listener = fn; },
  };
  registerRemoteHandlers({ ipcMain, pairing, pushToWindow: (channel, payload) => pushed.push({ channel, payload }), REQ, PUSH });

  assert.deepEqual([...ipcMain.handlers.keys()].sort(), [
    'remote:getState', 'remote:pair:cancel', 'remote:pair:start', 'remote:unpair',
  ]);
  assert.equal((await ipcMain.invoke(REQ.REMOTE_GET_STATE)).token, undefined);
  assert.deepEqual(await ipcMain.invoke(REQ.REMOTE_PAIR_START, { allow: true }), { ok: true });
  assert.deepEqual(await ipcMain.invoke(REQ.REMOTE_PAIR_CANCEL), { ok: true });
  assert.deepEqual(await ipcMain.invoke(REQ.REMOTE_UNPAIR, 'channel'), { ok: true, relayDeleted: true });
  assert.deepEqual(calls, [['start', []], ['cancel', []], ['unpair', []]], 'nothing from the window is passed on');

  listener({ state: 'paired', phone: { pairedAt: 1, connected: false, keys: 'x' } });
  assert.deepEqual(pushed, [{
    channel: 'remote:state',
    payload: { state: 'paired', encryptionAvailable: false, phone: { pairedAt: 1, connected: false }, code: null, words: null, replacing: false, reason: null },
  }]);
});

test('createApplication wires the pairing, and nothing reaches the relay before a pairing starts (R7)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-remote-app-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const relay = createInMemoryRelayAdapter();
  const ipcMain = createMockIpcMain();
  const application = createApplication({
    app: { getPath: () => dir, getVersion: () => '9.9.9' },
    ipcMain,
    dialog: {},
    safeStorage: { isEncryptionAvailable: () => false },
    fs,
    path,
    fetchImpl: async () => assert.fail('no request at start-up'),
    providersModule: {
      getProvider: () => null,
      listProviderMeta: () => [],
      disposeAll() {},
    },
    workspaceState: { getActiveWorkspaceRoot: () => null, setActiveWorkspaceRoot: () => {} },
    getMainWindow: () => null,
    REQ,
    PUSH,
    LIMITS: { MAX_CHAT_SESSIONS: 5, MAX_FOLDER_HISTORY: 3, MAX_READ_FILE_BYTES: 1024, MAX_WRITE_FILE_BYTES: 1024, MAX_TOOL_ROUNDS: 3 },
    remoteRelay: relay,
  });
  t.after(() => application.dispose());

  for (const channel of [REQ.REMOTE_GET_STATE, REQ.REMOTE_PAIR_START, REQ.REMOTE_PAIR_CANCEL, REQ.REMOTE_UNPAIR]) {
    assert.ok(ipcMain.handlers.has(channel), channel);
  }
  const state = await ipcMain.invoke(REQ.REMOTE_GET_STATE);
  assert.equal(state.state, 'empty');
  assert.equal(state.encryptionAvailable, false);
  // Without real encryption no key may be kept, so no pairing starts.
  assert.deepEqual(await ipcMain.invoke(REQ.REMOTE_PAIR_START), { ok: false, reason: 'encryption-unavailable' });
  assert.deepEqual(relay.inspect.calls(), []);
  await assert.rejects(fs.stat(path.join(dir, 'remote-pairing.json')), { code: 'ENOENT' });
});
