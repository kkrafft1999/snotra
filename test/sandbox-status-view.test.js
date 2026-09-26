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

test('isolated: what the sandbox allows, no warning', async () => {
  const { describeSandboxStatus } = await load();
  const status = describeSandboxStatus({ isolated: true, status: 'isolated' }, true);
  assert.equal(status.isWarning, false);
  assert.match(status.text, /^Isolated: writes only in the project folder/);
});

// Amber, not red, since #396: the tool still runs, only without the sandbox.
test('not isolated: a warning, with the reason and what to do', async () => {
  const { describeSandboxStatus } = await load();
  const missing = describeSandboxStatus({ isolated: false, status: 'unavailable', reason: 'dependencies', missing: ['socat'] }, true);
  const ubuntu = describeSandboxStatus({
    isolated: false, status: 'unavailable', reason: 'self-test', detail: 'bwrap: loopback: Failed RTM_NEWADDR',
  }, true);
  const windows = describeSandboxStatus({ isolated: false, status: 'unavailable', reason: 'platform' }, true);

  for (const status of [missing, ubuntu, windows]) assert.equal(status.isWarning, true);
  assert.match(missing.text, /needs the packages socat\. Install them/);
  assert.match(ubuntu.text, /\(bwrap: loopback: Failed RTM_NEWADDR\)/);
  assert.match(ubuntu.text, /kernel\.apparmor_restrict_unprivileged_userns=0/);
  assert.match(windows.text, /Windows has no sandbox yet/);
});

test('on macOS a failing self-test does not point at an Ubuntu switch', async () => {
  const { describeSandboxStatus } = await load();
  const status = describeSandboxStatus({ isolated: false, status: 'unavailable', reason: 'self-test', platform: 'darwin' }, true);
  assert.equal(status.isWarning, true);
  assert.doesNotMatch(status.text, /Ubuntu|sysctl/);
  assert.match(status.text, /please report it/);
});

test('a detection still running is announced, not reported as a failure', async () => {
  const { describeSandboxStatus } = await load();
  const status = describeSandboxStatus({ isolated: false, status: 'testing' }, true);
  assert.equal(status.isWarning, false);
  assert.match(status.text, /checked the first time/);
});

// ── The shield next to the folder name (#398) ─────────────────────────────

const WORKSPACE = '/work/projekt';
const permissions = (isolation, root = WORKSPACE) => ({ workspaceRoot: root, executionIsolation: isolation });

test('folder shield: only with an open folder and an execution tool', async () => {
  const { describeFolderSandbox } = await load();
  const hidden = { visible: false, unisolated: false, text: '' };
  assert.deepEqual(describeFolderSandbox(permissions({ unisolated: false, tools: [], reason: '' })), hidden);
  assert.deepEqual(describeFolderSandbox(permissions({ unisolated: true, tools: ['shell_execute'], reason: 'workspace' }, null)), hidden);
  assert.deepEqual(describeFolderSandbox(permissions(undefined)), hidden);
  assert.deepEqual(describeFolderSandbox(null), hidden);
  // Only the two execution tools count.
  assert.deepEqual(describeFolderSandbox(permissions({ unisolated: false, tools: ['read_file_text'], reason: '' })), hidden);
});

test('folder shield: isolated, still being checked, switched off, no sandbox on the system', async () => {
  const { describeFolderSandbox } = await load();
  const on = describeFolderSandbox(permissions({ unisolated: false, tools: ['shell_execute'], reason: '', pending: false }));
  assert.deepEqual(on, { visible: true, unisolated: false, text: 'Isolated: runs of shell_execute stay in the sandbox in this workspace.' });

  const pending = describeFolderSandbox(permissions({ unisolated: false, tools: ['run_python', 'shell_execute'], reason: '', pending: true }));
  assert.equal(pending.unisolated, false);
  assert.equal(pending.text, 'The sandbox for run_python and shell_execute is being checked.');

  const off = describeFolderSandbox(permissions({ unisolated: true, tools: ['shell_execute'], reason: 'workspace' }));
  assert.equal(off.unisolated, true);
  assert.match(off.text, /^Not isolated: you switched the sandbox off for this workspace\./);

  // Windows, missing packages, a failed self-test: the same state, the same amber.
  for (const reason of ['platform', 'dependencies', 'self-test', 'start']) {
    const system = describeFolderSandbox(permissions({ unisolated: true, tools: ['run_python'], reason }));
    assert.equal(system.unisolated, true, reason);
    assert.equal(system.text, 'Not isolated: no sandbox for run_python on this system. Every run has your full rights.');
  }
});
