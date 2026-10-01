// One child process of the shell and Python runners (CR-B03-01, CR-B03-02):
// what the command leaves in the background ends with it, and a command that
// ignores its input does not take the main process down.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const { EventEmitter } = require('events');

const { createChildRunner } = require('../src/main/services/child-run');

const posixOnly = { skip: process.platform === 'win32' ? 'process groups are POSIX' : false };

const LIMITS = { maxStdinChars: 200_000, maxOutputBytes: 200_000, startError: 'could not start' };

function sh(runner, script, extra = {}) {
  return runner.run({
    command: '/bin/sh',
    args: ['-c', script],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 10_000,
    ...LIMITS,
    ...extra,
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a process left in the background does not outlive its run', posixOnly, async () => {
  const runner = createChildRunner({ spawn: childProcess.spawn });
  const result = await sh(runner, 'sleep 30 >/dev/null 2>&1 & echo $!');
  const pid = Number(result.stdout.trim());

  assert.equal(result.exitCode, 0);
  assert.ok(Number.isInteger(pid) && pid > 0, result.stdout);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(alive(pid), false, 'the background sleep must be gone');
});

test('a background process holding the output does not keep the run open until the time limit', posixOnly, async () => {
  const runner = createChildRunner({ spawn: childProcess.spawn });
  const startedAt = Date.now();
  const result = await sh(runner, 'sleep 30 & echo started', { timeoutMs: 20_000 });

  assert.equal(result.stdout.trim(), 'started');
  assert.equal(result.timedOut, false);
  assert.ok(Date.now() - startedAt < 5_000, 'the run ends with its shell');
});

test('work in the background within the run still finishes', posixOnly, async () => {
  const runner = createChildRunner({ spawn: childProcess.spawn });
  const result = await sh(runner, '(sleep 0.2; echo late) & wait; echo done');

  assert.deepEqual(result.stdout.trim().split('\n'), ['late', 'done']);
});

test('a command that does not read its input finishes normally (EPIPE)', async (t) => {
  if (process.platform === 'win32') return t.skip('/bin/sh');
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    const runner = createChildRunner({ spawn: childProcess.spawn });
    for (let i = 0; i < 3; i += 1) {
      const result = await sh(runner, 'exit 0', { stdin: 'x'.repeat(150_000) });
      assert.equal(result.exitCode, 0);
    }
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  assert.deepEqual(uncaught.map((e) => e.code), []);
});

test('on Windows nothing is sent to a process group after the exit', async (t) => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  const kill = t.mock.method(process, 'kill', () => true);
  const runner = createChildRunner({ spawn: () => child, platform: 'win32' });

  const pending = runner.run({ command: 'pwsh.exe', args: [], cwd: '.', env: {}, timeoutMs: 10_000, ...LIMITS });
  child.emit('exit', 0);
  child.emit('close', 0);
  const result = await pending;

  assert.equal(result.exitCode, 0);
  assert.equal(kill.mock.callCount(), 0);
});

test('on POSIX the group of the exited leader is addressed, and a missing group is no error', async (t) => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  const kill = t.mock.method(process, 'kill', () => {
    const error = new Error('kill ESRCH');
    error.code = 'ESRCH';
    throw error;
  });
  const runner = createChildRunner({ spawn: () => child, platform: 'linux' });

  const pending = runner.run({ command: '/bin/sh', args: [], cwd: '.', env: {}, timeoutMs: 10_000, ...LIMITS });
  child.emit('exit', 0);
  child.emit('close', 0);
  const result = await pending;

  assert.equal(result.exitCode, 0);
  assert.deepEqual(kill.mock.calls.map((c) => c.arguments), [[-4242, 'SIGKILL']]);
});
