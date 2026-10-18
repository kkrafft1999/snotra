'use strict';

// The Firebase relay adapter (#1114) against a fake `fetch`: what it sends,
// what it accepts, how it follows the channel by server-sent events, and that
// no token ever ends up in an error or a result.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

const { createFirebaseRelayAdapter, applyAt, STREAM_ATTEMPTS } = require('../src/main/remote/firebase-relay-adapter');
const { readEventStream } = require('../src/main/remote/event-stream');
const protocol = require('../src/main/remote/pairing-protocol');

const ENDPOINT = Object.freeze({
  relayHost: 'relay.test',
  databaseUrl: 'https://db.test',
  apiKey: 'web-api-key',
  identityToolkitUrl: 'https://idt.test/v1',
});
const CUSTOM_TOKEN = 'CUSTOM-TOKEN-0123456789';
const ID_TOKEN = 'ID-TOKEN-SECRET-abcdef';
const FRESH_ID_TOKEN = 'ID-TOKEN-FRESH-ghijkl';
const SECRETS = [CUSTOM_TOKEN, ID_TOKEN, FRESH_ID_TOKEN, 'REFRESH-SECRET'];
const CHANNEL_ID = protocol.toB64u(Buffer.alloc(16, 9));

function desktopIdentity() {
  const pairs = {
    sign: nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    agree: nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }),
  };
  const point = (key) => {
    const jwk = key.export({ format: 'jwk' });
    return protocol.toB64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  };
  return {
    keys: { sign: point(pairs.sign.publicKey), agree: point(pairs.agree.publicKey) },
    sign: (message) => nodeCrypto.sign('sha256', message, { key: pairs.sign.privateKey, dsaEncoding: 'ieee-p1363' }),
  };
}

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

/** A stream the test writes server-sent events into. */
function eventStream() {
  const encoder = new TextEncoder();
  let controller;
  const body = new ReadableStream({ start: (c) => { controller = c; } });
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    send: (type, data) => controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
    raw: (text) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: () => controller.error(new TypeError(`socket hang up for https://db.test/?auth=${ID_TOKEN}`)),
  };
}

/**
 * A relay behind `fetch`. `routes` overrides an answer by "METHOD path";
 * every request is recorded with its parsed body.
 */
function fakeRelay({ desktopKeys, routes = {} } = {}) {
  const requests = [];
  const streams = [];
  const challenges = new Set();
  async function fetchImpl(url, init = {}) {
    const method = init.method || 'GET';
    const parsed = new URL(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const request = { url, method, path: parsed.pathname, query: parsed.searchParams, headers: init.headers || {}, body, init };
    requests.push(request);
    const key = `${method} ${parsed.host}${parsed.pathname}`;
    if (routes[key]) return routes[key](request);
    if (key === 'POST relay.test/v1/challenges') {
      const challenge = protocol.toB64u(nodeCrypto.randomBytes(32));
      challenges.add(challenge);
      return json(200, { challenge, expiresAt: 1 });
    }
    if (key === 'POST relay.test/v1/pairings') {
      assert.ok(challenges.delete(body.challenge), 'a challenge of the relay, used once');
      const message = protocol.openMessage(body.challenge, body.desktopKeys);
      assert.ok(protocol.verifySignature(desktopKeys.sign, message, Buffer.from(body.proof, 'base64url')), 'the open proof verifies');
      return json(201, { channelId: CHANNEL_ID, pairingId: '0111', expiresAt: 5, token: CUSTOM_TOKEN });
    }
    if (key === 'POST relay.test/v1/tokens') {
      assert.ok(challenges.delete(body.challenge));
      assert.equal(body.role, 'desktop');
      const message = protocol.tokenMessage(body.challenge, body.channelId, 'desktop');
      assert.ok(protocol.verifySignature(desktopKeys.sign, message, Buffer.from(body.proof, 'base64url')), 'the token proof verifies');
      return json(200, { token: `${CUSTOM_TOKEN}-again` });
    }
    if (key === 'POST idt.test/v1/accounts:signInWithCustomToken') {
      assert.equal(parsed.searchParams.get('key'), 'web-api-key');
      assert.equal(body.returnSecureToken, true);
      const idToken = body.token === CUSTOM_TOKEN ? ID_TOKEN : FRESH_ID_TOKEN;
      return json(200, { idToken, refreshToken: 'REFRESH-SECRET', expiresIn: '3600' });
    }
    if (key === `GET db.test/channels/${CHANNEL_ID}.json`) {
      const stream = eventStream();
      streams.push({ request, ...stream });
      return stream.response;
    }
    if (method === 'DELETE' || key === `POST relay.test/v1/channels/${CHANNEL_ID}/confirm`) return json(204);
    return json(404, { error: { reason: 'not-found' } });
  }
  return { fetchImpl, requests, streams };
}

function noSecretIn(text, what) {
  for (const secret of SECRETS) assert.ok(!String(text).includes(secret), `${what} carries a token: ${text}`);
}

async function opened(t, { routes } = {}) {
  const identity = desktopIdentity();
  const relay = fakeRelay({ desktopKeys: identity.keys, routes });
  const adapter = createFirebaseRelayAdapter({ endpoint: ENDPOINT, fetchImpl: relay.fetchImpl, wait: async () => {} });
  t.after(() => adapter.close());
  const result = await adapter.openPairing({ desktopKeys: identity.keys, sign: identity.sign });
  return { identity, relay, adapter, result };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('building the adapter sends nothing (R7)', () => {
  let calls = 0;
  createFirebaseRelayAdapter({ endpoint: ENDPOINT, fetchImpl: async () => { calls += 1; return json(500); } });
  assert.equal(calls, 0);
});

test('without an endpoint every call fails with not-configured, and nothing is sent', async () => {
  let calls = 0;
  const adapter = createFirebaseRelayAdapter({ endpoint: null, fetchImpl: async () => { calls += 1; return json(500); } });
  const identity = desktopIdentity();
  await assert.rejects(adapter.openPairing({ desktopKeys: identity.keys, sign: identity.sign }), { reason: 'not-configured' });
  await assert.rejects(adapter.deleteChannel(CHANNEL_ID, { sign: identity.sign }), { reason: 'not-configured' });
  const error = await new Promise((resolve) => adapter.watchChannel(CHANNEL_ID, { onRecord: () => assert.fail(), onError: resolve }));
  assert.equal(error.reason, 'not-configured');
  assert.equal(calls, 0);
});

test('open: a challenge, a signed open, the token exchanged — and no token in the result', async (t) => {
  const { relay, result } = await opened(t);
  assert.deepEqual(result, { channelId: CHANNEL_ID, pairingId: '0111', expiresAt: 5, relayHost: 'relay.test' });
  assert.deepEqual(relay.requests.map((r) => `${r.method} ${r.path}`), [
    'POST /v1/challenges',
    'POST /v1/pairings',
    'POST /v1/accounts:signInWithCustomToken',
  ]);
  assert.equal(relay.requests[2].body.token, CUSTOM_TOKEN);
  for (const request of relay.requests) {
    assert.equal(request.init.redirect, 'error', 'no request follows a redirect');
    assert.ok(request.init.signal, 'every request has a timeout');
  }
  noSecretIn(JSON.stringify(result), 'the result');
});

test('the relay\'s answers are checked before the core sees them', async (t) => {
  const identity = desktopIdentity();
  const broken = [
    { channelId: 'short', pairingId: '0111', expiresAt: 5, token: CUSTOM_TOKEN },
    { channelId: CHANNEL_ID, pairingId: '011I', expiresAt: 5, token: CUSTOM_TOKEN },
    { channelId: CHANNEL_ID, pairingId: '0111', token: CUSTOM_TOKEN },
    { channelId: CHANNEL_ID, pairingId: '0111', expiresAt: 5 },
    { channelId: `${CHANNEL_ID}=`, pairingId: '0111', expiresAt: 5, token: CUSTOM_TOKEN },
  ];
  for (const answer of broken) {
    const relay = fakeRelay({ desktopKeys: identity.keys, routes: { 'POST relay.test/v1/pairings': () => json(201, answer) } });
    const adapter = createFirebaseRelayAdapter({ endpoint: ENDPOINT, fetchImpl: relay.fetchImpl });
    await assert.rejects(adapter.openPairing({ desktopKeys: identity.keys, sign: identity.sign }), { reason: 'invalid-response' }, JSON.stringify(answer));
  }
  const huge = fakeRelay({ desktopKeys: identity.keys, routes: { 'POST relay.test/v1/challenges': () => json(200, { challenge: 'A'.repeat(20_000) }) } });
  await assert.rejects(createFirebaseRelayAdapter({ endpoint: ENDPOINT, fetchImpl: huge.fetchImpl }).openPairing({ desktopKeys: identity.keys, sign: identity.sign }), { reason: 'invalid-response' });
  const notJson = fakeRelay({ desktopKeys: identity.keys, routes: { 'POST relay.test/v1/challenges': () => new Response('<html>', { status: 200 }) } });
  await assert.rejects(createFirebaseRelayAdapter({ endpoint: ENDPOINT, fetchImpl: notJson.fetchImpl }).openPairing({ desktopKeys: identity.keys, sign: identity.sign }), { reason: 'invalid-response' });
  t.diagnostic('five malformed answers, one oversized, one not JSON');
});

test('HTTP errors become reasons; a failed fetch becomes network, without its URL', async () => {
  const identity = desktopIdentity();
  for (const [status, reason] of [[401, 'unauthorized'], [403, 'refused'], [404, 'not-found'], [409, 'busy'], [429, 'rate-limited'], [503, 'unavailable'], [502, 'unavailable'], [418, 'invalid-response']]) {
    const relay = fakeRelay({ desktopKeys: identity.keys, routes: { 'POST relay.test/v1/challenges': () => json(status, { error: { reason: 'refused' } }) } });
    const adapter = createFirebaseRelayAdapter({ endpoint: ENDPOINT, fetchImpl: relay.fetchImpl });
    await assert.rejects(adapter.openPairing({ desktopKeys: identity.keys, sign: identity.sign }), (error) => {
      assert.equal(error.reason, reason, `HTTP ${status}`);
      assert.equal(error.status, status);
      return true;
    });
  }
  const adapter = createFirebaseRelayAdapter({
    endpoint: ENDPOINT,
    fetchImpl: async (url) => { throw new TypeError(`fetch failed: ${url}?auth=${ID_TOKEN}`); },
  });
  await assert.rejects(adapter.openPairing({ desktopKeys: identity.keys, sign: identity.sign }), (error) => {
    assert.equal(error.reason, 'network');
    noSecretIn(`${error.message}\n${error.stack}`, 'the error');
    assert.ok(!error.message.includes('relay.test'), 'no URL in the message');
    return true;
  });
});

test('following the channel: the stream carries the ID token, put and patch build the record, null ends it', async (t) => {
  const { relay, adapter } = await opened(t);
  const records = [];
  const errors = [];
  const watch = adapter.watchChannel(CHANNEL_ID, { onRecord: (r) => records.push(r), onError: (e) => errors.push(e) });
  await settle();
  const [stream] = relay.streams;
  assert.equal(stream.request.query.get('auth'), ID_TOKEN);
  assert.equal(stream.request.headers.Accept, 'text/event-stream');

  stream.send('put', { path: '/', data: { status: 'open', desktopKeys: { sign: 'a', agree: 'b' }, createdAt: 1 } });
  stream.raw(': a comment\n\nevent: keep-alive\ndata: null\n\n');
  stream.send('patch', { path: '/', data: { phoneKeys: { sign: 'P1', agree: 'P2' }, macP: 'MAC' } });
  stream.send('put', { path: '/status', data: 'pending' });
  stream.send('put', { path: '/__proto__/polluted', data: 'yes' });
  await settle();
  assert.deepEqual(records, [
    { status: 'open', phoneKeys: null, macP: null },
    { status: 'open', phoneKeys: { sign: 'P1', agree: 'P2' }, macP: 'MAC' },
    { status: 'pending', phoneKeys: { sign: 'P1', agree: 'P2' }, macP: 'MAC' },
  ]);
  assert.equal(({}).polluted, undefined);

  stream.send('put', { path: '/', data: null });
  await settle();
  assert.equal(records.at(-1), null, 'a record that disappears');
  assert.equal(relay.streams.length, 1, 'and is not followed again');
  assert.deepEqual(errors, []);
  watch.close();
});

test('a cancel event means the channel is gone; auth_revoked fails at once', async (t) => {
  const { relay, adapter } = await opened(t);
  const records = [];
  adapter.watchChannel(CHANNEL_ID, { onRecord: (r) => records.push(r), onError: () => assert.fail() });
  await settle();
  relay.streams[0].raw('event: cancel\ndata: "permission denied"\n\n');
  await settle();
  assert.deepEqual(records, [null]);

  const errors = [];
  adapter.watchChannel(CHANNEL_ID, { onRecord: () => {}, onError: (e) => errors.push(e) });
  await settle();
  relay.streams[1].raw('event: auth_revoked\ndata: "credential is no longer valid"\n\n');
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, 'unauthorized');
  assert.equal(relay.streams.length, 2, 'a refused token is not tried again');
});

test('a dropped stream is followed again; failing every time, it gives up with network', async (t) => {
  const { relay, adapter } = await opened(t);
  const errors = [];
  const records = [];
  adapter.watchChannel(CHANNEL_ID, { onRecord: (r) => records.push(r), onError: (e) => errors.push(e) });
  await settle();
  relay.streams[0].send('put', { path: '/', data: { status: 'open' } });
  relay.streams[0].fail();
  await settle();
  assert.equal(relay.streams.length, 2, 'connected again');
  relay.streams[1].send('put', { path: '/', data: { status: 'pending', phoneKeys: { sign: 'a', agree: 'b' }, macP: 'm' } });
  await settle();
  assert.equal(records.at(-1).status, 'pending');
  for (let i = 1; i <= STREAM_ATTEMPTS; i += 1) {
    relay.streams.at(-1).fail();
    await settle();
  }
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, 'network');
  noSecretIn(`${errors[0].message}\n${errors[0].stack}`, 'the stream error');
});

test('confirm, cancel and delete carry the desktop\'s bearer token', async (t) => {
  const { relay, adapter, identity } = await opened(t);
  await adapter.confirmPairing(CHANNEL_ID, 'MAC-D');
  const confirm = relay.requests.at(-1);
  assert.equal(confirm.path, `/v1/channels/${CHANNEL_ID}/confirm`);
  assert.equal(confirm.headers.Authorization, `Bearer ${ID_TOKEN}`);
  assert.deepEqual(confirm.body, { macD: 'MAC-D' });

  await adapter.cancelPairing(CHANNEL_ID, '0111');
  const cancel = relay.requests.at(-1);
  assert.equal(`${cancel.method} ${cancel.path}`, 'DELETE /v1/pairings/0111');
  assert.equal(cancel.headers.Authorization, `Bearer ${ID_TOKEN}`);
  await assert.rejects(adapter.confirmPairing(CHANNEL_ID, 'x'), { reason: 'unauthorized' }, 'the token went with the pairing');

  // After a restart: no token held, so a fresh one by a signed proof (§5.9).
  await adapter.deleteChannel(CHANNEL_ID, { sign: identity.sign });
  assert.deepEqual(relay.requests.slice(-4).map((r) => `${r.method} ${r.path}`), [
    'POST /v1/challenges',
    'POST /v1/tokens',
    'POST /v1/accounts:signInWithCustomToken',
    `DELETE /v1/channels/${CHANNEL_ID}`,
  ]);
  assert.equal(relay.requests.at(-1).headers.Authorization, `Bearer ${FRESH_ID_TOKEN}`);
});

test('a held token that ran out is replaced once', async (t) => {
  let first = true;
  const { relay, adapter, identity } = await opened(t, {
    routes: {
      [`DELETE relay.test/v1/channels/${CHANNEL_ID}`]: (request) => {
        if (first && request.headers.Authorization === `Bearer ${ID_TOKEN}`) {
          first = false;
          return json(401, { error: { reason: 'unauthorized' } });
        }
        return json(204);
      },
    },
  });
  await adapter.deleteChannel(CHANNEL_ID, { sign: identity.sign });
  const deletes = relay.requests.filter((r) => r.method === 'DELETE');
  assert.deepEqual(deletes.map((r) => r.headers.Authorization), [`Bearer ${ID_TOKEN}`, `Bearer ${FRESH_ID_TOKEN}`]);
});

test('applyAt: put replaces, patch merges, and no path reaches a prototype', () => {
  let tree = applyAt(undefined, '/', { a: { b: 1 }, c: 2 }, false);
  tree = applyAt(tree, '/a', { d: 3 }, true);
  assert.deepEqual(tree, { a: { b: 1, d: 3 }, c: 2 });
  tree = applyAt(tree, '/a/b', null, false);
  assert.deepEqual(tree, { a: { d: 3 }, c: 2 });
  assert.equal(applyAt(tree, '/__proto__/x', 1, false), tree);
  assert.equal(applyAt(tree, '/constructor/prototype', 1, false), tree);
  const patched = applyAt(tree, '/', JSON.parse('{"__proto__": {"status": "paired"}, "ok": 2}'), true);
  assert.deepEqual(patched, { a: { d: 3 }, c: 2, ok: 2 });
  assert.equal(Object.getPrototypeOf(patched), Object.prototype);
  assert.equal(patched.status, undefined);
});

test('the event stream reader: CRLF across chunks, comments, multi-line data, a size limit', async () => {
  const chunks = (...parts) => (async function* gen() { for (const part of parts) yield new TextEncoder().encode(part); })();
  const events = [];
  await readEventStream(chunks('event: put\r', '\ndata: {"a":\r\ndata: 1}\r\n\r\n', ': ping\n\n', 'data: last\n\n'), (event) => events.push(event));
  assert.deepEqual(events, [{ type: 'put', data: '{"a":\n1}' }, { type: 'message', data: 'last' }]);
  await assert.rejects(readEventStream(chunks(`data: ${'x'.repeat(200)}\n\n`), () => {}, { maxEventChars: 100 }), RangeError);
  await assert.rejects(readEventStream(chunks('x'.repeat(200)), () => {}, { maxEventChars: 100 }), RangeError);
});
