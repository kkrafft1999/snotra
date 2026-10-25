'use strict';

// The relay conformance runner and the reference phone (#1135) against the
// HTTP stand-in for the relay: the runner passes a relay that keeps the spec,
// names the step a broken one fails, and its command line keeps the interface
// snotra-promotion's CI calls it through. The real relay is held to the same
// runner there (snotra-promotion#165).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { createRelayStandIn, FAULTS } = require('../e2e/remote/relay-stand-in');
const { databaseNodeUrl } = require('../src/main/remote/firebase-relay-adapter');

const RUNNER = path.join(__dirname, '..', 'e2e', 'remote', 'relay-conformance.mjs');
// A file URL: on Windows import() takes no drive path.
const runner = () => import(pathToFileURL(RUNNER).href);

/** @param {import('node:test').TestContext} t @param {string[]} [faults] */
async function standIn(t, faults = []) {
  const relay = createRelayStandIn({ faults });
  const config = await relay.start();
  t.after(() => relay.stop());
  return { relay, config };
}

/** @param {string[]} args @param {Record<string, string>} env */
function cli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('a relay that keeps the spec passes every step, and nothing is left streaming', async (t) => {
  const { relay, config } = await standIn(t);
  const { runConformance } = await runner();
  const passed = await runConformance(config);

  for (const step of [
    'pair: a second claim is refused (§5.5)',
    'pair: before paired the phone cannot read its inbox (§5.10)',
    'pair: the phone never reads the channel node (§5.10)',
    'pair: confirming twice is refused (§5.6)',
    'pair: MAC_D in meta verifies on the phone (§6)',
    'pair: a restarted desktop removes the phone with a token of its own (§5.8, §5.9)',
    'cancel: a cancelled pairing is not found (§5.4)',
    'disconnect: the desktop\'s stream sees meta vanish (§5.8)',
    'rules: the same challenge is refused the second time (§5.2)',
    'rules: a body over 4 KiB is refused (§5.1)',
    'channel: before paired the phone cannot write its handshake (§13)',
    'channel: the phone sees the desktop\'s presence, stamped by the server (§12)',
    'channel: the phone sees protocol-unsupported with the desktop\'s versions (§13)',
    'channel: both sides derive the same session (§14)',
    'channel: the phone\'s inbox carries the answer, and it opens (§15, §17)',
    'channel: an envelope is never overwritten (§15)',
    'channel: an envelope without the server\'s time is refused (§15)',
    'channel again: the new session has an id of its own (§14)',
    'channel: the desktop sees the phone\'s presence gone (§12)',
    'channel: the desktop\'s stream sees meta vanish (§5.8)',
  ]) {
    assert.ok(passed.includes(step), `missing step: ${step}`);
  }
  assert.equal(new Set(passed).size, passed.length, 'every step has a name of its own');
  // The rules scenario leaves its one pairing open; every other channel is
  // gone. The runner closed its streams; the server hears of it a tick later.
  for (const deadline = Date.now() + 2000; relay.inspect().streams > 0 && Date.now() < deadline;) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(relay.inspect(), { channels: 1, pairings: 1, streams: 0 });
});

test('a relay that takes a second claim fails on that step, with what came back', async (t) => {
  const { config } = await standIn(t, [FAULTS.SECOND_CLAIM]);
  const { runConformance, ConformanceError } = await runner();
  await assert.rejects(runConformance(config), (error) => {
    assert.ok(error instanceof ConformanceError);
    assert.equal(error.step, 'pair: a second claim is refused (§5.5)');
    assert.match(error.message, /expected HTTP 404, the relay accepted it/);
    return true;
  });
});

test('a relay that opens the phone\'s inbox before paired fails on that step', async (t) => {
  const { config } = await standIn(t, [FAULTS.EARLY_INBOX]);
  const { runConformance } = await runner();
  await assert.rejects(runConformance(config), {
    step: 'pair: before paired the phone cannot read its inbox (§5.10)',
    message: /expected the database to refuse .*got HTTP 200/,
  });
});

test('a relay that lets a sender overwrite an envelope fails on that step', async (t) => {
  const { config } = await standIn(t, [FAULTS.OVERWRITE_ENVELOPE]);
  const { runConformance } = await runner();
  await assert.rejects(runConformance(config), {
    step: 'channel: an envelope is never overwritten (§15)',
    message: /expected the database to refuse .*got HTTP 204/,
  });
});

test('a relay nobody answers on fails on the first step, without a stack', async () => {
  const { runConformance } = await runner();
  await assert.rejects(runConformance({
    relayUrl: 'http://127.0.0.1:9/v1',
    databaseUrl: 'http://127.0.0.1:9/db?ns=none',
    apiKey: 'key',
    appCheckToken: 'app-check',
    identityToolkitUrl: 'http://127.0.0.1:9/identitytoolkit/v1',
  }), {
    step: 'pair: the desktop opens a pairing (§5.2, §5.3)',
    message: /remote relay: network/,
  });
});

test('the command line takes flags or the environment, prints each step and exits 0', async (t) => {
  const { config } = await standIn(t);
  const { code, stdout, stderr } = await cli([
    '--relay-url', config.relayUrl,
    `--database-url=${config.databaseUrl}`,
    '--identity-toolkit-url', config.identityToolkitUrl,
  ], {
    SNOTRA_RELAY_API_KEY: config.apiKey,
    SNOTRA_RELAY_APP_CHECK_TOKEN: config.appCheckToken,
  });
  assert.equal(stderr, '');
  assert.equal(code, 0);
  assert.match(stdout, /^ok {4}pair: the desktop opens a pairing/m);
  assert.match(stdout, /conforms to docs\/remote\/remote-protocol\.md parts 1 and 2: \d+ steps/);
  // Tokens never reach the output, not even inside a URL.
  assert.doesNotMatch(stdout, /auth=|Bearer|idToken/);
});

test('the command line exits 1 with the failed step on a broken relay', async (t) => {
  const { config } = await standIn(t, [FAULTS.SECOND_CLAIM]);
  const { code, stderr } = await cli([], {
    SNOTRA_RELAY_URL: config.relayUrl,
    SNOTRA_RELAY_DATABASE_URL: config.databaseUrl,
    SNOTRA_RELAY_API_KEY: config.apiKey,
    SNOTRA_RELAY_APP_CHECK_TOKEN: config.appCheckToken,
    SNOTRA_RELAY_IDENTITY_TOOLKIT_URL: config.identityToolkitUrl,
  });
  assert.equal(code, 1);
  assert.match(stderr, /^FAIL {2}pair: a second claim is refused \(§5\.5\): expected HTTP 404/m);
});

test('the command line exits 2 and names what is missing or unknown', async () => {
  const { code, stderr } = await cli(['--relay-url', 'http://relay.test/v1', '--colour', 'blue']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown argument: --colour blue/);
  assert.match(stderr, /missing: --database-url \/ SNOTRA_RELAY_DATABASE_URL, --api-key/);
  assert.match(stderr, /^usage: /m);
});

test('the database URL keeps the emulator\'s namespace query behind the node path', () => {
  assert.equal(
    databaseNodeUrl('http://127.0.0.1:9000/?ns=snotra-ai-relay', 'channels/abc/meta', 'TOKEN'),
    'http://127.0.0.1:9000/channels/abc/meta.json?ns=snotra-ai-relay&auth=TOKEN',
  );
  assert.equal(
    databaseNodeUrl('https://snotra-ai-relay.europe-west1.firebasedatabase.app', 'channels/abc/meta', 'T'),
    'https://snotra-ai-relay.europe-west1.firebasedatabase.app/channels/abc/meta.json?auth=T',
  );
});
