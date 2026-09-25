// The runners with a sandbox wired in (#329), against a fake sandbox that
// passes the command through: what they hand over, what they spawn, and that
// time limit, "Stop", release and cleanup still hold. The real sandbox is
// exercised in sandbox-isolation.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const { createShellRunnerService } = require('../src/main/services/shell-runner-service');
const { createPythonRunnerService } = require('../src/main/services/python-runner-service');

const posixOnly = { skip: process.platform === 'win32' ? 'the sandbox is macOS/Linux only' : false };

function fakeSandbox({ available = true, reason = 'platform', fail = null } = {}) {
  const calls = { prepare: [], released: 0, runTmps: [] };
  return {
    calls,
    describe: () => ({ isolated: available, reason: available ? '' : reason, missing: [] }),
    async prepare(request) {
      calls.prepare.push(request);
      calls.runTmps.push(request.runTmp);
      if (fail) throw fail;
      if (!available) return null;
      return {
        command: '/bin/sh',
        args: ['-c', request.command],
        env: { SNOTRA_SANDBOX_MARK: 'inside' },
        domains: request.allowedDomains || [],
        annotate: (stderr) => `${stderr}<violations/>`,
        release: () => { calls.released += 1; },
      };
    },
  };
}

async function shellWith(sandbox) {
  const service = createShellRunnerService({ spawn: childProcess.spawn, os, fs, path, sandbox });
  await service.detect();
  return service.isAvailable() ? service : null;
}

const exists = (p) => fs.stat(p).then(() => true, () => false);

test('shell: the sandboxed command runs with its environment and is released', posixOnly, async (t) => {
  const sandbox = fakeSandbox();
  const shell = await shellWith(sandbox);
  if (!shell) return t.skip('no shell');

  const result = await shell.run({
    command: 'echo "$SNOTRA_SANDBOX_MARK"; echo oops >&2',
    workspaceRoot: '/tmp/project',
    networkDomains: ['pypi.org'],
    cwd: os.tmpdir(),
  });

  assert.equal(result.stdout.trim(), 'inside');
  assert.equal(result.stderr.trim(), 'oops\n<violations/>');
  assert.deepEqual(result.isolation, { isolated: true, domains: ['pypi.org'] });
  const request = sandbox.calls.prepare[0];
  assert.equal(request.workspaceRoot, '/tmp/project');
  assert.equal(request.commandText, 'echo "$SNOTRA_SANDBOX_MARK"; echo oops >&2');
  // The wrapped line starts the same shell the same way as without a sandbox.
  assert.ok(request.command.startsWith(`${shell.describe().command} `));
  assert.equal(sandbox.calls.released, 1);
  assert.equal(await exists(sandbox.calls.runTmps[0]), false, 'the run’s temp dir is gone');
});

test('shell: no isolation available — the command still runs, and the result says so', posixOnly, async (t) => {
  const sandbox = fakeSandbox({ available: false, reason: 'dependencies' });
  const shell = await shellWith(sandbox);
  if (!shell) return t.skip('no shell');

  const result = await shell.run({ command: 'echo "${SNOTRA_SANDBOX_MARK:-plain}"', cwd: os.tmpdir() });

  assert.equal(result.stdout.trim(), 'plain');
  assert.deepEqual(result.isolation, { isolated: false, reason: 'dependencies', missing: [] });
  assert.equal(await exists(sandbox.calls.runTmps[0]), false);
});

test('shell: the time limit still ends the sandboxed process tree', posixOnly, async (t) => {
  const sandbox = fakeSandbox();
  const shell = await shellWith(sandbox);
  if (!shell) return t.skip('no shell');

  const started = Date.now();
  const result = await shell.run({ command: 'sleep 30 & sleep 30; wait', timeoutMs: 600, cwd: os.tmpdir() });

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
  assert.equal(sandbox.calls.released, 1);
});

test('shell: "Stop" while waiting for the sandbox ends the run without starting it', posixOnly, async (t) => {
  const abort = Object.assign(new Error('Aborted while waiting for the sandbox.'), { name: 'AbortError' });
  const sandbox = fakeSandbox({ fail: abort });
  const shell = await shellWith(sandbox);
  if (!shell) return t.skip('no shell');

  const result = await shell.run({ command: 'echo never', cwd: os.tmpdir() });

  assert.equal(result.aborted, true);
  assert.equal(result.stdout, '');
  assert.equal(await exists(sandbox.calls.runTmps[0]), false);
});

test('shell: a sandbox that fails to wrap is an error, never a silent unisolated run', posixOnly, async (t) => {
  const sandbox = fakeSandbox({ fail: new Error('wrap failed') });
  const shell = await shellWith(sandbox);
  if (!shell) return t.skip('no shell');

  const result = await shell.run({ command: 'echo never', cwd: os.tmpdir() });

  assert.deepEqual(result, { error: 'wrap failed' });
});

test('python: the script runs sandboxed from its temp dir, which is the writable place', posixOnly, async (t) => {
  const sandbox = fakeSandbox();
  const python = createPythonRunnerService({ spawn: childProcess.spawn, fs, path, os, sandbox });
  await python.detect();
  if (!python.isAvailable()) return t.skip('no Python 3');

  const result = await python.run({
    code: 'import os; print(os.environ.get("SNOTRA_SANDBOX_MARK"))',
    workspaceRoot: '/tmp/project',
    networkDomains: [],
  });

  assert.equal(result.stdout.trim(), 'inside');
  assert.deepEqual(result.isolation, { isolated: true, domains: [] });
  const request = sandbox.calls.prepare[0];
  assert.equal(request.workspaceRoot, '/tmp/project');
  assert.ok(request.command.includes(request.runTmp), 'the script lives in the run’s temp dir');
  assert.equal(sandbox.calls.released, 1);
  assert.equal(await exists(request.runTmp), false);
});
