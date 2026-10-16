'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { writeFileAtomic } = require('../src/main/services/atomic-write');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-atomic-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** fs/promises that records open, sync and rename in the order they happen. */
function recordingFs(steps, { failSync = false, failRename = false } = {}) {
  return {
    ...fs,
    async open(file, ...rest) {
      const handle = await fs.open(file, ...rest);
      steps.push(['open', path.basename(file)]);
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        steps.push(['sync']);
        if (failSync) throw new Error('simulated flush failure');
        return realSync();
      };
      return handle;
    },
    async rename(from, to) {
      steps.push(['rename', path.basename(to)]);
      if (failRename) throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
      return fs.rename(from, to);
    },
  };
}

test('writeFileAtomic flushes the temporary file before it renames it over the target (#1013)', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'store.json');
  await fs.writeFile(target, 'old');
  const steps = [];

  await writeFileAtomic(recordingFs(steps), target, '{"new":true}');

  assert.equal(await fs.readFile(target, 'utf8'), '{"new":true}');
  assert.deepEqual(steps.map(([step]) => step), ['open', 'sync', 'rename']);
  assert.match(steps[0][1], /^store\.json\.tmp-/);
  assert.deepEqual(await fs.readdir(dir), ['store.json']);
});

test('writeFileAtomic leaves the target and no temporary file behind when the flush fails', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'store.json');
  await fs.writeFile(target, 'old');

  await assert.rejects(() => writeFileAtomic(recordingFs([], { failSync: true }), target, 'new'), /flush failure/);

  assert.equal(await fs.readFile(target, 'utf8'), 'old');
  assert.deepEqual(await fs.readdir(dir), ['store.json']);
});

test('writeFileAtomic removes the temporary file when the rename fails', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'store.json');

  await assert.rejects(() => writeFileAtomic(recordingFs([], { failRename: true }), target, 'new'), /rename failure/);

  assert.deepEqual(await fs.readdir(dir), []);
});

test('writeFileAtomic creates a new file with the requested mode and writes buffers as they are', {
  skip: process.platform === 'win32' ? 'POSIX file modes' : false,
}, async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'key');
  const bytes = Buffer.from([0, 1, 2, 255]);

  await writeFileAtomic(fs, target, bytes, { mode: 0o600 });

  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
});
