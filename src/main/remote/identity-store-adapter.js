'use strict';

/**
 * The desktop's keys for the mobile remote, and the phone it is paired with
 * (#1114; docs/remote-protocol.md §3, steps 3–4 and 33 of the sequence).
 *
 * One file in the user data folder, `remote-pairing.json`, holds a single
 * `safeStorage` ciphertext; in it the two long-term P-256 private keys (sign
 * and agree) and the paired phone's channel id and public keys. Nothing of it
 * is readable without the key behind `safeStorage`, and the agent's own
 * commands cannot read the folder at all (the sandbox denies it).
 *
 * In memory the private keys are `KeyObject`s inside a closure: the identity
 * handed out has the public points and a `sign` function, and neither
 * `JSON.stringify`, `util.inspect` nor a crash report can print the key
 * behind it. The keys are created on first use — when the user starts the
 * first pairing — never at start-up.
 *
 * Without real encryption (Linux's `basic_text`, #1012) nothing is written:
 * `isAvailable()` is false and a pairing does not start.
 */

const nodeCrypto = require('node:crypto');
const protocol = require('./pairing-protocol');
const { isRecord } = require('../../shared/runtime/is-record');

/** @typedef {import('node:crypto').JsonWebKey} JsonWebKey */
/** @typedef {import('../../application/ports/remote-identity-port').RemotePairedPhone} RemotePairedPhone */

const FILE_NAME = 'remote-pairing.json';
const FILE_VERSION = 1;

const EMPTY = Object.freeze({ identity: null, phone: null });
/**
 * Where `safeStorage`'s key is on disk from the start: everywhere but a fresh Windows profile (#1060).
 * @type {{ whenDurable: () => Promise<unknown> }}
 */
const KEY_ALWAYS_DURABLE = Object.freeze({ whenDurable: () => Promise.resolve() });

/**
 * A private key kept as an object, with the public point it belongs to.
 * @typedef {{ privateKey: import('node:crypto').KeyObject, point: Buffer }} KeyPair
 *
 * @typedef {{ identity: { sign: KeyPair, agree: KeyPair } | null, phone: RemotePairedPhone | null }} StoredIdentity
 */

/** @param {JsonWebKey} jwk */
function pointOf(jwk) {
  const x = protocol.fromB64u(jwk?.x, 32);
  const y = protocol.fromB64u(jwk?.y, 32);
  return x && y ? Buffer.concat([Buffer.from([0x04]), x, y]) : null;
}

function newKey() {
  const { privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const point = pointOf(privateKey.export({ format: 'jwk' }));
  if (!point) throw new Error('remote pairing: the public point of a new key could not be read');
  return { privateKey, point };
}

/**
 * A stored private key, back as a KeyObject; null when it is not one.
 * @param {JsonWebKey | null | undefined} jwk
 * @returns {KeyPair | null}
 */
function keyOf(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') return null;
  try {
    const privateKey = nodeCrypto.createPrivateKey({ format: 'jwk', key: jwk });
    const point = pointOf(privateKey.export({ format: 'jwk' }));
    return point ? { privateKey, point } : null;
  } catch {
    // A damaged key is no key; the caller treats the file as empty.
    return null;
  }
}

/**
 * @param {unknown} raw
 * @returns {RemotePairedPhone | null}
 */
function phoneOf(raw) {
  if (!isRecord(raw)) return null;
  if (typeof raw.channelId !== 'string' || !protocol.fromB64u(raw.channelId, protocol.CHANNEL_ID_BYTES)
    || !protocol.isKeyBundle(raw.keys)) return null;
  if (typeof raw.pairedAt !== 'number' || !Number.isFinite(raw.pairedAt)) return null;
  return { channelId: raw.channelId, keys: { sign: raw.keys.sign, agree: raw.keys.agree }, pairedAt: raw.pairedAt };
}

/**
 * What the core gets: the public points, and a signer whose key stays in here.
 * @param {{ sign: KeyPair, agree: KeyPair }} identity
 */
function identityHandle(identity) {
  const signKey = identity.sign.privateKey;
  return Object.freeze({
    keys: Object.freeze({ sign: protocol.toB64u(identity.sign.point), agree: protocol.toB64u(identity.agree.point) }),
    /** @param {Uint8Array} message */
    sign: (message) => nodeCrypto.sign('sha256', Buffer.from(message), { key: signKey, dsaEncoding: 'ieee-p1363' }),
  });
}

/**
 * @param {{
 *   safeStorage: { isEncryptionAvailable: () => boolean, encryptString: (text: string) => Buffer,
 *     decryptString: (data: Buffer) => string } | null,
 *   safeStorageKey?: { whenDurable: () => Promise<unknown> },
 *   fs: typeof import('fs/promises'),
 *   path: typeof import('path'),
 *   dir: string,
 *   writeFileAtomic: (fs: any, file: string, data: string, options?: { mode?: number }) => Promise<void>,
 *   log?: { warn: (...args: unknown[]) => void },
 * }} deps  `dir` is the user data folder; `writeFileAtomic` is services/atomic-write.js's (#1013)
 * @returns {import('../../application/ports/remote-identity-port').RemoteIdentityPort}
 */
function createRemoteIdentityStore({
  safeStorage,
  safeStorageKey = KEY_ALWAYS_DURABLE,
  fs,
  path,
  dir,
  writeFileAtomic,
  log = console,
}) {
  const file = path.join(dir, FILE_NAME);
  /** @type {StoredIdentity | null} */
  let cache = null;
  /** @type {Promise<StoredIdentity> | null} */
  let reading = null;
  // One change at a time: two pairings must not each create an identity.
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  function isAvailable() {
    try {
      return !!safeStorage && safeStorage.isEncryptionAvailable() === true;
    } catch {
      // A store that cannot say whether it encrypts does not.
      return false;
    }
  }

  /** @param {StoredIdentity} next */
  function serialized(next) {
    return JSON.stringify({
      identity: next.identity
        ? { sign: next.identity.sign.privateKey.export({ format: 'jwk' }), agree: next.identity.agree.privateKey.export({ format: 'jwk' }) }
        : null,
      phone: next.phone,
    });
  }

  async function load() {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') log.warn(`[remote] ${FILE_NAME} could not be read (${error?.code || 'error'}); no phone is paired.`);
      return EMPTY;
    }
    try {
      const outer = JSON.parse(text);
      if (outer?.version !== FILE_VERSION || typeof outer.data !== 'string') throw new TypeError('format');
      if (!safeStorage || !isAvailable()) throw new TypeError('encryption unavailable');
      const inner = JSON.parse(safeStorage.decryptString(Buffer.from(outer.data, 'base64')));
      const sign = keyOf(inner?.identity?.sign);
      const agree = keyOf(inner?.identity?.agree);
      const identity = sign && agree ? { sign, agree } : null;
      return { identity, phone: identity ? phoneOf(inner.phone) : null };
    } catch (error) {
      // Not the content, which is the secret, only that it failed and how.
      log.warn(`[remote] ${FILE_NAME} could not be opened (${error?.name || 'error'}); a new pairing starts afresh.`);
      return EMPTY;
    }
  }

  async function read() {
    if (cache) return cache;
    reading ??= load().then((data) => {
      cache = data;
      return data;
    });
    return reading;
  }

  /** @param {StoredIdentity} next */
  async function write(next) {
    if (!safeStorage || !isAvailable()) throw new Error('remote pairing: encryption is not available');
    // Ciphertext reaches the disk only once its key does (#1060).
    await safeStorageKey.whenDurable();
    const data = safeStorage.encryptString(serialized(next)).toString('base64');
    await fs.mkdir(dir, { recursive: true });
    await writeFileAtomic(fs, file, `${JSON.stringify({ version: FILE_VERSION, data })}\n`, { mode: 0o600 });
    cache = next;
  }

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function serially(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {
      // The caller gets the failure through `run`; the queue only keeps the order.
    });
    return run;
  }

  return {
    isAvailable,
    loadIdentity: () => serially(async () => {
      const data = await read();
      if (data.identity) return identityHandle(data.identity);
      const identity = { sign: newKey(), agree: newKey() };
      await write({ identity, phone: null });
      return identityHandle(identity);
    }),
    readPhone: async () => {
      const { phone } = await read();
      return phone ? { channelId: phone.channelId, keys: { ...phone.keys }, pairedAt: phone.pairedAt } : null;
    },
    savePhone: (phone) => serially(async () => {
      const data = await read();
      const next = phoneOf(phone);
      if (!data.identity || !next) throw new Error('remote pairing: no identity, or not a phone');
      await write({ identity: data.identity, phone: next });
    }),
    forgetPhone: () => serially(async () => {
      const data = await read();
      if (data.phone) await write({ identity: data.identity, phone: null });
    }),
  };
}

module.exports = { createRemoteIdentityStore, FILE_NAME };
