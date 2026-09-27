// Replacing a file on Windows can fail while something else holds it (#419).

const test = require('node:test');
const assert = require('node:assert/strict');
const { renameWithRetry } = require('../src/main/services/rename-with-retry');

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
