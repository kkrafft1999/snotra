'use strict';

// Pairing a phone against the in-memory relay (#1114): open → claim → the
// confirmation port answers → paired → removed; and every other way a
// pairing ends — a wrong MAC_P, expiry, cancel, Deny, no person to ask, an
// unreachable relay — leaves no channel behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { createPairingFixture, createPhone } = require('./helpers/remote-pairing');
const { createRefusingConfirmation } = require('../src/application/permissions/user-confirmation');
const { PAIRING_TTL_MS } = require('../src/application/remote/remote-pairing');

const NOTHING_LEFT = { channels: [], pairings: [] };
const leftOnRelay = (relay) => ({ channels: relay.inspect.channelIds(), pairings: relay.inspect.pairingIds() });

/** Start, and have the phone claim with the typed key from the state. */
async function claimed(f, phone = createPhone(), claimOptions) {
  assert.deepEqual(await f.pairing.start(), { ok: true });
  const shown = await f.stateIs('code');
  await phone.claim(f.relay, shown.code.display, claimOptions);
  return { phone, shown };
}

async function paired(f, phone = createPhone()) {
  await claimed(f, phone);
  await f.stateIs('confirm');
  f.dialog.open()[0].allow();
  await f.stateIs('paired');
  return phone;
}

test('R7: building the pairing and reading its state reach nothing and create no key', async (t) => {
  const f = createPairingFixture(t);
  const state = await f.pairing.getState();
  assert.equal(state.state, 'empty');
  assert.equal(state.encryptionAvailable, true);
  assert.equal(state.phone, null);
  assert.deepEqual(f.relay.inspect.calls(), [], 'no call reached the relay');
  assert.equal(fs.existsSync(f.file), false, 'no identity keys before the first pairing');
});

test('open → claim → Allow → paired → removed', async (t) => {
  const f = createPairingFixture(t);
  const phone = createPhone();

  // Steps 3–11: keys on first use, a pairing at the relay, the code to the window.
  assert.deepEqual(await f.pairing.start(), { ok: true });
  assert.equal(f.states[0].state, 'opening');
  const shown = await f.stateIs('code');
  assert.match(shown.code.display, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
  assert.equal(shown.code.qr, `snotra-pair:v1/relay.test/${shown.code.display.replace(/-/g, '')}`);
  assert.equal(shown.code.expiresAt, f.clock.now() + PAIRING_TTL_MS);
  assert.equal(fs.existsSync(f.file), true, 'the identity keys are kept from the first pairing on');
  assert.equal((fs.statSync(f.file).mode & 0o777).toString(8), process.platform === 'win32' ? (fs.statSync(f.file).mode & 0o777).toString(8) : '600');
  assert.equal(f.relay.inspect.channelIds().length, 1);
  assert.deepEqual(f.relay.inspect.calls(), ['openPairing', 'watchChannel']);

  // Steps 15–29: the phone claims; MAC_P checks out; the words on both sides.
  const channelId = await phone.claim(f.relay, shown.code.display);
  const confirm = await f.stateIs('confirm');
  assert.deepEqual(confirm.words, phone.words(), 'the desktop shows the six words the phone shows');
  assert.equal(confirm.code, null, 'the code is gone once a phone answered');
  assert.equal(confirm.replacing, false);

  // Steps 30–32: the native sheet, Deny the default.
  const [box] = f.dialog.open();
  assert.equal(box.options.buttons[0], 'Allow');
  assert.equal(box.options.buttons[1], 'Deny');
  assert.equal(box.options.defaultId, 1);
  assert.equal(box.options.cancelId, 1);
  assert.equal(box.options.message, 'Allow this phone to access Snotra?');
  const [w1, w2, w3, w4, w5, w6] = confirm.words;
  assert.ok(box.options.detail.includes(`1 ${w1} · 2 ${w2} · 3 ${w3}\n4 ${w4} · 5 ${w5} · 6 ${w6}`), box.options.detail);
  assert.equal(f.relay.inspect.record(channelId).status, 'pending', 'nothing is confirmed before Allow');

  // Steps 33–37: Allow; MAC_D to the relay; the phone accepts it.
  box.allow();
  const done = await f.stateIs('paired');
  assert.equal(done.phone.connected, false, 'no session before part 2 of the protocol');
  assert.equal(done.phone.pairedAt, f.clock.now());
  assert.equal(done.code, null);
  assert.equal(done.words, null);
  assert.equal(f.relay.inspect.record(channelId).status, 'paired');
  assert.equal(phone.acceptsPairing(f.relay), true, 'the phone checks MAC_D with the code');
  assert.deepEqual(f.relay.inspect.pairingIds(), [], 'the relay deleted the pairing');
  assert.deepEqual(await f.identity.readPhone(), { channelId, keys: phone.keys, pairedAt: done.phone.pairedAt });
  assert.equal(f.clock.pending(), 0, 'no timer left running');
  assert.equal(f.relay.inspect.watchers(), 0, 'no stream left open');

  // Phase 5: Remove phone.
  assert.deepEqual(await f.pairing.unpair(), { ok: true, relayDeleted: true });
  assert.equal(f.states.at(-1).state, 'empty');
  assert.equal(await f.identity.readPhone(), null);
  assert.deepEqual(leftOnRelay(f.relay), NOTHING_LEFT);
  assert.equal(f.relay.phone.read(channelId), null, 'the phone sees its channel vanish');
});

test('the identity keys are created once and kept', async (t) => {
  const f = createPairingFixture(t);
  await f.pairing.start();
  await f.stateIs('code');
  const first = f.relay.inspect.record(f.relay.inspect.channelIds()[0]).desktopKeys;
  await f.pairing.cancel();
  await f.pairing.start();
  await f.stateIs('code');
  const second = f.relay.inspect.record(f.relay.inspect.channelIds()[0]).desktopKeys;
  assert.deepEqual(second, first);
  const stored = f.readSecrets();
  assert.equal(stored.identity.sign.crv, 'P-256');
  assert.equal(stored.identity.agree.crv, 'P-256');
  assert.notEqual(stored.identity.sign.d, stored.identity.agree.d, 'two keys, one for each use');
});

test('a wrong MAC_P stops the pairing, asks nobody and leaves no channel', async (t) => {
  const f = createPairingFixture(t);
  await claimed(f, createPhone(), { macP: Buffer.alloc(32, 7).toString('base64url') });
  const stopped = await f.stateIs('stopped');
  assert.equal(stopped.reason, 'mac');
  assert.equal(f.dialog.boxes.length, 0, 'no sheet for keys that do not belong to the code');
  assert.deepEqual(leftOnRelay(f.relay), NOTHING_LEFT);
  assert.equal(await f.identity.readPhone(), null);
});

test('keys the relay swapped in fail MAC_P', async (t) => {
  const f = createPairingFixture(t);
  const phone = createPhone();
  const relayOwn = createPhone();
  // MAC_P over the phone's keys, the claim carrying the relay's: what a relay in the middle would do.
  await claimed(f, phone, { keys: relayOwn.keys, sign: relayOwn.sign });
  const stopped = await f.stateIs('stopped');
  assert.equal(stopped.reason, 'mac');
  assert.equal(f.dialog.boxes.length, 0);
  assert.deepEqual(leftOnRelay(f.relay), NOTHING_LEFT);
});

test('expiry: after five minutes the code expires and the channel goes', async (t) => {
  const f = createPairingFixture(t);
  await f.pairing.start();
  const shown = await f.stateIs('code');
  f.clock.advance(PAIRING_TTL_MS - 1);
  assert.equal(f.states.at(-1).state, 'code');
  f.clock.advance(1);
  const expired = await f.stateIs('expired');
  assert.equal(expired.code, null, 'the code is forgotten');
  await f.until(() => f.relay.inspect.channelIds().length === 0, 'the channel to go');
  assert.deepEqual(leftOnRelay(f.relay), NOTHING_LEFT);
  await assert.rejects(createPhone().claim(f.relay, shown.code.display), { reason: 'not-found' });
});

test('expiry while the sheet is open closes it, and the channel goes', async (t) => {
  const f = createPairingFixture(t);
  await claimed(f);
  await f.stateIs('confirm');
  const [box] = f.dialog.open();
  f.clock.advance(PAIRING_TTL_MS);
  await f.stateIs('expired');
  assert.equal(box.isOpen, false, 'the sheet closed as cancelled');
  assert.equal(box.allow(), false, 'a click after that answers nothing');
  await f.until(() => f.relay.inspect.channelIds().length === 0, 'the channel to go');
  assert.deepEqual(leftOnRelay(f.relay), NOTHING_LEFT);
  assert.equal(await f.identity.readPhone(), null);
});

test('cancel while the code is shown leaves no channel', async (t) => {
  const f = createPairingFixture(t);
  await f.pairing.start();
  await f.stateIs('code');
  assert.deepEqual(await f.pairing.cancel(), { ok: true });
  assert.equal(f.states.at(-1).state, 'empty');
  await f.until(() => f.relay.inspect.channelIds().length === 0, 'the channel to go');
  assert.deepEqual(leftOnRelay(f.relay), NOTHING_LEFT);
  assert.equal(f.clock.pending(), 0);
  assert.equal(f.relay.inspect.watchers(), 0);
});

test('cancel while the sheet is open closes it and leaves no channel', async (t) => {
  const f = createPairingFixture(t);
  await claimed(f);
  await f.stateIs('confirm');
  const [box] = f.dialog.open();
  await f.pairing.cancel();
  assert.equal(box.isOpen, false);
  await f.until(() => f.relay.inspect.channelIds().length === 0, 'the channel to go');
  assert.deepEqual(leftOnRelay(f.relay), NOTHING_LEFT);
  assert.equal(f.states.at(-1).state, 'empty');
});

test('cancel while the relay is still asked: the pairing it opened goes again', async (t) => {
  const f = createPairingFixture(t);
  const open = f.relay.openPairing;
  let answer = null;
  f.relay.openPairing = async (input) => {
    const opened = await open(input);
    await new Promise((resolve) => { answer = resolve; });
    return opened;
  };
  const starting = f.pairing.start();
  await f.until(() => answer, 'the relay to be asked');
  assert.equal(f.relay.inspect.channelIds().length, 1);
  await f.pairing.cancel();
  answer();
  assert.deepEqual(await starting, { ok: false, reason: 'cancelled' });
  await f.until(() => f.relay.inspect.channelIds().length === 0, 'the late pairing to go');
  assert.deepEqual(leftOnRelay(f.relay), NOTHING_LEFT);
  assert.equal(f.states.at(-1).state, 'empty');
});

test('cancel right after start: nothing is opened', async (t) => {
  const f = createPairingFixture(t);
  const starting = f.pairing.start();
  await f.pairing.cancel();
  assert.equal((await starting).ok, false);
  await f.until(() => f.relay.inspect.channelIds().length === 0, 'nothing left');
  assert.equal(f.states.at(-1).state, 'empty');
});

test('Deny leaves no channel and keeps no phone', async (t) => {
  const f = createPairingFixture(t);
  await claimed(f);
  await f.stateIs('confirm');
  f.dialog.open()[0].deny();
  await f.stateIs('denied');
  await f.until(() => f.relay.inspect.channelIds().length === 0, 'the channel to go');
  assert.deepEqual(leftOnRelay(f.relay), NOTHING_LEFT);
  assert.equal(await f.identity.readPhone(), null);
  assert.deepEqual(await f.pairing.cancel(), { ok: true });
  assert.equal(f.states.at(-1).state, 'empty');
});

test('without a person at the desktop no phone gets in', async (t) => {
  const f = createPairingFixture(t, { confirmations: createRefusingConfirmation() });
  await claimed(f);
  await f.stateIs('denied');
  await f.until(() => f.relay.inspect.channelIds().length === 0, 'the channel to go');
  assert.deepEqual(leftOnRelay(f.relay), NOTHING_LEFT);
});

test('a "confirmed" without a receipt from the registry lets nothing in', async (t) => {
  const forged = {
    presence: /** @type {const} */ ('desktop'),
    canConfirm: () => true,
    confirm: async () => ({ confirmed: true, receipt: Object.freeze({}) }),
  };
  const f = createPairingFixture(t, { confirmations: forged });
  await claimed(f);
  await f.stateIs('denied');
  await f.until(() => f.relay.inspect.channelIds().length === 0, 'the channel to go');
  assert.equal(await f.identity.readPhone(), null);
});

test('replacing: the old phone keeps its channel until Allow, then loses it (R1)', async (t) => {
  const f = createPairingFixture(t);
  const first = await paired(f);
  const firstChannel = first.channelId;

  const second = createPhone();
  await claimed(f, second);
  const confirm = await f.stateIs('confirm');
  assert.equal(confirm.replacing, true);
  assert.ok(f.dialog.open()[0].options.detail.includes('The phone paired so far loses its access.'));
  assert.equal(f.relay.inspect.record(firstChannel).status, 'paired', 'the old phone keeps its access meanwhile');

  f.dialog.open()[0].allow();
  await f.stateIs('paired');
  await f.until(() => !f.relay.inspect.channelIds().includes(firstChannel), 'the old channel to go');
  assert.deepEqual(f.relay.inspect.channelIds(), [second.channelId]);
  assert.equal((await f.identity.readPhone()).channelId, second.channelId);
});

test('replacing, denied: the old phone stays', async (t) => {
  const f = createPairingFixture(t);
  const first = await paired(f);
  await claimed(f);
  await f.stateIs('confirm');
  f.dialog.open()[0].deny();
  const denied = await f.stateIs('denied');
  assert.ok(denied.phone, 'the panel still knows the paired phone');
  await f.until(() => f.relay.inspect.channelIds().length === 1, 'the new channel to go');
  assert.deepEqual(f.relay.inspect.channelIds(), [first.channelId]);
  await f.pairing.cancel();
  assert.equal(f.states.at(-1).state, 'paired');
});

test('an unreachable relay ends the pairing as unreachable, with nothing left', async (t) => {
  const f = createPairingFixture(t);
  f.relay.inspect.setReachable(false);
  assert.deepEqual(await f.pairing.start(), { ok: false, reason: 'network' });
  const state = f.states.at(-1);
  assert.equal(state.state, 'unreachable');
  assert.equal(state.reason, 'network');
  f.relay.inspect.setReachable(true);
  assert.deepEqual(leftOnRelay(f.relay), NOTHING_LEFT);
  assert.deepEqual(await f.pairing.start(), { ok: true }, 'Try again');
});

test('a relay gone between Allow and confirm: unreachable, and no phone is kept', async (t) => {
  const f = createPairingFixture(t);
  await claimed(f);
  await f.stateIs('confirm');
  f.relay.inspect.setReachable(false);
  f.dialog.open()[0].allow();
  const state = await f.stateIs('unreachable');
  assert.equal(state.reason, 'network');
  assert.equal(await f.identity.readPhone(), null);
});

test('keys that cannot be kept after Allow: stopped, the channel goes, and a new pairing can start', async (t) => {
  const f = createPairingFixture(t);
  await claimed(f);
  await f.stateIs('confirm');
  f.identity.savePhone = async () => { throw new Error('ENOSPC'); };
  f.dialog.open()[0].allow();
  const stopped = await f.stateIs('stopped');
  assert.equal(stopped.reason, 'not-saved');
  await f.until(() => f.relay.inspect.channelIds().length === 0, 'the channel to go');
  assert.deepEqual(await f.pairing.start(), { ok: true }, 'not stuck in "busy"');
});

test('an unexpected failure after Allow does not leave the pairing stuck', async (t) => {
  const f = createPairingFixture(t);
  await claimed(f);
  await f.stateIs('confirm');
  f.relay.confirmPairing = () => { throw new TypeError('boom'); };
  f.dialog.open()[0].allow();
  await f.stateIs('unreachable');
  assert.deepEqual(await f.pairing.cancel(), { ok: true });
  assert.deepEqual(await f.pairing.start(), { ok: true });
});

test('without real encryption nothing starts and nothing reaches the relay', async (t) => {
  const f = createPairingFixture(t, { encryption: false });
  assert.equal((await f.pairing.getState()).encryptionAvailable, false);
  assert.deepEqual(await f.pairing.start(), { ok: false, reason: 'encryption-unavailable' });
  assert.deepEqual(f.relay.inspect.calls(), []);
  assert.equal(fs.existsSync(f.file), false);
});

test('after a restart the phone is known without asking the relay, and can be removed', async (t) => {
  const before = createPairingFixture(t);
  const phone = await paired(before);
  before.pairing.dispose();
  const calls = before.relay.inspect.calls().length;

  const after = createPairingFixture(t, { dir: before.dir, relay: before.relay, clock: before.clock });
  const state = await after.pairing.getState();
  assert.equal(state.state, 'paired');
  assert.equal(after.relay.inspect.calls().length, calls, 'reading the state asks no relay (R7)');

  // A fresh token for the channel, with a proof signed by the kept key (§5.9).
  assert.deepEqual(await after.pairing.unpair(), { ok: true, relayDeleted: true });
  assert.equal(after.relay.phone.read(phone.channelId), null);
  assert.equal(await after.identity.readPhone(), null);
});

test('Remove phone takes effect here even when the relay cannot be reached', async (t) => {
  const f = createPairingFixture(t);
  const phone = await paired(f);
  f.relay.inspect.setReachable(false);
  assert.deepEqual(await f.pairing.unpair(), { ok: true, relayDeleted: false });
  assert.equal(f.states.at(-1).state, 'empty');
  assert.equal(await f.identity.readPhone(), null);
  assert.equal(f.relay.inspect.record(phone.channelId).status, 'paired', 'the relay keeps it until it can be reached');
});

test('a second start replaces the first pairing, which goes at the relay', async (t) => {
  const f = createPairingFixture(t);
  await Promise.all([f.pairing.start(), f.pairing.start()]);
  await f.stateIs('code');
  await f.until(() => f.relay.inspect.channelIds().length === 1, 'one channel');
  assert.equal(f.relay.inspect.pairingIds().length, 1);
});

test('the words are never translated: a German desktop shows the same six', async (t) => {
  const f = createPairingFixture(t, { locale: 'de' });
  const { phone } = await claimed(f);
  const confirm = await f.stateIs('confirm');
  const [box] = f.dialog.open();
  assert.equal(box.options.message, 'Diesem Handy Zugriff auf Snotra erlauben?');
  assert.deepEqual(box.options.buttons, ['Zulassen', 'Ablehnen']);
  assert.deepEqual(confirm.words, phone.words());
  for (const word of phone.words()) assert.ok(box.options.detail.includes(word));
});

test('the native adapter: an aborted signal closes the sheet and confirms nothing', async () => {
  const { createNativeConfirmationAdapter } = require('../src/main/electron/native-confirmation-adapter');
  const { createFakeDialog } = require('./helpers/remote-pairing');
  const dialog = createFakeDialog();
  const port = createNativeConfirmationAdapter({ dialog });
  const controller = new AbortController();
  const asking = port.confirm({ action: 'remote-pairing', subject: 'x', prompt: { message: 'm', buttons: ['Allow', 'Deny'] }, signal: controller.signal });
  assert.equal(dialog.boxes[0].options.signal, controller.signal);
  controller.abort();
  assert.deepEqual(await asking, { confirmed: false, reason: 'declined' });
  assert.deepEqual(await port.confirm({ action: 'remote-pairing', prompt: { message: 'm', buttons: ['a', 'b'] }, signal: controller.signal }), { confirmed: false, reason: 'declined' });
  assert.equal(dialog.boxes.length, 1, 'an aborted signal shows no sheet at all');
});

test('closed (#1110): a pairing is refused before anything reaches the relay, and the state says so', async (t) => {
  const f = createPairingFixture(t, { open: false });
  assert.deepEqual(await f.pairing.start(), { ok: false, reason: 'locked' });
  const state = await f.pairing.getState();
  assert.equal(state.locked, true);
  assert.equal(state.state, 'empty');
  assert.deepEqual(f.relay.inspect.calls(), [], 'no call reached the relay');
  assert.equal(fs.existsSync(f.file), false, 'no identity keys either');
  assert.equal((await createPairingFixture(t).pairing.getState()).locked, false, 'open by default');
});

test('closed (#1110): a phone paired before can still be removed', async (t) => {
  const open = createPairingFixture(t);
  await paired(open);
  const closed = createPairingFixture(t, { dir: open.dir, relay: open.relay, open: false });
  assert.equal((await closed.pairing.getState()).state, 'paired');
  assert.deepEqual(await closed.pairing.start(), { ok: false, reason: 'locked' }, 'replacing it is pairing too');
  assert.equal((await closed.pairing.unpair()).ok, true);
  assert.equal((await closed.pairing.getState()).state, 'empty');
});
