'use strict';

/**
 * A relay in memory (#1114): the relay's rules of docs/remote-protocol.md §5
 * without a network. Challenges are good once and for 60 seconds, a pairing
 * lives five minutes and takes one claim, every proof must verify against
 * the key it claims, a channel runs `open → pending → paired` and vanishes
 * when it is cancelled or deleted.
 *
 * The desktop's side is the RemoteRelay port, exactly as the Firebase adapter
 * offers it. `phone` is the other side — what the iPhone app does through the
 * real relay — for the tests and, later, the reference client of phase 3
 * (#1081). `inspect` lets a test look at what is left on the relay.
 *
 * Like the real relay it never sees the pairing secret, and it cannot check
 * `MAC_P`: it stores what the phone sent.
 */

const nodeCrypto = require('node:crypto');
const protocol = require('./pairing-protocol');
const { RELAY_REASONS, RemoteRelayError } = require('./relay-error');

const CHALLENGE_TTL_MS = 60_000;
const PAIRING_TTL_MS = 5 * 60_000;

/**
 * @typedef {Object} InMemoryRelayPhone  the phone's side of the relay
 * @property {(pairingId: string) => Promise<{ channelId: string,
 *   desktopKeys: import('../../application/ports/remote-relay-port').RemoteKeyBundle, expiresAt: number }>} lookup  §5.4
 * @property {(pairingId: string, input: {
 *   phoneKeys: import('../../application/ports/remote-relay-port').RemoteKeyBundle,
 *   macP: string,
 *   sign: import('../../application/ports/remote-relay-port').RemoteSigner,
 * }) => Promise<{ channelId: string }>} claim  §5.5
 * @property {(channelId: string) => ({ status: string, macD: string|null } | null)} read  what the phone may read (§5.10)
 * @property {(channelId: string) => Promise<void>} deleteChannel  *Disconnect* on the phone (§5.8)
 */

/**
 * @typedef {Object} InMemoryRelayInspection
 * @property {() => string[]} channelIds
 * @property {() => string[]} pairingIds
 * @property {(channelId: string) => (object | null)} record  a copy of the whole channel record
 * @property {() => string[]} calls  every desktop call that reached the relay, in order
 * @property {(reachable: boolean) => void} setReachable  `false`: every call fails with `network`
 * @property {() => void} sweep  the relay's scheduled clean-up
 * @property {() => number} watchers  streams still followed
 */

/**
 * @param {{
 *   relayHost?: string,
 *   now?: () => number,
 *   randomBytes?: (size: number) => Uint8Array,
 * }} [deps]
 * @returns {import('../../application/ports/remote-relay-port').RemoteRelayPort
 *   & { phone: InMemoryRelayPhone, inspect: InMemoryRelayInspection }}
 */
function createInMemoryRelayAdapter({
  relayHost = 'relay.test',
  now = () => Date.now(),
  randomBytes = nodeCrypto.randomBytes,
} = {}) {
  /** challenge (base64url) → expiresAt */
  const challenges = new Map();
  /** pairingId → { channelId, expiresAt, claimed } */
  const pairings = new Map();
  /** channelId → { desktopKeys, phoneKeys, macP, macD, status, createdAt } */
  const channels = new Map();
  /** channels the desktop holds a token for */
  const desktopTokens = new Set();
  /** channelId → Set of watch handlers */
  const watchers = new Map();
  const calls = [];
  let reachable = true;

  function reach(name) {
    calls.push(name);
    if (!reachable) throw new RemoteRelayError(RELAY_REASONS.NETWORK);
    sweep();
  }

  function fail(reason) {
    throw new RemoteRelayError(reason);
  }

  /** §5.2 — opaque to the clients, good once. */
  function issueChallenge() {
    const challenge = protocol.toB64u(randomBytes(32));
    challenges.set(challenge, now() + CHALLENGE_TTL_MS);
    return challenge;
  }

  function takeChallenge(challenge) {
    const expiresAt = challenges.get(challenge);
    challenges.delete(challenge);
    if (expiresAt === undefined || now() > expiresAt) fail(RELAY_REASONS.REFUSED);
    return protocol.fromB64u(challenge);
  }

  function prove(point, message, sign) {
    const signature = Buffer.from(sign(message));
    if (!protocol.verifySignature(point, message, signature)) fail(RELAY_REASONS.REFUSED);
  }

  /** What the desktop reads of the channel (§5.10), or null when it is gone. */
  function desktopView(channelId) {
    const channel = channels.get(channelId);
    if (!channel) return null;
    return { status: channel.status, phoneKeys: channel.phoneKeys ? { ...channel.phoneKeys } : null, macP: channel.macP };
  }

  /** Streams deliver later, never inside the call that changed the record — as over the network. */
  function notify(channelId) {
    const handlers = watchers.get(channelId);
    if (!handlers) return;
    const record = desktopView(channelId);
    for (const handler of handlers) queueMicrotask(() => handler.onRecord(record));
  }

  function dropChannel(channelId) {
    if (!channels.delete(channelId)) return;
    for (const [pairingId, pairing] of pairings) if (pairing.channelId === channelId) pairings.delete(pairingId);
    desktopTokens.delete(channelId);
    notify(channelId);
  }

  /** The scheduled clean-up: expired pairings go, and their channel unless it is paired. */
  function sweep() {
    for (const [pairingId, pairing] of pairings) {
      if (now() <= pairing.expiresAt) continue;
      pairings.delete(pairingId);
      if (channels.get(pairing.channelId)?.status !== 'paired') dropChannel(pairing.channelId);
    }
  }

  function newPairingId() {
    for (;;) {
      const value = Buffer.from(randomBytes(3)).readUIntBE(0, 3) & 0xfffff;
      let id = '';
      for (let i = 3; i >= 0; i -= 1) id += protocol.ALPHABET[(value >> (i * 5)) & 31];
      if (!pairings.has(id)) return id;
    }
  }

  function requireDesktop(channelId) {
    if (!desktopTokens.has(channelId)) fail(RELAY_REASONS.UNAUTHORIZED);
  }

  async function openPairing({ desktopKeys, sign }) {
    reach('openPairing');
    const challenge = takeChallenge(issueChallenge());
    if (!protocol.isKeyBundle(desktopKeys)) fail(RELAY_REASONS.INVALID_REQUEST);
    prove(desktopKeys.sign, protocol.openMessage(challenge, desktopKeys), sign);
    const channelId = protocol.toB64u(randomBytes(protocol.CHANNEL_ID_BYTES));
    const pairingId = newPairingId();
    const expiresAt = now() + PAIRING_TTL_MS;
    channels.set(channelId, {
      desktopKeys: { sign: desktopKeys.sign, agree: desktopKeys.agree },
      phoneKeys: null,
      macP: null,
      macD: null,
      status: 'open',
      createdAt: now(),
    });
    pairings.set(pairingId, { channelId, expiresAt, claimed: false });
    desktopTokens.add(channelId);
    return { channelId, pairingId, expiresAt, relayHost };
  }

  function watchChannel(channelId, handlers) {
    let closed = false;
    const entry = {
      onRecord: (record) => { if (!closed) handlers.onRecord(record); },
      onError: (error) => { if (!closed) handlers.onError(error); },
    };
    const close = () => {
      closed = true;
      watchers.get(channelId)?.delete(entry);
    };
    try {
      reach('watchChannel');
      requireDesktop(channelId);
    } catch (error) {
      queueMicrotask(() => entry.onError(error));
      return { close };
    }
    if (!watchers.has(channelId)) watchers.set(channelId, new Set());
    watchers.get(channelId).add(entry);
    const record = desktopView(channelId);
    queueMicrotask(() => entry.onRecord(record));
    return { close };
  }

  async function confirmPairing(channelId, macD) {
    reach('confirmPairing');
    requireDesktop(channelId);
    const channel = channels.get(channelId);
    if (!channel) fail(RELAY_REASONS.NOT_FOUND);
    if (channel.status !== 'pending') fail(RELAY_REASONS.BUSY);
    if (!protocol.fromB64u(macD, protocol.MAC_BYTES)) fail(RELAY_REASONS.INVALID_REQUEST);
    channel.macD = macD;
    channel.status = 'paired';
    for (const [pairingId, pairing] of pairings) if (pairing.channelId === channelId) pairings.delete(pairingId);
    notify(channelId);
  }

  async function cancelPairing(channelId, pairingId) {
    reach('cancelPairing');
    requireDesktop(channelId);
    const pairing = pairings.get(pairingId);
    if (pairing && pairing.channelId === channelId) pairings.delete(pairingId);
    if (channels.get(channelId)?.status !== 'paired') dropChannel(channelId);
    desktopTokens.delete(channelId);
  }

  async function deleteChannel(channelId, { sign }) {
    reach('deleteChannel');
    const channel = channels.get(channelId);
    if (!desktopTokens.has(channelId)) {
      // §5.9: a token for a channel opened in an earlier start, against the stored key.
      if (!channel) fail(RELAY_REASONS.NOT_FOUND);
      const challenge = takeChallenge(issueChallenge());
      prove(channel.desktopKeys.sign, protocol.tokenMessage(challenge, channelId, protocol.ROLES.DESKTOP), sign);
    }
    if (!channel) fail(RELAY_REASONS.NOT_FOUND);
    dropChannel(channelId);
  }

  /** The desktop's streams and tokens end with it, as the Firebase adapter's do; the relay's records stay. */
  function close() {
    watchers.clear();
    desktopTokens.clear();
  }

  /** @type {InMemoryRelayPhone} */
  const phone = {
    async lookup(pairingId) {
      if (!reachable) fail(RELAY_REASONS.NETWORK);
      sweep();
      const pairing = pairings.get(pairingId);
      if (!pairing || pairing.claimed) fail(RELAY_REASONS.NOT_FOUND);
      const channel = channels.get(pairing.channelId);
      return { channelId: pairing.channelId, desktopKeys: { ...channel.desktopKeys }, expiresAt: pairing.expiresAt };
    },
    async claim(pairingId, { phoneKeys, macP, sign }) {
      if (!reachable) fail(RELAY_REASONS.NETWORK);
      sweep();
      const challenge = takeChallenge(issueChallenge());
      const pairing = pairings.get(pairingId);
      if (!pairing || pairing.claimed) fail(RELAY_REASONS.NOT_FOUND);
      if (!protocol.isKeyBundle(phoneKeys) || !protocol.fromB64u(macP, protocol.MAC_BYTES)) fail(RELAY_REASONS.INVALID_REQUEST);
      prove(phoneKeys.sign, protocol.claimMessage(challenge, pairing.channelId, phoneKeys), sign);
      const channel = channels.get(pairing.channelId);
      if (!channel || channel.status !== 'open') fail(RELAY_REASONS.NOT_FOUND);
      channel.phoneKeys = { sign: phoneKeys.sign, agree: phoneKeys.agree };
      channel.macP = macP;
      channel.status = 'pending';
      pairing.claimed = true;
      notify(pairing.channelId);
      return { channelId: pairing.channelId };
    },
    read(channelId) {
      const channel = channels.get(channelId);
      return channel ? { status: channel.status, macD: channel.macD } : null;
    },
    async deleteChannel(channelId) {
      if (!reachable) fail(RELAY_REASONS.NETWORK);
      if (!channels.has(channelId)) fail(RELAY_REASONS.NOT_FOUND);
      dropChannel(channelId);
    },
  };

  /** @type {InMemoryRelayInspection} */
  const inspect = {
    channelIds: () => [...channels.keys()],
    pairingIds: () => [...pairings.keys()],
    record: (channelId) => (channels.has(channelId) ? structuredClone(channels.get(channelId)) : null),
    calls: () => [...calls],
    setReachable: (value) => { reachable = value === true; },
    sweep,
    watchers: () => [...watchers.values()].reduce((sum, set) => sum + set.size, 0),
  };

  return { openPairing, watchChannel, confirmPairing, cancelPairing, deleteChannel, close, phone, inspect };
}

module.exports = { createInMemoryRelayAdapter, PAIRING_TTL_MS };
