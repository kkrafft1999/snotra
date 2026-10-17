// A Windows Job Object for each run (#991): what a command or a script leaves
// in the background ends with the run, as the process group does on POSIX.
//
// The tests that prove it run on the Windows CI runner against the real
// PowerShell editions and the real Python. Each of them first shows that the
// background process does outlive a run without the job, so that a green run
// cannot come from a process that never started or ended on its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const { withPowerShellJob, pythonJobArgs, noteUncontained, POWERSHELL_JOB, PYTHON_JOB, NOTICE } =
  require('../src/main/services/windows-job');
const { createChildRunner } = require('../src/main/services/child-run');
const { createShellRunnerService, buildShellArgs, INVOCATIONS, PROBE_MARKER } =
  require('../src/main/services/shell-runner-service');
const { createPythonRunnerService } = require('../src/main/services/python-runner-service');

const windowsOnly = { skip: process.platform === 'win32' ? false : 'Job Objects are Windows' };

const LIMITS = { maxStdinChars: 200_000, maxOutputBytes: 200_000, startError: 'could not start' };

function lines(text) {
  return String(text).replace(/\r\n/g, '\n').trim().split('\n');
}

function decoded(args) {
  return Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Polls for a state with a deadline instead of sleeping and hoping (#883). */
async function until(check, what, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function fakeChild({ stdout = '', code = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code);
  });
  return child;
}

// ── The two launch forms ─────────────────────────────────────────────────────

test('PowerShell gets the job as one line in front of the command, which stays as it was', () => {
  const command = 'git status\nGet-ChildItem | Select-Object -First 3';
  const script = withPowerShellJob(command);

  assert.equal(script, `${POWERSHELL_JOB}\n${command}`);
  assert.equal(POWERSHELL_JOB.includes('\n'), false, 'the command moves down by exactly one line');
});

test('a command\'s own `using` statements stay in front of the job', () => {
  const script = withPowerShellJob('# tools\nusing namespace System.IO\nusing module "./x.psm1"; [File]::Exists("a")');

  assert.equal(
    script,
    `# tools\nusing namespace System.IO\nusing module "./x.psm1"; \n${POWERSHELL_JOB}\n[File]::Exists("a")`,
  );
  // A `using` somewhere else is just text: the job stays in front.
  assert.equal(withPowerShellJob("Write-Output 'using it'"), `${POWERSHELL_JOB}\nWrite-Output 'using it'`);
});

test('the note fits into the single-quoted strings of both launch forms', () => {
  assert.equal(NOTICE.includes("'"), false);
  assert.equal(NOTICE.includes('\n'), false);
});

test('Python runs the real interpreter as the child of a first one', () => {
  assert.deepEqual(pythonJobArgs(['-B', '-u', 'script.py', 'a']), ['-B', '-c', PYTHON_JOB, '-B', '-u', 'script.py', 'a']);
});

test('the first interpreter passes arguments, input, output and exit code through', async (t) => {
  if (process.platform === 'win32') return t.skip('the Windows tests below run it for real');
  const probe = childProcess.spawnSync('python3', ['--version']);
  if (probe.error || probe.status !== 0) return t.skip('No Python 3 on this machine.');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-job-'));
  try {
    const script = path.join(dir, 'echo.py');
    await fs.writeFile(script, [
      'import sys',
      'print("argv", sys.argv[1:])',
      'print("in", sys.stdin.read())',
      'print("err", file=sys.stderr)',
      'sys.exit(7)',
    ].join('\n'));
    const result = await createChildRunner({ spawn: childProcess.spawn }).run({
      command: 'python3',
      args: pythonJobArgs(['-B', '-u', script, 'a b', 'c"d']),
      cwd: dir,
      env: process.env,
      stdin: 'hello',
      timeoutMs: 30_000,
      ...LIMITS,
    });

    assert.equal(result.exitCode, 7);
    assert.deepEqual(lines(result.stdout), [`argv ['a b', 'c"d']`, 'in hello']);
    // Without Windows there is no job to make: the run says so and goes on.
    assert.deepEqual(lines(result.stderr), [NOTICE, 'err']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── The runners use them on Windows ──────────────────────────────────────────

test('on Windows the shell runner starts PowerShell with the job, but not its detection', async () => {
  const started = [];
  const service = createShellRunnerService({
    spawn: (command, args) => {
      started.push(args);
      return fakeChild({ stdout: PROBE_MARKER });
    },
    os,
    platform: 'win32',
    env: {},
  });
  await service.detect();
  await service.run({ command: 'npm test' });

  assert.equal(decoded(started[0]).includes(POWERSHELL_JOB), false, 'the detection runs bare');
  assert.equal(decoded(started.at(-1)), withPowerShellJob('npm test'));
});

test('with cmd.exe, the last fallback, the run says that nothing holds its background', async () => {
  const started = [];
  const service = createShellRunnerService({
    spawn: (command, args) => {
      started.push({ command, args });
      // Neither PowerShell answers the detection.
      return fakeChild({ stdout: command === 'cmd.exe' ? PROBE_MARKER : '', code: command === 'cmd.exe' ? 0 : 1 });
    },
    os,
    platform: 'win32',
    env: {},
  });
  await service.detect();
  const result = await service.run({ command: 'dir /b' });

  assert.equal(service.describe().invocation, INVOCATIONS.CMD);
  assert.deepEqual(started.at(-1).args, ['/d', '/s', '/c', 'dir /b']);
  assert.equal(result.stderr, `${NOTICE}\n`);
  assert.equal(noteUncontained('Access is denied.'), `Access is denied.\n${NOTICE}\n`);
});

test('on Windows the Python runner starts the interpreter through the first one', async () => {
  const started = [];
  const service = createPythonRunnerService({
    spawn: (command, args) => {
      started.push([command, ...args]);
      return fakeChild({ stdout: 'Python 3.12.7\n' });
    },
    fs,
    path,
    os,
    env: {},
    readShellPath: async () => '',
    platform: 'win32',
  });
  await service.detect();
  await service.run({ code: 'print(1)', argv: ['x'] });

  const run = started.at(-1);
  assert.deepEqual(run.slice(0, 7), ['py', '-3', '-B', '-c', PYTHON_JOB, '-B', '-u']);
  assert.match(run[7], /script-.+\.py$/);
  assert.equal(run[8], 'x');
});

test('elsewhere nothing changes', async () => {
  const started = [];
  const service = createPythonRunnerService({
    spawn: (command, args) => {
      started.push([command, ...args]);
      return fakeChild({ stdout: 'Python 3.12.7\n' });
    },
    fs,
    path,
    os,
    env: {},
    readShellPath: async () => '',
    platform: 'linux',
  });
  await service.detect();
  await service.run({ code: 'print(1)' });

  assert.deepEqual(started.at(-1).slice(0, 3), ['python3', '-B', '-u']);
});

// ── For real, on Windows ─────────────────────────────────────────────────────

const POWERSHELLS = ['pwsh.exe', 'powershell.exe'];

function hasPowerShell(exe) {
  const probe = childProcess.spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    windowsHide: true,
    timeout: 60_000,
  });
  return !probe.error && probe.status === 0;
}

function runPowerShell(exe, script, { job = true, ...extra } = {}) {
  return createChildRunner({ spawn: childProcess.spawn }).run({
    command: exe,
    args: buildShellArgs(INVOCATIONS.POWERSHELL, job ? withPowerShellJob(script) : script),
    cwd: os.tmpdir(),
    env: process.env,
    timeoutMs: 60_000,
    ...LIMITS,
    ...extra,
  });
}

/** A ping that would run for two minutes, in a window of its own, and its pid. */
const START_PROCESS = "(Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n', '120', '127.0.0.1').Id";

for (const exe of POWERSHELLS) {
  test(`${exe}: a process started in the background ends with the run`, windowsOnly, async (t) => {
    if (!hasPowerShell(exe)) return t.skip(`${exe} is not on this machine`);

    // Without the job the ping stays — the reason for #991.
    const bare = await runPowerShell(exe, START_PROCESS, { job: false });
    const stray = Number(lines(bare.stdout)[0]);
    assert.ok(Number.isInteger(stray) && stray > 0, bare.stdout + bare.stderr);
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      assert.equal(isAlive(stray), true, 'without the job the background process outlives the run');
    } finally {
      try { process.kill(stray); } catch { /* gone */ }
    }

    const result = await runPowerShell(exe, START_PROCESS);
    const pid = Number(lines(result.stdout)[0]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, '', 'the job was made, so there is nothing to say');
    assert.ok(Number.isInteger(pid) && pid > 0, result.stdout);
    await until(() => !isAlive(pid), 'the background process to be gone');
  });

  test(`${exe}: a background process holding the output does not keep the run open`, windowsOnly, async (t) => {
    if (!hasPowerShell(exe)) return t.skip(`${exe} is not on this machine`);

    // cmd shares the shell's console and its output pipe; the run used to
    // wait for the ping, up to the time limit.
    const startedAt = Date.now();
    const result = await runPowerShell(
      exe,
      "(Start-Process -NoNewWindow -PassThru -FilePath cmd.exe -ArgumentList '/d', '/c', 'ping -n 120 127.0.0.1 >nul').Id",
      { timeoutMs: 90_000 },
    );
    const pid = Number(lines(result.stdout)[0]);

    assert.equal(result.timedOut, false);
    assert.ok(Date.now() - startedAt < 30_000, `the run ends with its shell (${Date.now() - startedAt} ms)`);
    assert.ok(Number.isInteger(pid) && pid > 0, result.stdout + result.stderr);
    await until(() => !isAlive(pid), 'the background process to be gone');
  });

  test(`${exe}: the command's exit code and error output come through the job line`, windowsOnly, async (t) => {
    if (!hasPowerShell(exe)) return t.skip(`${exe} is not on this machine`);

    const result = await runPowerShell(exe, "[Console]::Error.WriteLine('note'); exit 3");

    assert.equal(result.exitCode, 3);
    assert.deepEqual(lines(result.stderr), ['note']);
  });
}

test('the shell runner contains a run on Windows', windowsOnly, async (t) => {
  const service = createShellRunnerService({ spawn: childProcess.spawn, os, env: process.env });
  await service.detect();
  if (service.describe().invocation !== INVOCATIONS.POWERSHELL) return t.skip('no PowerShell found');

  const result = await service.run({ command: START_PROCESS, timeoutMs: 60_000 });
  const pid = Number(lines(result.stdout)[0]);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(Number.isInteger(pid) && pid > 0, result.stdout);
  await until(() => !isAlive(pid), 'the background process to be gone');
});

async function readyPython() {
  const service = createPythonRunnerService({ spawn: childProcess.spawn, fs, path, os });
  await service.detect();
  return service.isAvailable() ? service : null;
}

/** A detached ping that would run for two minutes, and its pid. */
const DETACHED_PING = [
  'import subprocess',
  "p = subprocess.Popen(['ping', '-n', '120', '127.0.0.1'],",
  '    creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,',
  '    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
  'print(p.pid)',
].join('\n');

test('Python: a detached process ends with the run', windowsOnly, async (t) => {
  const service = await readyPython();
  if (!service) return t.skip('No Python 3 on this machine.');
  const { command, args = [] } = service.describe();

  // Without the job the ping stays.
  const bare = await createChildRunner({ spawn: childProcess.spawn }).run({
    command,
    args: [...args, '-c', DETACHED_PING],
    cwd: os.tmpdir(),
    env: process.env,
    timeoutMs: 60_000,
    ...LIMITS,
  });
  const stray = Number(lines(bare.stdout)[0]);
  assert.ok(Number.isInteger(stray) && stray > 0, bare.stdout + bare.stderr);
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    assert.equal(isAlive(stray), true, 'without the job the detached process outlives the run');
  } finally {
    try { process.kill(stray); } catch { /* gone */ }
  }

  const result = await service.run({ code: DETACHED_PING, timeoutMs: 60_000 });
  const pid = Number(lines(result.stdout)[0]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '', 'the job was made, so there is nothing to say');
  assert.ok(Number.isInteger(pid) && pid > 0, result.stdout);
  await until(() => !isAlive(pid), 'the detached process to be gone');
});

test('Python: a process cannot leave the job on purpose', windowsOnly, async (t) => {
  const service = await readyPython();
  if (!service) return t.skip('No Python 3 on this machine.');

  const result = await service.run({
    code: [
      'import subprocess',
      'try:',
      "    subprocess.Popen(['cmd', '/c', 'exit'], creationflags=subprocess.CREATE_BREAKAWAY_FROM_JOB).wait()",
      "    print('left')",
      'except OSError as e:',
      "    print('refused', e.winerror)",
    ].join('\n'),
    timeoutMs: 60_000,
  });

  assert.deepEqual(lines(result.stdout), ['refused 5']);
});

test('Python: a crash exit code comes through the first interpreter unchanged', windowsOnly, async (t) => {
  const service = await readyPython();
  if (!service) return t.skip('No Python 3 on this machine.');

  const result = await service.run({ code: 'import os\nos._exit(-1073741819)', timeoutMs: 60_000 });

  assert.equal(result.exitCode, 0xC0000005);
});

// What the job costs at every start (#991), written to the log of the
// Windows runner. Temporary: it measures, it does not test.
test('cost of the job at the start of a run', windowsOnly, async (t) => {
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  async function time(start, rounds = 7) {
    const took = [];
    for (let i = 0; i < rounds; i += 1) {
      const startedAt = process.hrtime.bigint();
      const result = await start();
      took.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
      assert.equal(result.exitCode, 0, result.stderr);
    }
    return median(took);
  }
  for (const exe of POWERSHELLS) {
    if (!hasPowerShell(exe)) continue;
    const bare = await time(() => runPowerShell(exe, 'Write-Output ok', { job: false }));
    const job = await time(() => runPowerShell(exe, 'Write-Output ok'));
    t.diagnostic(`${exe}: ${bare.toFixed(0)} ms bare, ${job.toFixed(0)} ms with the job (+${(job - bare).toFixed(0)} ms)`);
  }
  const service = await readyPython();
  if (service) {
    const { command, args = [] } = service.describe();
    const run = (extra) => createChildRunner({ spawn: childProcess.spawn }).run({
      command, args: [...args, ...extra], cwd: os.tmpdir(), env: process.env, timeoutMs: 60_000, ...LIMITS,
    });
    const bare = await time(() => run(['-B', '-u', '-c', 'pass']));
    const job = await time(() => run(pythonJobArgs(['-B', '-u', '-c', 'pass'])));
    t.diagnostic(`${command} ${args.join(' ')}: ${bare.toFixed(0)} ms bare, ${job.toFixed(0)} ms with the job (+${(job - bare).toFixed(0)} ms)`);
  }
});
