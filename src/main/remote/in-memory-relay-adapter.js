'use strict';

/**
 * A relay in memory (#1114): the relay's rules of docs/remote/remote-protocol.md §5
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
 *
 * Part 2 (#1192): a paired channel's handshake, presence and outbox nodes,
 * with the relay's rules — only while paired, each side in its own outbox,
 * never overwriting a record. `phone` writes handshake 1, its heartbeat,
 * sends and takes envelopes; `inspect.dropLinks` fails the desktop's streams
 * as a lost network would.
 */

const nodeCrypto = require('node:crypto');
const protocol = require('./pairing-protocol');
const { counterKey } = require('./channel-protocol');
const { RELAY_REASONS, RemoteRelayError } = require('./relay-error');

/**
 * @typedef {import('../../application/ports/remote-relay-port').RemoteKeyBundle} RemoteKeyBundle
 * @typedef {import('../../application/ports/remote-relay-port').RemoteSigner} RemoteSigner
 * @typedef {import('../../application/ports/remote-relay-port').RemoteChannelRecord} RemoteChannelRecord
 *
 * What the relay keeps of a channel.
 * @typedef {Object} ChannelRecord
 * @property {RemoteKeyBundle} desktopKeys
 * @property {RemoteKeyBundle|null} phoneKeys
 * @property {string|null} macP
 * @property {string|null} macD
 * @property {'open'|'pending'|'paired'} status
 * @property {number} createdAt
 *
 * @typedef {{ channelId: string, expiresAt: number, claimed: boolean }} PairingRecord
 *
 * @typedef {{ onRecord: (record: RemoteChannelRecord|null) => void, onError: (error: Error) => void }} WatchHandlers
 *
 * The nodes of part 2 (§12–§15) under a paired channel; envelopes by sid, then by 16-hex-digit counter.
 * @typedef {Object} ChannelNodes
 * @property {{ phone: import('../../application/ports/remote-relay-port').RemotePhoneHandshake|null, desktop: object|null }} handshake
 * @property {{ phone: { lastSeen: number }|null, desktop: { lastSeen: number }|null }} presence
 * @property {Map<string, Map<string, string>>} toDesktop
 * @property {Map<string, Map<string, string>>} toPhone
 *
 * @typedef {{ handlers: import('../../application/ports/remote-relay-port').RemoteChannelHandlers, closed: boolean }} LinkEntry
 */

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
 * @property {(channelId: string, record: import('../../application/ports/remote-relay-port').RemotePhoneHandshake) => Promise<void>} writeHandshake  handshake 1 (§13)
 * @property {(channelId: string) => (object | null)} readHandshake  handshake 2, as the desktop wrote it
 * @property {(channelId: string, online: boolean) => Promise<void>} setPresence  `presence/phone`: one heartbeat, `lastSeen` = now (§12.3), or the record deleted
 * @property {(channelId: string) => ({ lastSeen: number } | null)} readPresence  `presence/desktop`
 * @property {(channelId: string, sid: string, counter: number, c: string) => Promise<void>} sendEnvelope  into `to-desktop`
 * @property {(channelId: string) => { sid: string, counter: number, c: string }[]} takeEnvelopes  reads and deletes `to-phone`
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
 * @property {(channelId: string) => (object | null)} nodes  a copy of the channel's part-2 nodes
 * @property {() => number} links  channels the desktop follows
 * @property {(reason?: string) => void} dropLinks  every channel stream fails, as when the network goes
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
  /**
   * challenge (base64url) → expiresAt
   *
   * @type {Map<string, number>}
   */
  const challenges = new Map();
  /**
   * pairingId → { channelId, expiresAt, claimed }
   *
   * @type {Map<string, PairingRecord>}
   */
  const pairings = new Map();
  /**
   * channelId → { desktopKeys, phoneKeys, macP, macD, status, createdAt }
   *
   * @type {Map<string, ChannelRecord>}
   */
  const channels = new Map();
  /**
   * channels the desktop holds a token for
   *
   * @type {Set<string>}
   */
  const desktopTokens = new Set();
  /**
   * channelId → Set of watch handlers
   *
   * @type {Map<string, Set<WatchHandlers>>}
   */
  const watchers = new Map();
  /**
   * channelId → the nodes of part 2
   *
   * @type {Map<string, ChannelNodes>}
   */
  const nodes = new Map();
  /**
   * channelId → the desktop's channel links
   *
   * @type {Map<string, Set<LinkEntry>>}
   */
  const links = new Map();
  /** @type {string[]} */
  const calls = [];
  let reachable = true;

  /**
   * @param {string} name
   */
  function reach(name) {
    calls.push(name);
    if (!reachable) throw new RemoteRelayError(RELAY_REASONS.NETWORK);
    sweep();
  }

  /**
   * @param {string} reason
   * @returns {never}
   */
  function fail(reason) {
    throw new RemoteRelayError(reason);
  }

  /** §5.2 — opaque to the clients, good once. */
  function issueChallenge() {
    const challenge = protocol.toB64u(randomBytes(32));
    challenges.set(challenge, now() + CHALLENGE_TTL_MS);
    return challenge;
  }

  /**
   * @param {string} challenge
   */
  function takeChallenge(challenge) {
    const expiresAt = challenges.get(challenge);
    challenges.delete(challenge);
    if (expiresAt === undefined || now() > expiresAt) fail(RELAY_REASONS.REFUSED);
    return protocol.fromB64u(challenge);
  }

  /**
   * @param {string} point
   * @param {Uint8Array} message
   * @param {RemoteSigner} sign
   */
  function prove(point, message, sign) {
    const signature = Buffer.from(sign(message));
    if (!protocol.verifySignature(point, message, signature)) fail(RELAY_REASONS.REFUSED);
  }

  /**
   * What the desktop reads of the channel (§5.10), or null when it is gone.
   *
   * @param {string} channelId
   * @returns {RemoteChannelRecord|null}
   */
  function desktopView(channelId) {
    const channel = channels.get(channelId);
    if (!channel) return null;
    return { status: channel.status, phoneKeys: channel.phoneKeys ? { ...channel.phoneKeys } : null, macP: channel.macP };
  }

  /**
   * Streams deliver later, never inside the call that changed the record — as over the network.
   *
   * @param {string} channelId
   */
  function notify(channelId) {
    const handlers = watchers.get(channelId);
    if (!handlers) return;
    const record = desktopView(channelId);
    for (const handler of handlers) queueMicrotask(() => handler.onRecord(record));
  }

  /**
   * @param {string} channelId
   */
  function dropChannel(channelId) {
    if (!channels.delete(channelId)) return;
    for (const [pairingId, pairing] of pairings) if (pairing.channelId === channelId) pairings.delete(pairingId);
    desktopTokens.delete(channelId);
    nodes.delete(channelId);
    notify(channelId);
    toLinks(channelId, (entry) => entry.handlers.onMeta(null));
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

  /**
   * @param {string} channelId
   */
  function requireDesktop(channelId) {
    if (!desktopTokens.has(channelId)) fail(RELAY_REASONS.UNAUTHORIZED);
  }

  /** @param {{ desktopKeys: RemoteKeyBundle, sign: RemoteSigner }} input */
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

  /**
   * @param {string} channelId
   * @param {WatchHandlers} handlers
   */
  function watchChannel(channelId, handlers) {
    let closed = false;
    /** @type {WatchHandlers} */
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
    let handlersOfChannel = watchers.get(channelId);
    if (!handlersOfChannel) {
      handlersOfChannel = new Set();
      watchers.set(channelId, handlersOfChannel);
    }
    handlersOfChannel.add(entry);
    const record = desktopView(channelId);
    queueMicrotask(() => entry.onRecord(record));
    return { close };
  }

  /**
   * @param {string} channelId
   * @param {string} macD
   */
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

  /**
   * @param {string} channelId
   * @param {string} pairingId
   */
  async function cancelPairing(channelId, pairingId) {
    reach('cancelPairing');
    requireDesktop(channelId);
    const pairing = pairings.get(pairingId);
    if (pairing && pairing.channelId === channelId) pairings.delete(pairingId);
    if (channels.get(channelId)?.status !== 'paired') dropChannel(channelId);
    desktopTokens.delete(channelId);
  }

  /**
   * @param {string} channelId
   * @param {{ sign: RemoteSigner }} options
   */
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

  // ---------------------------------------------------------------- part 2: the channel (#1192)

  /**
   * @param {string} channelId
   * @returns {ChannelNodes}
   */
  function nodesOf(channelId) {
    let entry = nodes.get(channelId);
    if (!entry) {
      entry = { handshake: { phone: null, desktop: null }, presence: { phone: null, desktop: null }, toDesktop: new Map(), toPhone: new Map() };
      nodes.set(channelId, entry);
    }
    return entry;
  }

  /**
   * The relay's rules for part 2 (§13, §15): only while the channel is paired.
   * @param {string} channelId
   */
  function requirePaired(channelId) {
    if (!reachable) fail(RELAY_REASONS.NETWORK);
    const channel = channels.get(channelId);
    if (!channel) fail(RELAY_REASONS.NOT_FOUND);
    if (channel.status !== 'paired') fail(RELAY_REASONS.REFUSED);
    return nodesOf(channelId);
  }

  /**
   * Streams deliver later, as over the network.
   * @param {string} channelId
   * @param {(link: LinkEntry) => void} deliver
   */
  function toLinks(channelId, deliver) {
    for (const entry of links.get(channelId) || []) queueMicrotask(() => { if (!entry.closed) deliver(entry); });
  }

  /**
   * @param {Map<string, Map<string, string>>} outbox
   * @param {string} sid
   * @param {number} counter
   * @param {string} c
   */
  function create(outbox, sid, counter, c) {
    if (!/^[0-9a-f]{16}$/.test(sid) || !Number.isSafeInteger(counter) || counter < 0 || typeof c !== 'string') fail(RELAY_REASONS.INVALID_REQUEST);
    const key = counterKey(counter);
    let bySid = outbox.get(sid);
    if (!bySid) {
      bySid = new Map();
      outbox.set(sid, bySid);
    }
    // A side creates records in its outbox and never overwrites one (§15).
    if (bySid.has(key)) fail(RELAY_REASONS.REFUSED);
    bySid.set(key, c);
  }

  /**
   * @param {string} channelId
   * @param {import('../../application/ports/remote-relay-port').RemoteChannelHandlers} handlers
   * @returns {import('../../application/ports/remote-relay-port').RemoteChannelLink}
   */
  function openChannel(channelId, handlers) {
    /** @type {LinkEntry} */
    const entry = { handlers, closed: false };
    const close = () => {
      entry.closed = true;
      links.get(channelId)?.delete(entry);
    };
    /** @param {string} name */
    const guarded = (name) => {
      calls.push(name);
      if (entry.closed) fail(RELAY_REASONS.UNAUTHORIZED);
      return requirePaired(channelId);
    };
    /** @type {import('../../application/ports/remote-relay-port').RemoteChannelLink} */
    const link = {
      async writeHandshake(record) {
        guarded('writeHandshake').handshake.desktop = structuredClone(record);
      },
      async writeEnvelope(sid, counter, c) {
        const target = guarded('writeEnvelope');
        create(target.toPhone, sid, counter, c);
      },
      async deleteEnvelope(sid, counter) {
        const target = guarded('deleteEnvelope');
        const bySid = target.toDesktop.get(sid);
        bySid?.delete(counterKey(counter));
        if (bySid && bySid.size === 0) target.toDesktop.delete(sid);
      },
      async writePresence() {
        guarded('writePresence').presence.desktop = { lastSeen: now() };
      },
      async deletePresence() {
        guarded('deletePresence').presence.desktop = null;
      },
      close,
    };
    try {
      reach('openChannel');
      const channel = channels.get(channelId);
      if (!channel) fail(RELAY_REASONS.NOT_FOUND);
      // §5.9: the token, proven against the key the relay stored for the desktop.
      const challenge = takeChallenge(issueChallenge());
      prove(channel.desktopKeys.sign, protocol.tokenMessage(challenge, channelId, protocol.ROLES.DESKTOP), handlers.sign);
      if (channel.status !== 'paired') fail(RELAY_REASONS.REFUSED);
    } catch (error) {
      queueMicrotask(() => {
        if (entry.closed) return;
        entry.closed = true;
        handlers.onError(error);
      });
      return link;
    }
    let set = links.get(channelId);
    if (!set) {
      set = new Set();
      links.set(channelId, set);
    }
    set.add(entry);
    const target = nodesOf(channelId);
    queueMicrotask(() => {
      if (entry.closed) return;
      handlers.onMeta(desktopView(channelId));
      if (entry.closed) return;
      handlers.onPhoneHandshake(target.handshake.phone ? structuredClone(target.handshake.phone) : null);
      handlers.onPhonePresence(target.presence.phone?.lastSeen ?? null);
      for (const [sid, bySid] of target.toDesktop) {
        for (const [key, c] of bySid) if (!entry.closed) handlers.onEnvelope({ sid, counter: Number.parseInt(key, 16), c });
      }
      if (!entry.closed) handlers.onLive();
    });
    return link;
  }

  /** The desktop's streams and tokens end with it, as the Firebase adapter's do; the relay's records stay. */
  function close() {
    watchers.clear();
    desktopTokens.clear();
    for (const set of links.values()) for (const entry of set) entry.closed = true;
    links.clear();
  }

  /** @type {InMemoryRelayPhone} */
  const phone = {
    async lookup(pairingId) {
      if (!reachable) fail(RELAY_REASONS.NETWORK);
      sweep();
      const pairing = pairings.get(pairingId);
      if (!pairing || pairing.claimed) fail(RELAY_REASONS.NOT_FOUND);
      const channel = channels.get(pairing.channelId);
      if (!channel) fail(RELAY_REASONS.NOT_FOUND);
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
    async writeHandshake(channelId, record) {
      const target = requirePaired(channelId);
      target.handshake.phone = structuredClone(record);
      toLinks(channelId, (entry) => entry.handlers.onPhoneHandshake(structuredClone(record)));
    },
    readHandshake(channelId) {
      const record = nodes.get(channelId)?.handshake.desktop;
      return record ? structuredClone(record) : null;
    },
    async setPresence(channelId, online) {
      const target = requirePaired(channelId);
      const lastSeen = online ? now() : null;
      target.presence.phone = lastSeen === null ? null : { lastSeen };
      toLinks(channelId, (entry) => entry.handlers.onPhonePresence(lastSeen));
    },
    readPresence(channelId) {
      const record = nodes.get(channelId)?.presence.desktop;
      return record ? { ...record } : null;
    },
    async sendEnvelope(channelId, sid, counter, c) {
      const target = requirePaired(channelId);
      create(target.toDesktop, sid, counter, c);
      toLinks(channelId, (entry) => entry.handlers.onEnvelope({ sid, counter, c }));
    },
    takeEnvelopes(channelId) {
      const target = nodes.get(channelId);
      if (!target) return [];
      const out = [];
      for (const [sid, bySid] of target.toPhone) {
        for (const [key, c] of bySid) out.push({ sid, counter: Number.parseInt(key, 16), c });
      }
      target.toPhone.clear();
      return out.sort((a, b) => (a.sid === b.sid ? a.counter - b.counter : a.sid < b.sid ? -1 : 1));
    },
  };

  /** @type {InMemoryRelayInspection} */
  const inspect = {
    channelIds: () => [...channels.keys()],
    pairingIds: () => [...pairings.keys()],
    record: (channelId) => {
      const channel = channels.get(channelId);
      return channel ? structuredClone(channel) : null;
    },
    calls: () => [...calls],
    setReachable: (value) => { reachable = value === true; },
    sweep,
    watchers: () => [...watchers.values()].reduce((sum, set) => sum + set.size, 0),
    nodes: (channelId) => {
      const target = nodes.get(channelId);
      if (!target) return null;
      const plain = (/** @type {Map<string, Map<string, string>>} */ outbox) => Object.fromEntries([...outbox].map(([sid, bySid]) => [sid, Object.fromEntries(bySid)]));
      return structuredClone({ handshake: target.handshake, presence: target.presence, toDesktop: plain(target.toDesktop), toPhone: plain(target.toPhone) });
    },
    links: () => [...links.values()].reduce((sum, set) => sum + set.size, 0),
    dropLinks: (reason = RELAY_REASONS.NETWORK) => {
      for (const set of links.values()) {
        for (const entry of set) {
          entry.closed = true;
          const { handlers } = entry;
          queueMicrotask(() => handlers.onError(new RemoteRelayError(reason)));
        }
      }
      links.clear();
    },
  };

  return { openPairing, watchChannel, confirmPairing, cancelPairing, deleteChannel, openChannel, close, phone, inspect };
}

module.exports = { createInMemoryRelayAdapter, PAIRING_TTL_MS };
