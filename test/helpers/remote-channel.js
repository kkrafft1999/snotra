'use strict';

// The channel of the mobile remote (#1192) put together for tests: a phone
// paired through the real pairing (test/helpers/remote-pairing.js), the
// channel core on the same in-memory relay and identity store, and the
// phone's half of part 2 — computed with the reference implementation in
// scripts/remote-protocol-channel-vectors.js, not with the bridge's own code.

const nodeCrypto = require('node:crypto');

const ref = require('../../scripts/remote-protocol-channel-vectors');
const { createRemoteChannel } = require('../../src/application/remote/remote-channel');
const { createRemoteMessageStandIn } = require('../../src/application/remote/remote-message-stand-in');
const { createRemoteChannelCryptoAdapter } = require('../../src/main/remote/channel-protocol');
const { translateMessage } = require('../../src/shared/i18n');
const { createPairingFixture, createPhone } = require('./remote-pairing');

const bytes = (text) => Buffer.from(text, 'base64url');
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A pairing fixture with one phone paired. */
async function pairedFixture(t, options = {}) {
  const fixture = createPairingFixture(t, options);
  const phone = createPhone();
  await fixture.pairing.start();
  const shown = await fixture.stateIs('code');
  const channelId = await phone.claim(fixture.relay, shown.code.display);
  await fixture.until(() => fixture.dialog.open().length > 0, 'the native sheet');
  fixture.dialog.open()[0].allow();
  await fixture.stateIs('paired');
  const desktopKeys = (await fixture.identity.loadIdentity()).keys;
  return { fixture, phone, channelId, desktopKeys };
}

/**
 * The channel core on a paired fixture.
 * @param {object} paired  from pairedFixture
 * @param {object} [options]
 * @param {object} [options.messages]  replaces the stand-in
 */
function createChannelFixture(t, paired, { messages = null } = {}) {
  const { fixture } = paired;
  let ids = 0;
  const gone = [];
  const states = [];
  const channel = createRemoteChannel({
    relay: fixture.relay,
    identity: fixture.identity,
    crypto: createRemoteChannelCryptoAdapter(),
    messages: messages || createRemoteMessageStandIn({ word: translateMessage }),
    word: translateMessage,
    appVersion: () => '9.9.9',
    newConnectionId: () => `conn-${(ids += 1)}`,
    onGone: (channelId) => gone.push(channelId),
    now: fixture.clock.now,
    setTimer: fixture.clock.setTimer,
    clearTimer: fixture.clock.clearTimer,
    log: fixture.log,
  });
  channel.subscribe((state) => states.push(state));
  t.after(() => channel.dispose());
  return { channel, gone, states };
}

/**
 * The phone's half of part 2, through the in-memory relay's phone side.
 * @param {object} relay  the in-memory relay
 * @param {object} phone  from createPhone, already paired
 * @param {string} channelId
 * @param {{ sign: string, agree: string }} desktopKeys
 */
function createChannelPhone(relay, phone, channelId, desktopKeys) {
  const points = { sign: bytes(desktopKeys.sign), agree: bytes(desktopKeys.agree) };
  let keys = null;
  let out = 0;
  return {
    get sid() {
      return keys ? keys.sid.toString('hex') : null;
    },
    get keys() {
      return keys;
    },
    /** Handshake 1, then waits for the desktop's handshake 2 and derives the keys (§13, §14). */
    async handshake({ offered = [1], until } = {}) {
      const ephemeral = nodeCrypto.randomBytes(32);
      const e = ref.x25519Public(ephemeral);
      const before = JSON.stringify(relay.phone.readHandshake(channelId));
      await relay.phone.writeHandshake(channelId, { v: offered, e: e.toString('base64url') });
      const answer = await until(() => {
        const record = relay.phone.readHandshake(channelId);
        return record && JSON.stringify(record) !== before ? record : null;
      }, 'handshake 2');
      if (answer.error) return answer;
      const ss = phone.agree(desktopKeys.agree);
      const desktopE = bytes(answer.e);
      const ee = ref.x25519Shared(ephemeral, desktopE);
      const th = ref.transcriptHash({
        channelId: bytes(channelId), desktopKeys: points, phoneKeys: phone.points, offered, phoneEphemeral: e, chosen: answer.v, desktopEphemeral: desktopE,
      });
      keys = ref.sessionKeys(ss, ee, th);
      out = 0;
      return answer;
    },
    /** One message into `to-desktop`; `counter` and `sealed` bend the rules for §16. */
    async send(message, { counter = out, sealed = null, sid = null } = {}) {
      const text = typeof message === 'string' ? message : JSON.stringify(message);
      const c = sealed ?? ref.seal(keys.toDesktop, keys.sid, ref.DIRECTION.toDesktop, counter, text).toString('base64url');
      if (counter >= out) out = counter + 1;
      await relay.phone.sendEnvelope(channelId, sid ?? keys.sid.toString('hex'), counter, c);
      return c;
    },
    /** Everything in `to-phone`, opened and parsed, in counter order. */
    receive() {
      return relay.phone.takeEnvelopes(channelId).map(({ sid, counter, c }) => {
        const plaintext = ref.open(keys.toPhone, Buffer.from(sid, 'hex'), ref.DIRECTION.toPhone, counter, bytes(c));
        return { sid, counter, message: plaintext === null ? null : JSON.parse(plaintext) };
      });
    },
  };
}

const HELLO = Object.freeze({
  jsonrpc: '2.0', id: 1, method: 'session.hello', params: { protocol: [1], client: { name: 'Snotra mobile', version: '1.0.0' }, capabilities: ['approvals'] },
});

module.exports = { HELLO, createChannelFixture, createChannelPhone, pairedFixture, tick };
