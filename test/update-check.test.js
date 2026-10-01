'use strict';

// The update check as the app runs it — silently after the start, or from
// the menu (#407, #442). Moved out of the composition root with #508.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUpdateCheck } = require('../src/main/adapters/update-adapter');
const { PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');

function makeWindow(sent, { destroyed = false } = {}) {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

function makeUpdates({ updateAvailable = true, readInstallFailure, clearInstallFailure, error } = {}) {
  const calls = [];
  const updates = {
    checkForUpdate: async (options) => {
      calls.push(options);
      return {
        updateAvailable,
        currentVersion: '1.0.0',
        latestVersion: updateAvailable ? '2.0.0' : '1.0.0',
        ...(error ? { error } : {}),
      };
    },
  };
  if (readInstallFailure) updates.readInstallFailure = readInstallFailure;
  if (clearInstallFailure) updates.clearInstallFailure = clearInstallFailure;
  return { calls, updates };
}

function makeCheck({ updates, sent = [], env = {}, window } = {}) {
  return createUpdateCheck({
    updates,
    getMainWindow: () => (window === undefined ? makeWindow(sent) : window),
    PUSH,
    env,
  });
}

test('the silent check stays quiet when no update is available', async () => {
  const sent = [];
  const { calls, updates } = makeUpdates({ updateAvailable: false });
  await makeCheck({ updates, sent })({ silent: true });
  assert.deepEqual(calls, [{ respectIgnored: true }]);
  assert.equal(sent.length, 0);
});

test('the silent check pushes an available update', async () => {
  const sent = [];
  const { updates } = makeUpdates();
  await makeCheck({ updates, sent })({ silent: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, PUSH.UPDATE_AVAILABLE);
  assert.equal(sent[0].payload.manual, false);
  assert.equal(sent[0].payload.updateAvailable, true);
  assert.equal(sent[0].payload.lastInstallFailure, null);
});

test('the manual check always answers, also when up to date, and shows an ignored version', async () => {
  const sent = [];
  const { calls, updates } = makeUpdates({ updateAvailable: false });
  await makeCheck({ updates, sent })({ silent: false });
  assert.deepEqual(calls, [{ respectIgnored: false }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.manual, true);
  assert.equal(sent[0].payload.updateAvailable, false);
});

test('without a window, or with a destroyed one, nothing is sent', async () => {
  const sent = [];
  const { updates } = makeUpdates();
  await makeCheck({ updates, window: null })({ silent: false });
  await makeCheck({ updates, window: makeWindow(sent, { destroyed: true }) })({ silent: false });
  assert.equal(sent.length, 0);
});

test('SNOTRA_NO_UPDATE_CHECK=1 skips the silent start-up check (#407)', async () => {
  const sent = [];
  const { calls, updates } = makeUpdates();
  await makeCheck({ updates, sent, env: { SNOTRA_NO_UPDATE_CHECK: '1' } })({ silent: true });
  assert.equal(calls.length, 0, 'no request to the update service');
  assert.equal(sent.length, 0);
});

test('SNOTRA_NO_UPDATE_CHECK=1 still answers a check the user asked for', async () => {
  const sent = [];
  const { calls, updates } = makeUpdates();
  await makeCheck({ updates, sent, env: { SNOTRA_NO_UPDATE_CHECK: '1' } })({ silent: false });
  assert.equal(calls.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.manual, true);
});

test('other values of SNOTRA_NO_UPDATE_CHECK leave the start-up check on', async () => {
  const { calls, updates } = makeUpdates();
  await makeCheck({ updates, env: { SNOTRA_NO_UPDATE_CHECK: 'true' } })({ silent: true });
  assert.equal(calls.length, 1);
});

// #442: a failed swap is read once on the silent start check and travels with
// the update it concerns; the ignored version must not hide it.
test('the silent check reports a failed install from the last quit', async () => {
  const sent = [];
  let reads = 0;
  let cleared = 0;
  const failure = { version: '2.0.0', error: 'in use', logFile: '/tmp/update-install.log' };
  const { calls, updates } = makeUpdates({
    readInstallFailure: async () => { reads += 1; return cleared ? null : failure; },
    clearInstallFailure: async () => { cleared += 1; },
  });
  const runUpdateCheck = makeCheck({ updates, sent });

  await runUpdateCheck({ silent: true });
  assert.deepEqual(calls[0], { respectIgnored: false });
  assert.deepEqual(sent[0].payload.lastInstallFailure, failure);
  assert.equal(cleared, 1, 'shown, so it is cleared');

  await runUpdateCheck({ silent: false });
  assert.equal(reads, 1, 'a manual check leaves the record alone');
  assert.equal(sent[1].payload.lastInstallFailure, null);
});

// #573: the record used to be deleted before the check. A start without
// GitHub showed nothing and lost it for good.
test('a failed install is kept for the next start when the check cannot reach GitHub', async () => {
  const sent = [];
  let cleared = 0;
  const failure = { version: '2.0.0', error: 'in use', logFile: '/tmp/update-install.log' };
  const { updates } = makeUpdates({
    updateAvailable: false,
    error: { key: 'update.error.offline' },
    readInstallFailure: async () => failure,
    clearInstallFailure: async () => { cleared += 1; },
  });

  await makeCheck({ updates, sent })({ silent: true });
  assert.equal(sent.length, 0);
  assert.equal(cleared, 0);
});
