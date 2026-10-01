// Replacing a file on Windows can fail while something else holds it (#419).

const test = require('node:test');
const assert = require('node:assert/strict');
const { renameWithRetry, renameSyncWithRetry, readFileWithRetry } = require('../src/main/services/rename-with-retry');

function flakyFs(failures, code = 'EPERM') {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async rename() {
      calls += 1;
      if (calls <= failures) throw Object.assign(new Error(code), { code });
    },
  };
}

const noSleep = async () => {};

test('on Windows a locked target is retried until it is free', async () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const fs = flakyFs(3, code);
    await renameWithRetry(fs, 'a', 'b', { platform: 'win32', sleep: noSleep });
    assert.equal(fs.calls, 4);
  }
});

test('on Windows it gives up after the last attempt with the original error', async () => {
  const fs = flakyFs(10);
  await assert.rejects(renameWithRetry(fs, 'a', 'b', { platform: 'win32', attempts: 3, sleep: noSleep }), { code: 'EPERM' });
  assert.equal(fs.calls, 3);
});

test('elsewhere, and for other errors, the first failure is the answer', async () => {
  const mac = flakyFs(1);
  await assert.rejects(renameWithRetry(mac, 'a', 'b', { platform: 'darwin', sleep: noSleep }), { code: 'EPERM' });
  assert.equal(mac.calls, 1);
  const missing = flakyFs(1, 'ENOENT');
  await assert.rejects(renameWithRetry(missing, 'a', 'b', { platform: 'win32', sleep: noSleep }), { code: 'ENOENT' });
  assert.equal(missing.calls, 1);
});

test('the waits grow with each attempt', async () => {
  const waits = [];
  await renameWithRetry(flakyFs(3), 'a', 'b', { platform: 'win32', delayMs: 10, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [10, 20, 30]);
});

test('a read is retried under the same rules, and a missing file is not (#473)', async () => {
  let calls = 0;
  const fs = {
    async readFile(file, encoding) {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return `${file}:${encoding}`;
    },
  };
  assert.equal(await readFileWithRetry(fs, 'prefs.json', { platform: 'win32', sleep: noSleep }), 'prefs.json:utf8');
  assert.equal(calls, 3);

  const missing = {
    async readFile() {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
  await assert.rejects(readFileWithRetry(missing, 'prefs.json', { platform: 'win32', sleep: noSleep }), { code: 'ENOENT' });
});

// The synchronous variant, for the window state written on `close` (#509).
test('renameSyncWithRetry retries a locked target on Windows and blocks between attempts', () => {
  let calls = 0;
  const fs = {
    renameSync() {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('locked'), { code: 'EACCES' });
    },
  };
  const waits = [];
  renameSyncWithRetry(fs, 'a.tmp', 'a', { platform: 'win32', sleep: (ms) => waits.push(ms) });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [25, 50]);
});

test('renameSyncWithRetry fails at once elsewhere and for other errors', () => {
  const locked = { renameSync() { throw Object.assign(new Error('locked'), { code: 'EPERM' }); } };
  assert.throws(() => renameSyncWithRetry(locked, 'a.tmp', 'a', { platform: 'linux', sleep: () => assert.fail('no wait') }), /locked/);
  const missing = { renameSync() { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } };
  assert.throws(() => renameSyncWithRetry(missing, 'a.tmp', 'a', { platform: 'win32', sleep: () => assert.fail('no wait') }), /gone/);
});

test('renameSyncWithRetry really waits with its default sleep', () => {
  let calls = 0;
  const fs = {
    renameSync() {
      calls += 1;
      if (calls < 2) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    },
  };
  const started = Date.now();
  renameSyncWithRetry(fs, 'a.tmp', 'a', { platform: 'win32', delayMs: 30 });
  assert.ok(Date.now() - started >= 25, 'blocked for the delay');
});
