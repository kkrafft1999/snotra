'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { readRegularFile } = require('../src/main/services/read-regular-file');

const POSIX = process.platform !== 'win32';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-regular-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Fails the test instead of hanging the run when a read blocks. */
function within(ms, promise) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    }),
  ]);
}

test('a regular file is read completely', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'a.txt');
  await fs.writeFile(file, 'hello\n');
  const result = await readRegularFile(fs, file);
  assert.equal(result.buffer.toString('utf8'), 'hello\n');
  assert.equal(result.stats.size, 6);
});

test('an empty file and a file larger than one chunk are read exactly', async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, 'empty'), '');
  const big = Buffer.alloc(3 * 1024 * 1024 + 7, 0x61);
  await fs.writeFile(path.join(dir, 'big'), big);
  assert.equal((await readRegularFile(fs, path.join(dir, 'empty'))).buffer.length, 0);
  assert.ok((await readRegularFile(fs, path.join(dir, 'big'))).buffer.equals(big));
});

test('a file above maxBytes is reported, not read', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'a.txt');
  await fs.writeFile(file, '0123456789');
  assert.equal((await readRegularFile(fs, file, { maxBytes: 9 })).tooLarge, true);
  assert.equal((await readRegularFile(fs, file, { maxBytes: 10 })).buffer.length, 10);
});

test('a folder is not a regular file', async (t) => {
  const dir = await tempDir(t);
  assert.equal((await readRegularFile(fs, dir)).notFile, true);
});

test('a missing file throws ENOENT', async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(readRegularFile(fs, path.join(dir, 'nope')), { code: 'ENOENT' });
});

test('a named pipe is refused at once instead of blocking', { skip: !POSIX }, async (t) => {
  const dir = await tempDir(t);
  const fifo = path.join(dir, 'pipe.txt');
  execFileSync('mkfifo', [fifo]);
  const result = await within(1000, readRegularFile(fs, fifo));
  assert.equal(result.notFile, true);
});

test('a socket is refused at once', { skip: !POSIX }, async (t) => {
  const dir = await tempDir(t);
  const sock = path.join(dir, 's.sock');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(sock, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await within(1000, readRegularFile(fs, sock));
  assert.equal(result.notFile, true);
});
