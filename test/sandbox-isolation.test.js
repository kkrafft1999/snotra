// The real sandbox (#329): the acceptance criteria of the issue, run through
// the shell runner exactly as shell_execute would run them.
//
// Where isolation is not available — Windows, Linux without bubblewrap/socat/
// ripgrep, restricted user namespaces, or a test process that is itself
// sandboxed — the tests are skipped. The test gate sets
// SNOTRA_REQUIRE_SANDBOX=1 on macOS and Linux, and there a missing sandbox
// fails instead: a skipped isolation test must not pass for a green one.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const net = require('net');
const fs = require('fs').promises;
const { existsSync } = require('fs');
const path = require('path');
const os = require('os');

const { createSandboxService } = require('../src/main/services/sandbox-service');
const { createShellRunnerService } = require('../src/main/services/shell-runner-service');

const REQUIRED = process.env.SNOTRA_REQUIRE_SANDBOX === '1';

let setup = null;

async function ready(t) {
  if (process.platform === 'win32') {
    t.skip('no sandbox on Windows');
    return null;
  }
  if (!setup) {
    setup = (async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-isolation-'));
      const workspace = path.join(base, 'workspace');
      const outside = path.join(base, 'outside');
      const userData = path.join(base, 'user-data');
      for (const dir of [workspace, outside, userData]) await fs.mkdir(dir);
      await fs.writeFile(path.join(userData, 'secret.txt'), 'top secret');
      await fs.writeFile(path.join(outside, 'readable.txt'), 'fine');

      let shellRunner = null;
      const sandbox = createSandboxService({
        os, path, fs, existsSync,
        spawn: childProcess.spawn,
        userDataPath: userData,
        readShellPath: async () => (await shellRunner.detect()).path || '',
      });
      shellRunner = createShellRunnerService({ spawn: childProcess.spawn, os, fs, path, sandbox });
      await shellRunner.detect();
      const described = await sandbox.detect();
      return { base, workspace, outside, userData, sandbox, shellRunner, described };
    })();
  }
  const ctx = await setup;
  if (!ctx.shellRunner.isAvailable()) {
    t.skip('no shell');
    return null;
  }
  if (!ctx.described.isolated) {
    const why = `sandbox not available: ${ctx.described.reason} ${ctx.described.detail}`.trim();
    if (REQUIRED) assert.fail(why);
    t.skip(why);
    return null;
  }
  return ctx;
}

/** Whether something accepts a TCP connection on 127.0.0.1:port. */
function reachable(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(2_000);
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

function run(ctx, command, extra = {}) {
  return ctx.shellRunner.run({ command, cwd: ctx.workspace, workspaceRoot: ctx.workspace, ...extra });
}

test.after(async () => {
  if (!setup) return;
  const ctx = await setup;
  await ctx.sandbox.shutdown();
  await fs.rm(ctx.base, { recursive: true, force: true });
});

test('a run writes inside the workspace, and nowhere outside it', async (t) => {
  const ctx = await ready(t);
  if (!ctx) return;
  const outsideFile = path.join(ctx.outside, 'escaped.txt');

  const inside = await run(ctx, 'echo hello > inside.txt && cat inside.txt');
  const outside = await run(ctx, `echo nope > '${outsideFile}'`);

  assert.equal(inside.exitCode, 0, inside.stderr);
  assert.equal(inside.stdout.trim(), 'hello');
  assert.deepEqual(inside.isolation, { isolated: true, domains: [] });
  assert.notEqual(outside.exitCode, 0);
  assert.equal(existsSync(outsideFile), false);
});

test('the run’s own temp dir is writable and redirected caches point there', async (t) => {
  const ctx = await ready(t);
  if (!ctx) return;

  const result = await run(
    ctx,
    'echo x > "$TMPDIR/t.txt" && python3 -c "import tempfile; tempfile.mkstemp()" '
      + '&& mkdir -p "$PIP_CACHE_DIR" && echo "$TMPDIR" && echo "$PIP_CACHE_DIR"',
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const [tmpdir, pipCache] = result.stdout.trim().split('\n');
  assert.match(tmpdir, /snotra-sh-/);
  assert.ok(pipCache.startsWith(tmpdir), pipCache);
});

test('denied locations cannot be read — ordinary files can', async (t) => {
  const ctx = await ready(t);
  if (!ctx) return;

  const secret = await run(ctx, `cat '${path.join(ctx.userData, 'secret.txt')}'`);
  const readable = await run(ctx, `cat '${path.join(ctx.outside, 'readable.txt')}'`);

  assert.notEqual(secret.exitCode, 0);
  assert.doesNotMatch(secret.stdout, /top secret/);
  assert.equal(readable.exitCode, 0, readable.stderr);
  assert.equal(readable.stdout.trim(), 'fine');
});

test('no network unless a domain is allowed — an allowed domain works', async (t) => {
  const ctx = await ready(t);
  if (!ctx) return;
  const curl = 'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://example.com';

  let blocked = await run(ctx, curl, { timeoutMs: 30_000 });
  // Seen once in ~240 macOS CI jobs (#368): curl did not reach the proxy at
  // all. Nothing got out, and the run now says so itself. Whether the proxy
  // was listening at that moment tells a dead proxy from a refused connect,
  // so the test records it — and tries once more. A proxy that stays out of
  // reach still fails the assertion below.
  const unreachable = blocked.stderr.match(/<sandbox_network>[^]*?localhost:(\d+)/);
  if (unreachable) {
    assert.notEqual(blocked.exitCode, 0);
    const listening = await reachable(Number(unreachable[1]));
    t.diagnostic(`proxy not reached, listening from outside the sandbox: ${listening}; stderr: ${blocked.stderr}`);
    blocked = await run(ctx, curl, { timeoutMs: 30_000 });
  }
  const allowed = await run(ctx, curl, { networkDomains: ['example.com'], timeoutMs: 30_000 });

  assert.notEqual(blocked.exitCode, 0);
  // The model learns what was refused, not just that curl failed.
  assert.match(blocked.stderr, /sandbox_violations|403|denied|not permitted/i);
  assert.equal(allowed.exitCode, 0, allowed.stderr);
  assert.match(allowed.stdout, /^[23]\d\d$/);
  assert.deepEqual(allowed.isolation, { isolated: true, domains: ['example.com'] });
});

test('time limit and "Stop" still end the whole process tree', async (t) => {
  const ctx = await ready(t);
  if (!ctx) return;
  const marker = 30_000 + Math.floor(Math.random() * 9_000);
  const tree = `sleep ${marker} & sleep ${marker} & wait`;
  const alive = () => {
    try {
      return childProcess.execFileSync('pgrep', ['-f', `sleep ${marker}`], { encoding: 'utf8' }).trim().length > 0;
    } catch {
      return false;
    }
  };

  const timed = await run(ctx, tree, { timeoutMs: 1_500 });
  assert.equal(timed.timedOut, true);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1_500);
  const stopped = await run(ctx, tree, { abortSignal: controller.signal, timeoutMs: 60_000 });
  assert.equal(stopped.aborted, true);

  await new Promise((r) => setTimeout(r, 500));
  assert.equal(alive(), false, 'no sleep of the tree survives');
});
