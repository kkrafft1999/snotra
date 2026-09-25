// The isolation line in the settings (#329): what it says, and when it stays
// hidden.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('path');
const { pathToFileURL } = require('url');

const load = () =>
  import(pathToFileURL(nodePath.join(__dirname, '..', 'src', 'renderer', 'utils', 'sandbox-status-view.js')).href);

test('nothing to say for a switched-off tool or without a sandbox state', async () => {
  const { describeSandboxStatus } = await load();
  assert.equal(describeSandboxStatus({ isolated: true }, false), null);
  assert.equal(describeSandboxStatus(undefined, true), null);
});

test('isolated: what the sandbox allows, not red', async () => {
  const { describeSandboxStatus } = await load();
  const status = describeSandboxStatus({ isolated: true, status: 'isolated' }, true);
  assert.equal(status.isError, false);
  assert.match(status.text, /^Isolated: writes only in the project folder/);
});

test('not isolated: red, with the reason and what to do', async () => {
  const { describeSandboxStatus } = await load();
  const missing = describeSandboxStatus({ isolated: false, status: 'unavailable', reason: 'dependencies', missing: ['socat'] }, true);
  const ubuntu = describeSandboxStatus({
    isolated: false, status: 'unavailable', reason: 'self-test', detail: 'bwrap: loopback: Failed RTM_NEWADDR',
  }, true);
  const windows = describeSandboxStatus({ isolated: false, status: 'unavailable', reason: 'platform' }, true);

  for (const status of [missing, ubuntu, windows]) assert.equal(status.isError, true);
  assert.match(missing.text, /needs the packages socat\. Install them/);
  assert.match(ubuntu.text, /\(bwrap: loopback: Failed RTM_NEWADDR\)/);
  assert.match(ubuntu.text, /kernel\.apparmor_restrict_unprivileged_userns=0/);
  assert.match(windows.text, /Windows has no sandbox yet/);
});

test('on macOS a failing self-test does not point at an Ubuntu switch', async () => {
  const { describeSandboxStatus } = await load();
  const status = describeSandboxStatus({ isolated: false, status: 'unavailable', reason: 'self-test', platform: 'darwin' }, true);
  assert.equal(status.isError, true);
  assert.doesNotMatch(status.text, /Ubuntu|sysctl/);
  assert.match(status.text, /please report it/);
});

test('a detection still running is announced, not reported as a failure', async () => {
  const { describeSandboxStatus } = await load();
  const status = describeSandboxStatus({ isolated: false, status: 'testing' }, true);
  assert.equal(status.isError, false);
  assert.match(status.text, /checked the first time/);
});
