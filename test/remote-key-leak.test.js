'use strict';

// The keys of the mobile remote (#1114) never appear in a log, an IPC payload
// or a crash report: the desktop's private keys, the relay's tokens, and the
// pairing code outside the one state that shows it — and, since the channel
// (#1192), neither the session keys nor what a message said.
//
// The pairing runs as main wires it — createRemoteBridge, the IPC handlers,
// the native confirmation adapter — through every way it can end; everything
// the window receives, everything logged, and the diagnostics report built
// from that log are then searched for the secrets in every spelling they
// have. The error reporter is installed meanwhile, so that an error nobody
// caught would land in the report as well.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const util = require('node:util');
const nodeCrypto = require('node:crypto');

const { createRemoteBridge } = require('../src/main/composition/create-remote-bridge');
const { registerRemoteHandlers } = require('../src/main/ipc/remote-handlers');
const { createInMemoryRelayAdapter } = require('../src/main/remote/in-memory-relay-adapter');
const { createFirebaseRelayAdapter } = require('../src/main/remote/firebase-relay-adapter');
const { createRemoteIdentityStore, FILE_NAME } = require('../src/main/remote/identity-store-adapter');
const { createConfirmationReceipts } = require('../src/application/permissions/user-confirmation');
const { createNativeConfirmationAdapter } = require('../src/main/electron/native-confirmation-adapter');
const { createErrorReporter, installProcessErrorHandlers } = require('../src/main/services/error-reporter');
const { buildDiagnosticsReport } = require('../src/main/services/diagnostics-report');
const { writeFileAtomic } = require('../src/main/services/atomic-write');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const protocol = require('../src/main/remote/pairing-protocol');
const { createMockIpcMain } = require('./helpers/mock-ipc');
const { createFakeDialog, createFakeSafeStorage, createLog, createPhone, tempDir } = require('./helpers/remote-pairing');
const { HELLO, createChannelPhone } = require('./helpers/remote-channel');

/** Main as it is wired, with everything the outside world could see captured. */
function wiredMain(t, { relay, dir = tempDir(t) } = {}) {
  const log = createLog();
  const reporter = createErrorReporter({ log });
  const uninstall = installProcessErrorHandlers(process, reporter);
  t.after(uninstall);
  const dialog = createFakeDialog();
  const registry = createConfirmationReceipts();
  const safeStorage = createFakeSafeStorage();
  const ipcMain = createMockIpcMain();
  const ipc = [];
  const bridge = createRemoteBridge({
    userDataPath: dir,
    secretStore: safeStorage,
    fs: fsp,
    path,
    confirmations: createNativeConfirmationAdapter({ dialog, receipts: { issue: registry.issue } }),
    receipts: { redeem: registry.redeem },
    getLocale: () => 'en',
    relay,
    log,
  });
  t.after(() => bridge.dispose());
  registerRemoteHandlers({
    ipcMain,
    pairing: bridge.pairing,
    pushToWindow: (channel, payload) => { ipc.push({ channel, payload: structuredClone(payload) }); return true; },
    REQ,
    PUSH,
  });
  const invoke = async (channel) => {
    const result = await ipcMain.invoke(channel);
    ipc.push({ channel, payload: structuredClone(result) });
    return result;
  };
  const lastState = () => ipc.filter((entry) => entry.channel === PUSH.REMOTE_STATE).at(-1)?.payload;
  async function until(state) {
    const deadline = Date.now() + 3000;
    while (lastState()?.state !== state) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${state}; at ${JSON.stringify(lastState())}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return lastState();
  }
  /** The private keys as stored, decrypted through the stand-in safeStorage. */
  function privateKeys() {
    const outer = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'));
    const inner = JSON.parse(safeStorage.decryptString(Buffer.from(outer.data, 'base64')));
    return [inner.identity.sign, inner.identity.agree];
  }
  /** What a user would paste into an issue: the diagnostics report over this log. */
  function diagnosticsReport() {
    return buildDiagnosticsReport({
      appName: 'Snotra Agent',
      appVersion: '0.0.0',
      platform: process.platform,
      arch: process.arch,
      osRelease: '',
      errorCount: reporter.count(),
      logFile: { filePath: 'main.log', tail: (n) => log.lines.slice(-n) },
    });
  }
  return { bridge, dialog, ipc, log, reporter, invoke, until, lastState, privateKeys, diagnosticsReport, dir };
}

/** Every spelling of a private key: the JWK's scalar, its hex and base64, the whole JWK. */
function spellings(jwk) {
  const d = Buffer.from(jwk.d, 'base64url');
  return [jwk.d, d.toString('hex'), d.toString('base64'), d.toString('base64').replace(/=+$/, ''), JSON.stringify(jwk)];
}

function assertAbsent(haystack, secrets, where) {
  for (const secret of secrets) {
    assert.ok(!haystack.includes(secret), `${where} carries a secret (${secret.slice(0, 6)}…)`);
  }
}

test('the identity keys never reach a log, an IPC payload or a crash report', async (t) => {
  const relay = createInMemoryRelayAdapter({ relayHost: 'relay.test' });
  const main = wiredMain(t, { relay });
  const codes = [];
  const channelIds = [];

  assert.equal((await main.invoke(REQ.REMOTE_GET_STATE)).state, 'empty');

  // A wrong MAC_P.
  assert.deepEqual(await main.invoke(REQ.REMOTE_PAIR_START), { ok: true });
  let shown = await main.until('code');
  codes.push(shown.code.display.replace(/-/g, ''));
  channelIds.push(await createPhone().claim(relay, shown.code.display, { macP: Buffer.alloc(32).toString('base64url') }));
  await main.until('stopped');

  // Deny.
  await main.invoke(REQ.REMOTE_PAIR_START);
  shown = await main.until('code');
  codes.push(shown.code.display.replace(/-/g, ''));
  channelIds.push(await createPhone().claim(relay, shown.code.display));
  await main.until('confirm');
  main.dialog.open()[0].deny();
  await main.until('denied');

  // An unreachable relay.
  relay.inspect.setReachable(false);
  await main.invoke(REQ.REMOTE_PAIR_START);
  await main.until('unreachable');
  relay.inspect.setReachable(true);

  // Paired, then removed — once with the relay gone, so its failure is logged.
  await main.invoke(REQ.REMOTE_PAIR_START);
  shown = await main.until('code');
  codes.push(shown.code.display.replace(/-/g, ''));
  channelIds.push(await createPhone().claim(relay, shown.code.display));
  await main.until('confirm');
  const prompt = main.dialog.open()[0].options;
  main.dialog.open()[0].allow();
  await main.until('paired');
  relay.inspect.setReachable(false);
  assert.deepEqual(await main.invoke(REQ.REMOTE_UNPAIR), { ok: true, relayDeleted: false });
  assert.ok(main.log.lines.some((line) => line.includes('[remote]')), 'the failures above were logged');

  const keys = main.privateKeys().flatMap(spellings);
  const ipcText = JSON.stringify(main.ipc);
  const logText = main.log.lines.join('\n');
  assertAbsent(ipcText, keys, 'an IPC payload');
  assertAbsent(logText, keys, 'the log');
  assertAbsent(main.diagnosticsReport(), keys, 'the diagnostics report');
  assertAbsent(JSON.stringify(prompt), keys, 'the native sheet');
  assert.equal(main.reporter.count(), 0, 'nothing went uncaught, so nothing reached a crash report');

  // The pairing code reaches the window while it is shown, and nowhere else.
  for (const code of codes) {
    assertAbsent(logText, [code], 'the log');
    for (const entry of main.ipc) {
      if (JSON.stringify(entry.payload).includes(code)) {
        assert.equal(entry.payload.state, 'code', `the code went out in ${entry.channel} / ${entry.payload.state}`);
      }
    }
  }

  // No channel id either: the window names nothing at the relay.
  assert.equal(channelIds.length, 3);
  assertAbsent(ipcText, channelIds, 'an IPC payload');
  assertAbsent(logText, channelIds, 'the log');

  // And nothing but the fields of the contract.
  const allowed = new Set(['state', 'encryptionAvailable', 'phone', 'code', 'words', 'replacing', 'reason', 'ok', 'relayDeleted']);
  for (const { channel, payload } of main.ipc) {
    for (const key of Object.keys(payload)) assert.ok(allowed.has(key), `${channel} carries ${key}`);
    if (payload.phone) assert.deepEqual(Object.keys(payload.phone).sort(), ['connected', 'pairedAt']);
  }
});

test('the identity handed out can be printed and serialized without its key', async (t) => {
  const dir = tempDir(t);
  const safeStorage = createFakeSafeStorage();
  const store = createRemoteIdentityStore({ safeStorage, fs: fsp, path, dir, writeFileAtomic, log: createLog() });
  const identity = await store.loadIdentity();
  const outer = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'));
  const keys = Object.values(JSON.parse(safeStorage.decryptString(Buffer.from(outer.data, 'base64'))).identity).flatMap(spellings);

  const printed = [
    util.inspect(identity, { depth: 10, showHidden: true }),
    JSON.stringify(identity),
    String(identity),
    util.inspect(store, { depth: 10, showHidden: true }),
  ].join('\n');
  assertAbsent(printed, keys, 'a printed identity');
  assert.ok(!fs.readFileSync(path.join(dir, FILE_NAME), 'utf8').includes(keys[0]), 'the file holds ciphertext only');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, FILE_NAME)).mode & 0o777, 0o600);

  // The signer works, and is the only way to the key.
  const message = Buffer.from('snotra');
  assert.equal(protocol.verifySignature(identity.keys.sign, message, identity.sign(message)), true);
  assert.equal(Buffer.from(identity.agree(identity.keys.agree)).length, 32, 'the agreement works');
  assert.deepEqual(Object.keys(identity).sort(), ['agree', 'keys', 'sign']);
  assert.ok(Object.isFrozen(identity));
});

test('relay tokens never reach a log, an IPC payload or a crash report', async (t) => {
  const ID_TOKEN = `id-token-${nodeCrypto.randomBytes(12).toString('hex')}`;
  const CUSTOM_TOKEN = `custom-token-${nodeCrypto.randomBytes(12).toString('hex')}`;
  const channelId = protocol.toB64u(nodeCrypto.randomBytes(16));
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  // A relay that opens the pairing and then drops every stream, naming the URL — token included — in its error.
  const fetchImpl = async (url, init = {}) => {
    const { host, pathname } = new URL(url);
    if (pathname === '/v1/challenges') return json(200, { challenge: protocol.toB64u(nodeCrypto.randomBytes(32)) });
    if (pathname === '/v1/pairings') return json(201, { channelId, pairingId: '0111', expiresAt: 1, token: CUSTOM_TOKEN });
    if (pathname.endsWith('signInWithCustomToken')) return json(200, { idToken: ID_TOKEN, refreshToken: `refresh-${ID_TOKEN}` });
    if (host === 'db.test') throw new TypeError(`fetch failed: ${url}`);
    if (init.method === 'DELETE') throw new TypeError(`connect ECONNREFUSED for ${url} with Bearer ${ID_TOKEN}`);
    return json(404);
  };
  const relay = createFirebaseRelayAdapter({
    endpoint: { relayHost: 'relay.test', databaseUrl: 'https://db.test', apiKey: 'key', identityToolkitUrl: 'https://idt.test/v1' },
    fetchImpl,
    wait: async () => {},
  });
  const main = wiredMain(t, { relay });

  assert.deepEqual(await main.invoke(REQ.REMOTE_PAIR_START), { ok: true });
  const ended = await main.until('unreachable');
  assert.equal(ended.reason, 'network');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(main.log.lines.some((line) => line.includes('cancelling the pairing')), 'the failed cancel was logged');

  const secrets = [ID_TOKEN, CUSTOM_TOKEN];
  assertAbsent(JSON.stringify(main.ipc), secrets, 'an IPC payload');
  assertAbsent(main.log.lines.join('\n'), secrets, 'the log');
  assertAbsent(main.diagnosticsReport(), secrets, 'the diagnostics report');
  assert.equal(main.reporter.count(), 0);
});

test('the channel\'s session keys and messages never reach a log, an IPC payload or a crash report', async (t) => {
  const relay = createInMemoryRelayAdapter({ relayHost: 'relay.test' });
  const main = wiredMain(t, { relay });
  const phone = createPhone();
  await main.invoke(REQ.REMOTE_PAIR_START);
  const shown = await main.until('code');
  const channelId = await phone.claim(relay, shown.code.display);
  await main.until('confirm');
  main.dialog.open()[0].allow();
  await main.until('paired');

  await main.bridge.start();
  const until = async (predicate, what) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  await until(() => relay.inspect.nodes(channelId)?.presence.desktop, 'presence');
  const desktopKeys = (await main.bridge.pairing.getState()) && relay.inspect.record(channelId).desktopKeys;
  const mobile = createChannelPhone(relay, phone, channelId, desktopKeys);
  const sessionKeys = [];
  const SECRET_TEXT = `secret-plaintext-${nodeCrypto.randomBytes(8).toString('hex')}`;

  // Two sessions: one ended by a bad tag, one that stands — and the window learns it.
  await mobile.handshake({ until });
  sessionKeys.push(mobile.keys);
  await mobile.send(HELLO);
  await until(() => mobile.receive().length, 'the first answer');
  await mobile.send(null, { counter: 1, sealed: Buffer.alloc(40, 1).toString('base64url') });
  await until(() => main.log.lines.some((line) => line.includes('starts over (tag)')), 'the start-over logged');
  await mobile.handshake({ until });
  sessionKeys.push(mobile.keys);
  await mobile.send(HELLO);
  await until(() => main.lastState()?.phone?.connected === true, 'connected in the window');
  await mobile.send({ jsonrpc: '2.0', id: 2, method: 'message.send', params: { chatId: 'c', text: SECRET_TEXT, clientMessageId: 'm' } });
  const answers = [];
  await until(() => {
    answers.push(...mobile.receive());
    return answers.some(({ message }) => message.error?.data.reason === 'unavailable');
  }, 'the stand-in\'s answer');

  main.bridge.dispose();
  await until(() => relay.inspect.nodes(channelId)?.presence.desktop === null, 'presence deleted on quit');

  const secrets = sessionKeys.flatMap((keys) => [keys.toDesktop, keys.toPhone].flatMap((key) => [key.toString('hex'), key.toString('base64'), key.toString('base64url')]));
  secrets.push(SECRET_TEXT);
  const logText = main.log.lines.join('\n');
  assertAbsent(JSON.stringify(main.ipc), secrets, 'an IPC payload');
  assertAbsent(logText, secrets, 'the log');
  assertAbsent(main.diagnosticsReport(), secrets, 'the diagnostics report');
  assertAbsent(util.inspect(main.bridge, { depth: 10, showHidden: true }), secrets, 'the bridge, printed');
  assertAbsent(logText, [channelId, mobile.sid], 'the log');
  assert.equal(main.reporter.count(), 0);
});
