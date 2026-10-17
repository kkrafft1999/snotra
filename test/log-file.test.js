const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogFile, teeConsole, formatLine } = require('../src/main/services/log-file');

/** The local log file (#978): written, rotated, read back, and never a reason to throw. */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'logs');
}

const fixedNow = () => new Date('2026-10-17T08:00:00.000Z');

test('the first line creates the folder and the file, with time and level', (t) => {
  const dir = tempDir(t);
  const log = createLogFile({ fs, path, dir, now: fixedNow });
  log.write('error', 'Something broke:', 42);
  const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
  assert.equal(text, '2026-10-17T08:00:00.000Z ERROR Something broke: 42\n');
  assert.equal(log.filePath, path.join(dir, 'main.log'));
});

test('an Error is written with its stack, continuation lines indented', (t) => {
  const dir = tempDir(t);
  const log = createLogFile({ fs, path, dir, now: fixedNow });
  const error = new Error('boom');
  error.stack = 'Error: boom\n    at a (x.js:1:1)\r\n    at b (y.js:2:2)';
  log.write('warn', '[main] Uncaught exception:', error);
  const lines = fs.readFileSync(path.join(dir, 'main.log'), 'utf8').split('\n');
  assert.equal(lines[0], '2026-10-17T08:00:00.000Z WARN  [main] Uncaught exception: Error: boom');
  assert.match(lines[1], /^ {4} {4}at a \(x\.js:1:1\)$/);
  assert.match(lines[2], /^ {4} {4}at b \(y\.js:2:2\)$/);
});

test('past the size limit the file becomes main.old.log and a fresh one starts', (t) => {
  const dir = tempDir(t);
  const line = formatLine(fixedNow().toISOString(), 'info', 'x'.repeat(40));
  const log = createLogFile({ fs, path, dir, maxBytes: Buffer.byteLength(line) * 2, now: fixedNow });
  for (let i = 0; i < 5; i += 1) log.write('info', `${i}`.repeat(40));
  const current = fs.readFileSync(path.join(dir, 'main.log'), 'utf8').trim().split('\n');
  const old = fs.readFileSync(path.join(dir, 'main.old.log'), 'utf8').trim().split('\n');
  assert.equal(current.length, 1, 'the fresh file holds the newest line');
  assert.match(current[0], /4{40}$/);
  assert.equal(old.length, 2);
  assert.match(old[0], /2{40}$/);
});

test('an existing file is continued and counted towards the limit', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.log'), 'y'.repeat(90) + '\n');
  const log = createLogFile({ fs, path, dir, maxBytes: 100, now: fixedNow });
  log.write('info', 'next start');
  assert.ok(fs.existsSync(path.join(dir, 'main.old.log')), 'the earlier start was rotated away');
  assert.match(fs.readFileSync(path.join(dir, 'main.log'), 'utf8'), /next start/);
});

test('tail reads across both files, oldest first', (t) => {
  const dir = tempDir(t);
  const line = formatLine(fixedNow().toISOString(), 'info', 'line 0');
  const log = createLogFile({ fs, path, dir, maxBytes: Buffer.byteLength(line) * 2, now: fixedNow });
  for (let i = 0; i < 4; i += 1) log.write('info', `line ${i}`);
  assert.deepEqual(log.tail(3).map((l) => l.slice(-6)), ['line 1', 'line 2', 'line 3']);
  assert.deepEqual(createLogFile({ fs, path, dir: path.join(dir, 'none') }).tail(5), []);
});

test('a log that cannot be written stays quiet and stops trying', () => {
  let attempts = 0;
  const brokenFs = {
    mkdirSync() {},
    statSync() { throw new Error('ENOENT'); },
    renameSync() {},
    appendFileSync() { attempts += 1; throw new Error('EACCES'); },
    readFileSync() { throw new Error('ENOENT'); },
  };
  const log = createLogFile({ fs: brokenFs, path, dir: '/nowhere' });
  assert.doesNotThrow(() => log.write('error', 'first'));
  assert.doesNotThrow(() => log.write('error', 'second'));
  assert.equal(attempts, 1);
});

test('teeConsole writes warnings and errors to the file and still to the terminal', () => {
  const written = [];
  const printed = [];
  const target = {
    warn: (...args) => printed.push(['warn', ...args]),
    error: (...args) => printed.push(['error', ...args]),
    log: (...args) => printed.push(['log', ...args]),
  };
  const restore = teeConsole(target, { write: (level, ...args) => written.push([level, ...args]) });
  target.warn('careful');
  target.error('broken', 1);
  target.log('chatter');
  assert.deepEqual(written, [['warn', 'careful'], ['error', 'broken', 1]]);
  assert.deepEqual(printed, [['warn', 'careful'], ['error', 'broken', 1], ['log', 'chatter']]);
  restore();
  target.error('after');
  assert.equal(written.length, 2);
});

test('a terminal that fails to print (EPIPE) does not throw out of console.error', () => {
  const target = { warn() {}, error() { throw new Error('EPIPE'); } };
  const written = [];
  teeConsole(target, { write: (level, ...args) => written.push(args) });
  assert.doesNotThrow(() => target.error('still logged'));
  assert.deepEqual(written, [['still logged']]);
});
