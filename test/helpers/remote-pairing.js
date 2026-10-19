'use strict';

// The remote bridge's pairing (#1114) put together for tests: the core's
// decisions with the real adapters — keys in a temporary folder through a
// stand-in safeStorage, the protocol's crypto, the in-memory relay, the native
// confirmation adapter over a fake dialog — and a manual clock.
//
// The phone is simulated with the reference implementation in
// scripts/remote-protocol-vectors.js, not with the bridge's own code: what
// the phone computes and what the bridge checks come from two
// implementations, as they will with the iPhone app.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

const ref = require('../../scripts/remote-protocol-vectors');
const { createRemotePairing } = require('../../src/application/remote/remote-pairing');
const { createConfirmationReceipts } = require('../../src/application/permissions/user-confirmation');
const { createNativeConfirmationAdapter } = require('../../src/main/electron/native-confirmation-adapter');
const { createInMemoryRelayAdapter } = require('../../src/main/remote/in-memory-relay-adapter');
const { createRemoteIdentityStore, FILE_NAME } = require('../../src/main/remote/identity-store-adapter');
const { createRemotePairingCryptoAdapter } = require('../../src/main/remote/pairing-protocol');
const { pairingPrompt } = require('../../src/main/remote/pairing-prompt');
const { writeFileAtomic } = require('../../src/main/services/atomic-write');
const { removeTempDirSync } = require('./temp-dir');

const b64u = (buffer) => Buffer.from(buffer).toString('base64url');
const bytes = (text) => Buffer.from(text, 'base64url');

/** Time that moves only when the test says so, and the timers that run on it. */
function createClock(start = Date.UTC(2026, 9, 18, 12)) {
  let now = start;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const timer = { fn, at: now + ms };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
    advance(ms) {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at > now) continue;
        timers.delete(timer);
        timer.fn();
      }
    },
    pending: () => timers.size,
  };
}

/**
 * A stand-in for Electron's safeStorage: not encryption, but the ciphertext
 * does not contain the plain text, and what it decrypts is what it encrypted.
 */
function createFakeSafeStorage({ available = true } = {}) {
  const mask = (buffer) => Buffer.from(buffer.map((byte) => byte ^ 0x5a));
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.concat([Buffer.from('v10'), mask(Buffer.from(text, 'utf8'))]),
    decryptString: (buffer) => mask(Buffer.from(buffer).subarray(3)).toString('utf8'),
  };
}

/** The native dialog: each box stays open until the test answers it, or its signal closes it. */
function createFakeDialog() {
  const boxes = [];
  return {
    boxes,
    open: () => boxes.filter((box) => box.isOpen),
    showMessageBox(...args) {
      const options = args.length > 1 ? args[1] : args[0];
      return new Promise((resolve) => {
        const box = {
          options,
          isOpen: true,
          answer(response) {
            if (!box.isOpen) return false;
            box.isOpen = false;
            resolve({ response });
            return true;
          },
          allow: () => box.answer(0),
          deny: () => box.answer(1),
        };
        options.signal?.addEventListener('abort', () => box.answer(options.cancelId));
        boxes.push(box);
      });
    },
  };
}

/** Everything logged, as text, for the leak checks. */
function createLog() {
  const lines = [];
  const write = (level) => (...args) => lines.push(`${level} ${args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}`);
  return { lines, warn: write('warn'), error: write('error'), log: write('log'), info: write('info') };
}

/** A phone with its own P-256 keys, speaking to the relay as the iPhone app would. */
function createPhone() {
  const pairs = {
    sign: nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    agree: nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }),
  };
  const point = (key) => {
    const jwk = key.export({ format: 'jwk' });
    return Buffer.concat([Buffer.from([4]), bytes(jwk.x), bytes(jwk.y)]);
  };
  const points = { sign: point(pairs.sign.publicKey), agree: point(pairs.agree.publicKey) };
  const phone = {
    keys: { sign: b64u(points.sign), agree: b64u(points.agree) },
    channelId: null,
    code: null,
    desktopPoints: null,
    sign: (message) => nodeCrypto.sign('sha256', message, { key: pairs.sign.privateKey, dsaEncoding: 'ieee-p1363' }),

    /** Steps 15–22: read the typed key, look the pairing up, claim it with MAC_P. */
    /**
     * `keys` and `sign` replace what goes to the relay while MAC_P stays the
     * phone's own — the keys a relay would swap in.
     */
    async claim(relay, typedKey, { macP, keys, sign } = {}) {
      const parsed = ref.parseCode(typedKey);
      if (parsed.error) throw new Error(`the phone refuses the code: ${parsed.error}`);
      const found = await relay.phone.lookup(parsed.pairingId);
      phone.channelId = found.channelId;
      phone.code = parsed.code;
      phone.desktopPoints = { sign: bytes(found.desktopKeys.sign), agree: bytes(found.desktopKeys.agree) };
      const mac = macP ?? b64u(ref.macPhone(parsed.code, bytes(found.channelId), phone.desktopPoints, points));
      await relay.phone.claim(parsed.pairingId, { phoneKeys: keys ?? phone.keys, macP: mac, sign: sign ?? phone.sign });
      return found.channelId;
    },

    /** The six words the phone shows (step 28). */
    words: () => ref.phraseWords(ref.phraseIndices(phone.desktopPoints, points).indices),

    /** Step 37: `paired`, and a MAC_D the phone can check with the code. */
    acceptsPairing(relay) {
      const seen = relay.phone.read(phone.channelId);
      if (!seen || seen.status !== 'paired' || !seen.macD) return false;
      const expected = ref.macDesktop(phone.code, bytes(phone.channelId), phone.desktopPoints, points);
      return nodeCrypto.timingSafeEqual(expected, bytes(seen.macD));
    },
  };
  return phone;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-remote-'));
  t.after(() => removeTempDirSync(dir));
  return dir;
}

/**
 * @param {object} [options]
 * @param {string} [options.dir]  the user data folder; a fresh one by default
 * @param {object} [options.relay]  an in-memory relay to share across a "restart"
 * @param {boolean} [options.encryption]
 * @param {object} [options.confirmations]  replaces the native adapter
 * @param {string} [options.locale]
 */
function createPairingFixture(t, {
  dir = tempDir(t),
  clock = createClock(),
  relay = null,
  encryption = true,
  confirmations = null,
  locale = 'en',
} = {}) {
  const sharedRelay = relay || createInMemoryRelayAdapter({ relayHost: 'relay.test', now: clock.now });
  const dialog = createFakeDialog();
  const registry = createConfirmationReceipts({ now: clock.now });
  const log = createLog();
  const safeStorage = createFakeSafeStorage({ available: encryption });
  const identity = createRemoteIdentityStore({ safeStorage, fs: fsp, path, dir, writeFileAtomic, log });
  const pairing = createRemotePairing({
    relay: sharedRelay,
    identity,
    crypto: createRemotePairingCryptoAdapter(),
    confirmations: confirmations || createNativeConfirmationAdapter({ dialog, receipts: { issue: registry.issue } }),
    receipts: { redeem: registry.redeem },
    prompt: pairingPrompt(() => locale),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log,
  });
  const states = [];
  pairing.subscribe((state) => states.push(state));
  t.after(() => pairing.dispose());

  /** Polls until `predicate` holds: file writes and streams settle on real ticks. */
  async function until(predicate, what = 'condition') {
    const deadline = Date.now() + 3000;
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last state: ${JSON.stringify(states.at(-1))}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  return {
    dir,
    clock,
    relay: sharedRelay,
    dialog,
    registry,
    log,
    safeStorage,
    identity,
    pairing,
    states,
    until,
    /** The last state pushed, once it is `state`. */
    stateIs: (state) => until(() => (states.at(-1)?.state === state ? states.at(-1) : null), `state ${state}`),
    file: path.join(dir, FILE_NAME),
    /** The plain text of the key file, through the stand-in safeStorage. */
    readSecrets() {
      const outer = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'));
      return JSON.parse(safeStorage.decryptString(Buffer.from(outer.data, 'base64')));
    },
  };
}

module.exports = {
  createClock,
  createFakeDialog,
  createFakeSafeStorage,
  createLog,
  createPairingFixture,
  createPhone,
  tempDir,
};
