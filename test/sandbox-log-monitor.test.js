// What Seatbelt refused reaches a run through the runtime's macOS log monitor,
// which reads `log stream` (#792). The monitor took one entry per chunk of
// that stream; under load several arrive together, and all but the first were
// lost (#881). scripts/patch-sandbox-runtime.js puts `snotraOnLogEntry` in
// front of it. These tests drive the splitter, the patch, and the installed
// runtime's own monitor with a `log stream` that is only pretended — so they
// run on every platform.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  snotraOnLogEntry, patchLogMonitor, monitorPath, MONITOR_ANCHOR, MONITOR_PATCHED,
} = require('../scripts/patch-sandbox-runtime');

const SUFFIX = '_test1234_SBX';

/** One entry as `log stream --style compact` prints it for a refusal. */
function entry(key, what, pid = 4242) {
  const encoded = Buffer.from(key, 'utf8').toString('base64');
  return `2026-10-11 22:40:41.746 E  kernel[0:164b52d] (Sandbox) Sandbox: sh(${pid}) deny(1) ${what}\n`
    + `CMD64_${encoded}_END_${SUFFIX}\n`;
}

function splitter() {
  const stream = new EventEmitter();
  const seen = [];
  snotraOnLogEntry(stream, (data) => seen.push(String(data)));
  return { send: (text) => stream.emit('data', Buffer.from(text)), seen };
}

// ── The splitter ────────────────────────────────────────────────────────────

test('several entries in one chunk reach the handler one at a time, each with its own command line', () => {
  const { send, seen } = splitter();
  send(`Filtering the log data using "eventMessage ENDSWITH \\"${SUFFIX}\\""\n`
    + 'Timestamp               Ty Process[PID:TID]\n'
    + entry('shell-a', 'file-write-create /outside/escaped.txt')
    + entry('shell-b', 'file-read-data /user-data/secret.txt'));
  assert.equal(seen.length, 2);
  assert.match(seen[0], /deny\(1\) file-write-create \/outside\/escaped\.txt\nCMD64_c2hlbGwtYQ==_END_/);
  assert.match(seen[1], /deny\(1\) file-read-data \/user-data\/secret\.txt\nCMD64_c2hlbGwtYg==_END_/);
});

test('an entry split between two chunks is put together again, wherever the cut is', () => {
  const whole = entry('shell-a', 'file-write-create /outside/escaped.txt');
  for (const cut of [10, whole.indexOf('\n'), whole.indexOf('\n') + 1, whole.length - 5]) {
    const { send, seen } = splitter();
    send(whole.slice(0, cut));
    send(whole.slice(cut));
    assert.deepEqual(seen, [whole.trimEnd()], `cut at ${cut}`);
  }
});

test('a command line is never paired with the deny line of another entry', () => {
  const { send, seen } = splitter();
  const first = entry('shell-a', 'file-write-create /a');
  const second = entry('shell-b', 'file-write-create /b');
  // The first entry's command line arrives together with the second entry.
  const cut = first.indexOf('\n') + 1;
  send(first.slice(0, cut));
  send(first.slice(cut) + second);
  assert.deepEqual(seen, [first.trimEnd(), second.trimEnd()]);
});

test('a deny line whose command line never comes is still handed on, alone', () => {
  const { send, seen } = splitter();
  const orphan = '2026-10-11 22:40:41.700 E  kernel[0:1] (Sandbox) Sandbox: sh(1) deny(1) file-read-data /x\n';
  send(orphan + entry('shell-b', 'file-read-data /y'));
  assert.equal(seen.length, 2);
  assert.equal(seen[0], orphan.trimEnd());
  assert.match(seen[1], /file-read-data \/y\nCMD64_/);
});

test('lines that are not part of a refusal are left out, and no stream is no error', () => {
  const { send, seen } = splitter();
  send('Filtering the log data using "…"\nCMD64_c3RyYXk=_END_x\nsomething else\n');
  assert.deepEqual(seen, []);
  assert.doesNotThrow(() => snotraOnLogEntry(undefined, () => {}));
  assert.doesNotThrow(() => snotraOnLogEntry(null, () => {}));
});

// ── The patch ───────────────────────────────────────────────────────────────

test('the patch replaces the one call, adds the splitter before the source map, and only once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-monitor-patch-'));
  try {
    const file = path.join(dir, 'macos-sandbox-utils.js');
    const original = `export function start() {\n    ${MONITOR_ANCHOR}\n        go(data);\n    });\n}\n//# sourceMappingURL=macos-sandbox-utils.js.map`;
    await fs.writeFile(file, original);
    assert.equal(patchLogMonitor(file), 'patched');
    const patched = await fs.readFile(file, 'utf8');
    assert.ok(patched.includes(MONITOR_PATCHED));
    assert.ok(!patched.includes(MONITOR_ANCHOR));
    assert.ok(patched.includes(snotraOnLogEntry.toString()));
    assert.ok(patched.endsWith('\n//# sourceMappingURL=macos-sandbox-utils.js.map'), 'the source map comment stays last');
    assert.equal(patchLogMonitor(file), 'already');
    assert.equal(await fs.readFile(file, 'utf8'), patched, 'a second run changes nothing');
    await fs.writeFile(file, 'something else entirely');
    assert.equal(patchLogMonitor(file), 'missing');
    assert.equal(await fs.readFile(file, 'utf8'), 'something else entirely');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── The installed runtime ───────────────────────────────────────────────────

test('the installed runtime reads its log through the splitter (scripts/patch-sandbox-runtime.js)', async () => {
  const source = await fs.readFile(monitorPath(), 'utf8');
  assert.ok(source.includes(MONITOR_PATCHED) && source.includes('function snotraOnLogEntry('),
    'The log monitor patched after `npm install` is missing — did an update of @anthropic-ai/sandbox-runtime move it? '
    + 'Without it refusals that arrive together in the log go missing from a run (#881).');
});

/**
 * Runs the installed runtime's own `startMacOSSandboxLogMonitor` against a
 * pretended `log stream` and returns what it reported.
 */
async function withMonitor(feed) {
  const { startMacOSSandboxLogMonitor } = await import(pathToFileURL(monitorPath()).href);
  const fake = new EventEmitter();
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  fake.kill = () => {};
  const original = childProcess.spawn;
  childProcess.spawn = (command) => {
    assert.equal(command, 'log', 'the monitor starts `log stream`');
    return fake;
  };
  syncBuiltinESMExports();
  const reported = [];
  let stop;
  try {
    stop = startMacOSSandboxLogMonitor((v) => reported.push(v), undefined, (key) => key);
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
  try {
    feed((text) => fake.stdout.emit('data', Buffer.from(text)));
  } finally {
    stop?.();
  }
  return reported;
}

test('the runtime reports every refusal of a chunk, each under its own command (#881)', async () => {
  const reported = await withMonitor((send) => {
    send(entry('shell-a', 'file-write-create /outside/escaped.txt')
      + entry('shell-b', 'file-read-data /user-data/secret.txt'));
  });
  assert.deepEqual(reported.map((v) => [v.command, v.line]), [
    ['shell-a', 'sh(4242) deny(1) file-write-create /outside/escaped.txt'],
    ['shell-b', 'sh(4242) deny(1) file-read-data /user-data/secret.txt'],
  ]);
});

test('the runtime keeps a refusal behind a dropped system query, and an entry cut in two under its command', async () => {
  const noise = entry('shell-a', 'mach-lookup com.apple.diagnosticd');
  const refusal = entry('shell-a', 'file-read-data /user-data/secret.txt');
  const cut = refusal.indexOf('\n') + 1;
  const reported = await withMonitor((send) => {
    send(noise + refusal.slice(0, cut));
    send(refusal.slice(cut));
  });
  assert.deepEqual(reported.map((v) => [v.command, v.line]), [
    ['shell-a', 'sh(4242) deny(1) file-read-data /user-data/secret.txt'],
  ]);
});
