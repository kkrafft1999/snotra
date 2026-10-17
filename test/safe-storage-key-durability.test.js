// When the key behind safeStorage has reached the disk (#1060). On Windows it
// lives in Chromium's `Local State`, which a fresh profile gets on disk only
// seconds after the start; the stores hold their first ciphertext until then.
// The platform, the file and the clock are simulated, so this runs anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSafeStorageKeyDurability,
  KEY_ALWAYS_DURABLE,
  KEY_POLL_MS,
  KEY_WAIT_CAP_MS,
} = require('../src/main/services/safe-storage-key-durability');
const { settle } = require('./helpers/held-safe-storage-key');

const LOCAL_STATE = 'C:\\Users\\someone\\AppData\\Roaming\\Snotra AI\\Local State';
const WITH_KEY = JSON.stringify({ os_crypt: { encrypted_key: 'RFBBUEkBAAAA0Iyd3wEV0RGMegDAT8KX6wEAAAA=' }, other: 1 });

/** `Local State` as the test sets it, a clock and timers that move only when told. */
function simulate({ platform = 'win32', localState = null } = {}) {
  let content = localState;
  let clock = 1_000;
  let timers = [];
  const reads = [];
  const logs = { warn: [], info: [] };
  const durability = createSafeStorageKeyDurability({
    platform,
    localStatePath: () => LOCAL_STATE,
    readFile: async (filePath) => {
      reads.push(filePath);
      if (content instanceof Error) throw content;
      if (content === null) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      return content;
    },
    log: { warn: (line) => logs.warn.push(line), info: (line) => logs.info.push(line) },
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock + ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timers = timers.filter((t) => t !== timer);
    },
  });
  return {
    durability,
    reads,
    logs,
    get timers() {
      return timers.length;
    },
    setLocalState(next) {
      content = next;
    },
    /** Moves the clock on and runs every timer due by then. */
    async advance(ms) {
      const until = clock + ms;
      for (;;) {
        await settle();
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        clock = due.at;
        due.fn();
      }
      clock = until;
      await settle();
    },
  };
}

/** Whether the promise has settled yet, without waiting for it. */
async function isResolved(promise) {
  let done = false;
  promise.then(() => {
    done = true;
  });
  await settle();
  return done;
}

test('macOS and Linux never wait and never read Local State', async () => {
  for (const platform of ['darwin', 'linux']) {
    const sim = simulate({ platform });
    assert.equal(sim.durability, KEY_ALWAYS_DURABLE, platform);
    assert.equal(sim.durability.wouldWait(), false, platform);
    assert.equal(await isResolved(sim.durability.whenDurable()), true, platform);
    assert.deepEqual(sim.reads, [], platform);
    assert.equal(sim.timers, 0, platform);
  }
});

test('a later start finds the key at the first look, and nothing waits', async () => {
  const sim = simulate({ localState: WITH_KEY });
  await settle();
  assert.equal(sim.durability.wouldWait(), false, 'known before any write asks');
  assert.deepEqual(sim.reads, [LOCAL_STATE]);
  assert.equal(await isResolved(sim.durability.whenDurable()), true);
  assert.equal(sim.timers, 0, 'no polling');
  assert.equal(sim.reads.length, 1, 'no second look');
  assert.deepEqual(sim.logs, { warn: [], info: [] });
});

test('a write asking before the first look has finished does not wait for nothing', async () => {
  const sim = simulate({ localState: WITH_KEY });
  const pending = sim.durability.whenDurable();
  assert.equal(await isResolved(pending), true);
  assert.equal(sim.reads.length, 1, 'the first look is shared');
});

test('on a fresh profile a write waits until Chromium has written the key', async () => {
  const sim = simulate({ localState: null });
  await settle();
  assert.equal(sim.durability.wouldWait(), true);
  assert.equal(sim.timers, 0, 'nobody waits yet: no polling');

  const first = sim.durability.whenDurable();
  const second = sim.durability.whenDurable();
  await sim.advance(KEY_POLL_MS * 3);
  assert.equal(await isResolved(first), false, 'still no Local State');

  // Chromium writes the file on its commit timer, with the key in it.
  sim.setLocalState(WITH_KEY);
  await sim.advance(KEY_POLL_MS);
  assert.equal(await isResolved(first), true);
  assert.equal(await isResolved(second), true);
  assert.equal(sim.durability.wouldWait(), false);
  assert.equal(sim.timers, 0, 'polling stops');
  assert.equal(sim.logs.info.length, 1);
  assert.match(sim.logs.info[0], /reached Local State after 1\.0 s/);

  const readsSoFar = sim.reads.length;
  assert.equal(await isResolved(sim.durability.whenDurable()), true, 'later writes go at once');
  assert.equal(sim.reads.length, readsSoFar);
});

test('a Local State without the key, or not JSON, or held for a moment, is not the key', async () => {
  const states = [
    JSON.stringify({ browser: { enabled_labs_experiments: [] } }),
    JSON.stringify({ os_crypt: {} }),
    JSON.stringify({ os_crypt: { encrypted_key: '' } }),
    JSON.stringify({ os_crypt: { encrypted_key: 42 } }),
    JSON.stringify(null),
    '{"os_crypt": {"encrypted_k',
    Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }),
  ];
  for (const state of states) {
    const sim = simulate({ localState: state });
    const pending = sim.durability.whenDurable();
    await sim.advance(KEY_POLL_MS * 4);
    assert.equal(await isResolved(pending), false, String(state));
    assert.equal(sim.durability.wouldWait(), true, String(state));
    sim.setLocalState(WITH_KEY);
    await sim.advance(KEY_POLL_MS);
    assert.equal(await isResolved(pending), true, String(state));
  }
});

test('the wait ends at the cap with a warning, and nothing waits after it', async () => {
  const sim = simulate({ localState: null });
  const pending = sim.durability.whenDurable();
  await sim.advance(KEY_WAIT_CAP_MS - KEY_POLL_MS);
  assert.equal(await isResolved(pending), false, 'not before the cap');

  await sim.advance(KEY_POLL_MS);
  assert.equal(await isResolved(pending), true);
  assert.equal(sim.durability.wouldWait(), false);
  assert.equal(sim.timers, 0);
  assert.equal(sim.logs.warn.length, 1);
  assert.match(sim.logs.warn[0], /No encryption key in Local State 20 s after the start/);

  const readsSoFar = sim.reads.length;
  assert.equal(await isResolved(sim.durability.whenDurable()), true);
  assert.equal(sim.reads.length, readsSoFar, 'no more looking');
  assert.equal(sim.logs.warn.length, 1, 'warned once');
});

test('a first write after the cap looks once and goes ahead', async () => {
  const sim = simulate({ localState: null });
  await sim.advance(KEY_WAIT_CAP_MS + 5_000);
  assert.equal(sim.reads.length, 1, 'only the first look while nobody waited');
  const pending = sim.durability.whenDurable();
  assert.equal(await isResolved(pending), true);
  assert.equal(sim.reads.length, 2);
  assert.equal(sim.logs.warn.length, 1);
});

test('an orderly quit lets the held writes go, since the quit writes the key', async () => {
  const sim = simulate({ localState: null });
  const pending = sim.durability.whenDurable();
  await sim.advance(KEY_POLL_MS * 2);
  sim.durability.releaseForQuit();
  assert.equal(await isResolved(pending), true);
  assert.equal(sim.durability.wouldWait(), false);
  assert.equal(sim.timers, 0, 'polling stops');
  assert.equal(sim.logs.warn.length, 0);
  assert.match(sim.logs.info[0], /Quit after 0\.5 s of waiting/);
  sim.durability.releaseForQuit();
  assert.equal(sim.logs.info.length, 1, 'a second quit says nothing more');
});

test('a quit while nobody waits says nothing', async () => {
  const sim = simulate({ localState: null });
  await settle();
  sim.durability.releaseForQuit();
  assert.equal(await isResolved(sim.durability.whenDurable()), true);
  assert.deepEqual(sim.logs, { warn: [], info: [] });
});
