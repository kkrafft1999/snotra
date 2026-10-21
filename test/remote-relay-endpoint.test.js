'use strict';

// The production relay (#1193): the endpoint the desktop pairs through, in
// the shape the Firebase adapter takes, and a host a pairing code's QR
// payload may name. Its web API key comes in at build time
// (scripts/write-relay-key.js), never from the repository.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { productionRelay, RELAY_HOST } = require('../src/main/remote/relay-endpoint');
const { writeRelayKey } = require('../scripts/write-relay-key');
const { normalizeRemotePairingState } = require('../src/shared/contracts/remote/pairing-state');
const { removeTempDir } = require('./helpers/temp-dir');

// Put together here, so that no scanner takes a test value for a key.
const FAKE_KEY = ['AI', 'za', 'x'.repeat(35)].join('');

test('with a key, the production relay in the adapter\'s endpoint shape; without one, none', () => {
  const relay = productionRelay(FAKE_KEY);
  assert.deepEqual(Object.keys(relay).sort(), ['apiKey', 'databaseUrl', 'relayHost']);
  assert.equal(relay.relayHost, 'relay.snotra-ai.dev');
  assert.match(relay.databaseUrl, /^https:\/\/[a-z0-9-]+\.europe-west1\.firebasedatabase\.app$/);
  assert.ok(Object.isFrozen(relay), 'not changed at run time');
  for (const nokey of [undefined, null, '', 'not-a-key', `${FAKE_KEY}x`, 42]) assert.equal(productionRelay(nokey), null);
});

test('the relay host is one a pairing code\'s QR payload may name', () => {
  const code = { display: '0111-EP9D-ZH4Q-PYT4-HWWF', qr: `snotra-pair:v1/${RELAY_HOST}/0111EP9DZH4QPYT4HWWF`, expiresAt: 1_700_000_000_000 };
  assert.deepEqual(normalizeRemotePairingState({ state: 'code', code }).code, code);
});

test('no key file in the repository', () => {
  const file = path.join(__dirname, '..', 'src', 'main', 'remote', 'relay-key.generated.json');
  const { execFileSync } = require('node:child_process');
  const tracked = execFileSync('git', ['ls-files', '--', file], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(tracked.trim(), '', 'the key is written at build time and ignored by git');
});

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-relay-key-'));
  t.after(() => removeTempDir(root));
  return { root, target: path.join(root, 'relay-key.generated.json') };
}

test('the build writes the key from the environment, or from .env', (t) => {
  const { root, target } = tempRoot(t);
  const lines = [];
  assert.equal(writeRelayKey({ env: { SNOTRA_RELAY_API_KEY: ` ${FAKE_KEY} ` }, root, target, log: (l) => lines.push(l) }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { apiKey: FAKE_KEY });
  assert.ok(lines.every((l) => !l.includes(FAKE_KEY)), 'the key is never printed');

  fs.rmSync(target);
  fs.writeFileSync(path.join(root, '.env'), `OTHER=1\nSNOTRA_RELAY_API_KEY="${FAKE_KEY}"\n`);
  assert.equal(writeRelayKey({ env: {}, root, target, log: () => {} }), true);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).apiKey, FAKE_KEY);
});

test('without a key a build has no relay, and a release build fails', (t) => {
  const { root, target } = tempRoot(t);
  assert.equal(writeRelayKey({ env: {}, root, target, log: () => {} }), false);
  assert.equal(fs.existsSync(target), false);
  assert.throws(() => writeRelayKey({ require: true, env: {}, root, target, log: () => {} }), /SNOTRA_RELAY_API_KEY is not set/);
  assert.throws(() => writeRelayKey({ env: { SNOTRA_RELAY_API_KEY: 'oops' }, root, target, log: () => {} }), /does not look like/);
  assert.equal(fs.existsSync(target), false);
});
