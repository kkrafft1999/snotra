'use strict';

// The Firebase adapter's half of the channel (#1192) against a fake `fetch`:
// the token of §5.9 and its renewal — before it runs out and on
// `auth_revoked` — the four nodes of §12 followed by server-sent events, and
// the desktop's writes, silent and under the current token.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

const { createFirebaseRelayAdapter, envelopesOf, phoneHandshakeOf, TOKEN_RENEW_MARGIN_MS } = require('../src/main/remote/firebase-relay-adapter');
const protocol = require('../src/main/remote/pairing-protocol');

const ENDPOINT = Object.freeze({
  relayHost: 'relay.test',
  databaseUrl: 'https://db.test',
  apiKey: 'web-api-key',
  identityToolkitUrl: 'https://idt.test/v1',
});
const CHANNEL_ID = protocol.toB64u(Buffer.alloc(16, 7));
const SID = '0123456789abcdef';
const NODES = ['meta', 'to-desktop', 'handshake/phone', 'presence/phone'];

function desktopIdentity() {
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    point: protocol.toB64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])),
    sign: (message) => nodeCrypto.sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' }),
  };
}

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The relay's endpoints and the database behind `fetch`; each stream is one the test writes events into. */
function fakeDatabase({ identity, tokenStatus = 200 }) {
  const encoder = new TextEncoder();
  const requests = [];
  const streams = [];
  const challenges = new Set();
  let issued = 0;
  const writeStatus = { next: [] };
  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const method = init.method || 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, host: parsed.host, path: parsed.pathname, query: parsed.searchParams, body });
    const key = `${method} ${parsed.host}${parsed.pathname}`;
    if (key === 'POST relay.test/v1/challenges') {
      const challenge = protocol.toB64u(nodeCrypto.randomBytes(32));
      challenges.add(challenge);
      return json(200, { challenge, expiresAt: 1 });
    }
    if (key === 'POST relay.test/v1/tokens') {
      assert.ok(challenges.delete(body.challenge), 'a challenge of the relay, used once');
      assert.deepEqual([body.channelId, body.role], [CHANNEL_ID, 'desktop']);
      const message = protocol.tokenMessage(protocol.fromB64u(body.challenge), CHANNEL_ID, 'desktop');
      assert.ok(protocol.verifySignature(identity.point, message, Buffer.from(body.proof, 'base64url')), 'the token proof verifies');
      if (tokenStatus !== 200) return json(tokenStatus, { error: { reason: 'refused' } });
      issued += 1;
      return json(200, { token: `custom-${issued}` });
    }
    if (key === 'POST idt.test/v1/accounts:signInWithCustomToken') {
      return json(200, { idToken: body.token.replace('custom', 'id'), refreshToken: 'refresh', expiresIn: '3600' });
    }
    if (parsed.host === 'db.test') {
      const node = parsed.pathname.replace(`/channels/${CHANNEL_ID}/`, '').replace(/\.json$/, '');
      if (method === 'GET') {
        let controller;
        const entry = {
          node,
          auth: parsed.searchParams.get('auth'),
          open: true,
          send: (type, data) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
        };
        // The reader cancels the body when it stops reading — after `auth_revoked`, say.
        const stream = new ReadableStream({ start: (c) => { controller = c; }, cancel: () => { entry.open = false; } });
        init.signal?.addEventListener('abort', () => {
          entry.open = false;
          controller.error(new DOMException('aborted', 'AbortError'));
        });
        streams.push(entry);
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(null, { status: writeStatus.next.shift() ?? 204 });
    }
    return json(404);
  }
  return {
    fetchImpl,
    requests,
    streams,
    writeStatus,
    issued: () => issued,
    open: (node) => streams.filter((s) => s.node === node && s.open),
    writes: () => requests.filter((r) => r.host === 'db.test' && r.method !== 'GET'),
  };
}

/** A manual timer queue: only what the test fires runs. */
function timers() {
  const queue = [];
  return {
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      queue.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const at = queue.indexOf(timer);
      if (at >= 0) queue.splice(at, 1);
    },
    queue,
  };
}

async function until(predicate, what) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function setup(t, options = {}) {
  const identity = desktopIdentity();
  const db = fakeDatabase({ identity, ...options });
  const clock = timers();
  const adapter = createFirebaseRelayAdapter({ endpoint: ENDPOINT, fetchImpl: db.fetchImpl, wait: async () => {}, ...clock });
  t.after(() => adapter.close());
  const seen = { live: 0, meta: [], handshakes: [], presence: [], envelopes: [], errors: [] };
  const link = adapter.openChannel(CHANNEL_ID, {
    sign: identity.sign,
    onLive: () => { seen.live += 1; },
    onMeta: (record) => seen.meta.push(record),
    onPhoneHandshake: (record) => seen.handshakes.push(record),
    onPhonePresence: (online) => seen.presence.push(online),
    onEnvelope: (envelope) => seen.envelopes.push(envelope),
    onError: (error) => seen.errors.push(error),
  });
  return { db, clock, link, seen, adapter };
}

/** Every stream answers its first `put`, as the database does on connect. */
async function standUp(ctx) {
  await until(() => NODES.every((node) => ctx.db.open(node).length === 1), 'four streams');
  for (const node of NODES) {
    const data = node === 'meta' ? { status: 'paired', phoneKeys: null, macP: null } : null;
    ctx.db.open(node)[0].send('put', { path: '/', data });
  }
  await until(() => ctx.seen.live === 1, 'onLive');
}

test('the channel follows the four nodes of §12 under its own token, never the channel', async (t) => {
  const ctx = setup(t);
  await standUp(ctx);
  assert.equal(ctx.db.issued(), 1);
  for (const stream of ctx.db.streams) assert.equal(stream.auth, 'id-1');
  assert.deepEqual(ctx.db.streams.map((s) => s.node).sort(), [...NODES].sort());
  assert.deepEqual(ctx.seen.meta, [{ status: 'paired', phoneKeys: null, macP: null }]);
  assert.deepEqual(ctx.seen.handshakes, [null]);
  assert.deepEqual(ctx.seen.presence, [false]);
});

test('envelopes, handshake 1 and the phone\'s presence reach the core once each', async (t) => {
  const ctx = setup(t);
  await standUp(ctx);
  const inbox = ctx.db.open('to-desktop')[0];
  inbox.send('put', { path: '/', data: { [SID]: { '0000000000000000': { c: 'AAAA', at: 1 } } } });
  inbox.send('patch', { path: `/${SID}`, data: { '0000000000000001': { c: 'BBBB', at: 2 } } });
  await until(() => ctx.seen.envelopes.length === 2, 'two envelopes');
  assert.deepEqual(ctx.seen.envelopes, [{ sid: SID, counter: 0, c: 'AAAA' }, { sid: SID, counter: 1, c: 'BBBB' }]);
  // Deleted, then the same path again: a new record.
  inbox.send('put', { path: `/${SID}/0000000000000000`, data: null });
  inbox.send('put', { path: `/${SID}/0000000000000000`, data: { c: 'CCCC', at: 3 } });
  await until(() => ctx.seen.envelopes.length === 3, 'the new record');
  assert.equal(ctx.seen.envelopes[2].c, 'CCCC');

  const handshake = ctx.db.open('handshake/phone')[0];
  handshake.send('put', { path: '/', data: { v: [1], e: 'eeee' } });
  handshake.send('put', { path: '/', data: { v: [1], e: 'eeee' } });
  handshake.send('put', { path: '/', data: { v: 'one', e: 'ffff' } });
  await until(() => ctx.seen.handshakes.length === 3, 'handshakes');
  assert.deepEqual(ctx.seen.handshakes, [null, { v: [1], e: 'eeee' }, null], 'the same record once; a malformed one as none');

  ctx.db.open('presence/phone')[0].send('put', { path: '/', data: { online: true, since: 5 } });
  await until(() => ctx.seen.presence.length === 2, 'presence');
  assert.deepEqual(ctx.seen.presence, [false, true]);
});

test('the desktop\'s writes are silent and carry the current token', async (t) => {
  const ctx = setup(t);
  await standUp(ctx);
  await ctx.link.writeHandshake({ v: 1, e: 'dddd' });
  await ctx.link.writeEnvelope(SID, 1, 'SEALED');
  await ctx.link.deleteEnvelope(SID, 0);
  await ctx.link.writePresence();
  await ctx.link.deletePresence();
  const writes = ctx.db.writes().map((w) => [w.method, w.path, w.query.get('print'), w.query.get('auth'), w.body]);
  const base = `/channels/${CHANNEL_ID}`;
  assert.deepEqual(writes, [
    ['PUT', `${base}/handshake/desktop.json`, 'silent', 'id-1', { v: 1, e: 'dddd' }],
    ['PUT', `${base}/to-phone/${SID}/0000000000000001.json`, 'silent', 'id-1', { c: 'SEALED', at: { '.sv': 'timestamp' } }],
    ['DELETE', `${base}/to-desktop/${SID}/0000000000000000.json`, 'silent', 'id-1', undefined],
    ['PUT', `${base}/presence/desktop.json`, 'silent', 'id-1', { lastSeen: { '.sv': 'timestamp' } }],
    ['DELETE', `${base}/presence/desktop.json`, 'silent', 'id-1', undefined],
  ]);
  await assert.rejects(ctx.link.writeEnvelope('not-a-sid', 0, 'x'), { reason: 'invalid-request' });
});

test('the token is renewed five minutes before it runs out', async (t) => {
  const ctx = setup(t);
  await standUp(ctx);
  assert.equal(ctx.clock.queue.length, 1);
  assert.equal(ctx.clock.queue[0].ms, 3_600_000 - TOKEN_RENEW_MARGIN_MS);
  ctx.clock.queue.shift().fn();
  await until(() => ctx.db.issued() === 2, 'a second token');
  await ctx.link.writePresence();
  assert.equal(ctx.db.writes().at(-1).query.get('auth'), 'id-2');
});

test('auth_revoked renews the token and the stream resumes under it', async (t) => {
  const ctx = setup(t);
  await standUp(ctx);
  ctx.db.open('handshake/phone')[0].send('auth_revoked', 'credential is no longer valid');
  await until(() => ctx.db.open('handshake/phone').length === 1 && ctx.db.open('handshake/phone')[0].auth === 'id-2', 'the stream back under a new token');
  assert.equal(ctx.db.issued(), 2);
  assert.equal(ctx.seen.errors.length, 0);
  // The others notice when their turn comes, and take the token already renewed.
  ctx.db.open('meta')[0].send('auth_revoked', 'credential is no longer valid');
  await until(() => ctx.db.open('meta').length === 1 && ctx.db.open('meta')[0].auth === 'id-2', 'meta back');
  assert.equal(ctx.db.issued(), 2, 'no second renewal for the same token');
});

test('a write refused for its token is tried once more under a fresh one', async (t) => {
  const ctx = setup(t);
  await standUp(ctx);
  ctx.db.writeStatus.next.push(401);
  await ctx.link.writePresence();
  const [first, second] = ctx.db.writes();
  assert.equal(first.query.get('auth'), 'id-1');
  assert.equal(second.query.get('auth'), 'id-2');
});

test('a meta that vanishes ends the link, whatever the other streams show', async (t) => {
  const ctx = setup(t);
  await standUp(ctx);
  ctx.db.open('meta')[0].send('put', { path: '/', data: null });
  await until(() => ctx.seen.meta.length === 2, 'meta gone');
  assert.equal(ctx.seen.meta[1], null);
  await until(() => ctx.db.streams.every((s) => !s.open), 'every stream closed');
  assert.equal(ctx.seen.errors.length, 0);
  await assert.rejects(ctx.link.writePresence(), { reason: 'unauthorized' });
  assert.equal(ctx.clock.queue.length, 0, 'no renewal is left behind');
});

test('a token the relay refuses ends the link with its reason', async (t) => {
  const ctx = setup(t, { tokenStatus: 403 });
  await until(() => ctx.seen.errors.length === 1, 'onError');
  assert.equal(ctx.seen.errors[0].reason, 'refused');
  assert.ok(!String(ctx.seen.errors[0].message).includes('custom'), 'no token in the error');
});

test('the shapes the adapter accepts', () => {
  assert.deepEqual(phoneHandshakeOf({ v: [1, 2], e: 'x' }), { v: [1, 2], e: 'x' });
  assert.equal(phoneHandshakeOf({ v: [], e: 'x' }), null);
  assert.equal(phoneHandshakeOf({ v: [0], e: 'x' }), null);
  assert.equal(phoneHandshakeOf({ v: [1], e: 'x'.repeat(65) }), null);
  assert.deepEqual(envelopesOf({ [SID]: { '0000000000000002': { c: 'b' }, '0000000000000001': { c: 'a' }, zz: { c: 'x' } }, nothex: {} }),
    [{ sid: SID, counter: 1, c: 'a' }, { sid: SID, counter: 2, c: 'b' }]);
});
