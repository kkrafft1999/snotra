// Settings › Remote access end to end (#1110): the panel on the real markup,
// main's IPC handlers and the remote bridge, the in-memory relay and the
// reference phone — code shown → the phone claims → the native dialog is
// answered → paired → removed. Pairing is opened here; this build keeps it
// closed until the phone's side is out, and the last test checks that.
//
// The Electron app cannot be handed a fake relay, so this runs the same
// pieces in one process, with the window's API standing in for the preload.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { importRenderer, setupRendererDom } = require('./helpers/dom.js');
const { createRemoteBridge } = require('../src/main/composition/create-remote-bridge');
const { registerRemoteHandlers } = require('../src/main/ipc/remote-handlers');
const { createInMemoryRelayAdapter } = require('../src/main/remote/in-memory-relay-adapter');
const { createConfirmationReceipts } = require('../src/application/permissions/user-confirmation');
const { createNativeConfirmationAdapter } = require('../src/main/electron/native-confirmation-adapter');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');
const { createFakeDialog, createFakeSafeStorage, createLog, createPhone, tempDir } = require('./helpers/remote-pairing');

async function wired(t, { pairingOpen = true } = {}) {
  const dom = setupRendererDom();
  t.after(dom.cleanup);
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en', { force: true });
  const { initRemoteAccessSettings } = await importRenderer('components', 'RemoteAccessSettings.js');

  const relay = createInMemoryRelayAdapter({ relayHost: 'relay.test' });
  const dialog = createFakeDialog();
  const registry = createConfirmationReceipts();
  const bridge = createRemoteBridge({
    pairingOpen,
    userDataPath: tempDir(t),
    secretStore: createFakeSafeStorage(),
    fs: fsp,
    path,
    confirmations: createNativeConfirmationAdapter({ dialog, receipts: { issue: registry.issue } }),
    receipts: { redeem: registry.redeem },
    getLocale: () => 'en',
    relay,
    log: createLog(),
  });
  t.after(() => bridge.dispose());
  const ipcMain = createMockIpcMain();
  const listeners = new Set();
  registerRemoteHandlers({
    ipcMain,
    pairing: bridge.pairing,
    pushToWindow: (channel, payload) => {
      // What crosses to the window is a copy, as over IPC.
      if (channel === PUSH.REMOTE_STATE) for (const listener of listeners) listener(structuredClone(payload));
      return true;
    },
    REQ,
    PUSH,
  });
  const api = {
    remote: {
      getState: () => ipcMain.invoke(REQ.REMOTE_GET_STATE),
      startPairing: () => ipcMain.invoke(REQ.REMOTE_PAIR_START),
      cancelPairing: () => ipcMain.invoke(REQ.REMOTE_PAIR_CANCEL),
      unpair: () => ipcMain.invoke(REQ.REMOTE_UNPAIR),
      onState: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
      getReleases: async () => ({ available: true, paired: true, released: [] }),
    },
  };
  const root = dom.document.getElementById('settings-remote-body');
  const panel = initRemoteAccessSettings({ root, api });
  t.after(() => panel.dispose());
  await panel.open();

  async function until(predicate, what) {
    const deadline = Date.now() + 3000;
    for (;;) {
      if (predicate()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; the panel says: ${root.textContent.replace(/\s+/g, ' ').slice(0, 200)}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  const q = (selector) => root.querySelector(selector);
  return { root, q, relay, dialog, until };
}

test('pair through the panel: code → claim → Allow in the system dialog → paired → removed', async (t) => {
  const { q, relay, dialog, until } = await wired(t);
  assert.equal(q('[data-action="pair"]').disabled, false);
  q('[data-action="pair"]').click();
  await until(() => q('.ra-key')?.textContent, 'the code');
  assert.ok(q('.ra-qr svg'), 'the QR code drawn from main\'s modules');

  const phone = createPhone();
  await phone.claim(relay, q('.ra-key').textContent);
  await until(() => q('.ra-words'), 'the six words');
  const shown = [...q('.ra-words').querySelectorAll('.w')].map((w) => w.textContent);
  assert.equal(shown.length, 6);
  const [sheet] = dialog.open();
  assert.ok(sheet, 'the system dialog asks');
  sheet.allow();
  await until(() => q('.ra-device'), 'the paired phone');
  assert.match(q('.ra-device').textContent, /Your iPhone/);

  q('[data-action="remove"]').click();
  q('[role="alertdialog"] .btn-destructive').click();
  await until(() => q('[data-action="pair"]'), 'the empty state again');
  assert.deepEqual(relay.inspect.channelIds(), [], 'the relay deleted the channel');
});

test('Deny in the system dialog: back to the empty state, nothing connected', async (t) => {
  const { q, relay, dialog, until } = await wired(t);
  q('[data-action="pair"]').click();
  await until(() => q('.ra-key')?.textContent, 'the code');
  await createPhone().claim(relay, q('.ra-key').textContent);
  await until(() => dialog.open().length === 1, 'the system dialog');
  dialog.open()[0].deny();
  await until(() => /You denied the phone/.test(q('.ra-notice')?.textContent ?? ''), 'the denied line');
  assert.ok(q('[data-action="pair"]'));
});

test('closed, as this build ships: the panel shows why, and main refuses even a forged click', async (t) => {
  const { q, relay, root } = await wired(t, { pairingOpen: false });
  const pair = q('[data-action="pair"]');
  assert.equal(pair.disabled, true);
  assert.match(root.textContent, /Pairing opens once the Snotra app for iPhone is out/);
  // A renderer that enables the button anyway gets nowhere: main says locked.
  pair.disabled = false;
  pair.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(relay.inspect.calls(), [], 'nothing reached the relay');
  assert.match(q('.ra-notice').textContent, /Pairing opens once the Snotra app for iPhone is out/);
});
