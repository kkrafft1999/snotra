// The shared skill catalogue cache in src/renderer/chat/skillCatalogSource.js
// (issue #377): one in-flight request, a 5-minute TTL, keyed by workspace root,
// and a generation counter so that a response arriving after invalidate() is
// not cached.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer } = require('./helpers/dom.js');

const TTL_MS = 5 * 60_000;

const skill = (name, status) => ({ name, status });
const ACTIVE = skill('review', 'active');
const AVAILABLE = skill('release', 'available');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A stub API whose calls are counted and answered from a queue or a default. */
function stubApi(answer = () => ({ skills: [ACTIVE] })) {
  const api = {
    calls: 0,
    getSkillCatalog: () => {
      api.calls += 1;
      return answer(api.calls);
    },
  };
  return api;
}

async function createSource({ api, rootPath = '/work/a' } = {}) {
  const { createSkillCatalogSource } = await importRenderer('chat', 'skillCatalogSource.js');
  const appStore = { rootPath };
  return { source: createSkillCatalogSource({ api, appStore }), appStore };
}

test('concurrent load() calls share one fetch', async () => {
  const gate = deferred();
  const api = stubApi(() => gate.promise);
  const { source } = await createSource({ api });

  const first = source.load();
  const second = source.load();
  gate.resolve({ skills: [ACTIVE] });

  assert.deepEqual(await first, [ACTIVE]);
  assert.deepEqual(await second, [ACTIVE]);
  assert.equal(api.calls, 1);
});

test('a cached result is served within the TTL and refetched after it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const api = stubApi((n) => ({ skills: [skill(`s${n}`, 'active')] }));
  const { source } = await createSource({ api });

  assert.deepEqual(await source.load(), [skill('s1', 'active')]);

  t.mock.timers.tick(TTL_MS - 1);
  assert.deepEqual(await source.load(), [skill('s1', 'active')]);
  assert.equal(api.calls, 1, 'still fresh one millisecond before the TTL');

  t.mock.timers.tick(1);
  assert.deepEqual(await source.load(), [skill('s2', 'active')]);
  assert.equal(api.calls, 2, 'refetched once the TTL has passed');
});

test('a change of workspace root refetches, and so does changing back', async () => {
  const api = stubApi(() => ({ skills: [ACTIVE] }));
  const { source, appStore } = await createSource({ api });

  await source.load();
  appStore.rootPath = '/work/b';
  await source.load();
  assert.equal(api.calls, 2);

  appStore.rootPath = '/work/a';
  await source.load();
  assert.equal(api.calls, 3, 'only one root is cached at a time');
});

test('no workspace and an empty root count as the same key', async () => {
  const api = stubApi();
  const { source, appStore } = await createSource({ api, rootPath: null });

  await source.load();
  appStore.rootPath = '';
  await source.load();
  appStore.rootPath = undefined;
  await source.load();
  assert.equal(api.calls, 1);
});

test('a response for the old root is not cached after a root change', async () => {
  const gates = [deferred(), deferred()];
  const api = stubApi((n) => gates[n - 1].promise);
  const { source, appStore } = await createSource({ api });

  const forA = source.load();
  appStore.rootPath = '/work/b';
  const forB = source.load();
  assert.equal(api.calls, 2, 'the new root does not piggyback on the old request');

  gates[0].resolve({ skills: [skill('from-a', 'active')] });
  gates[1].resolve({ skills: [skill('from-b', 'active')] });
  assert.deepEqual(await forA, [skill('from-a', 'active')]);
  assert.deepEqual(await forB, [skill('from-b', 'active')]);

  assert.deepEqual(await source.load(), [skill('from-b', 'active')]);
  assert.equal(api.calls, 2, 'the result for /work/b is the one that was cached');
});

test('invalidate() during a pending fetch does not cache the stale result', async () => {
  const gates = [deferred(), deferred()];
  const api = stubApi((n) => gates[n - 1].promise);
  const { source } = await createSource({ api });

  const stale = source.load();
  source.invalidate();
  const fresh = source.load();
  assert.equal(api.calls, 2, 'a load after invalidate() starts a new fetch');

  gates[1].resolve({ skills: [skill('fresh', 'active')] });
  assert.deepEqual(await fresh, [skill('fresh', 'active')]);

  // The stale answer arrives last; it must neither overwrite the cache nor
  // clear the pending slot of the newer request.
  gates[0].resolve({ skills: [skill('stale', 'active')] });
  assert.deepEqual(await stale, [skill('stale', 'active')], 'the original caller still gets its answer');

  assert.deepEqual(await source.load(), [skill('fresh', 'active')]);
  assert.equal(api.calls, 2);
});

test('invalidate() without a later load leaves nothing cached', async () => {
  const gate = deferred();
  const api = stubApi((n) => (n === 1 ? gate.promise : { skills: [skill('next', 'active')] }));
  const { source } = await createSource({ api });

  const stale = source.load();
  source.invalidate();
  gate.resolve({ skills: [skill('stale', 'active')] });
  await stale;

  assert.deepEqual(await source.load(), [skill('next', 'active')]);
  assert.equal(api.calls, 2);
});

test('invalidate() drops a settled cache and notifies every listener', async () => {
  const api = stubApi();
  const { source } = await createSource({ api });
  await source.load();

  const heard = [];
  source.onInvalidated(() => heard.push('one'));
  const unsubscribe = source.onInvalidated(() => heard.push('two'));

  source.invalidate();
  assert.deepEqual(heard, ['one', 'two']);

  unsubscribe();
  source.invalidate();
  assert.deepEqual(heard, ['one', 'two', 'one'], 'an unsubscribed listener stays quiet');

  await source.load();
  assert.equal(api.calls, 2, 'the cache was dropped');
});

test('only ACTIVE and AVAILABLE skills are returned', async () => {
  const api = stubApi(() => ({
    skills: [
      ACTIVE,
      skill('hidden', 'shadowed'),
      AVAILABLE,
      skill('broken', 'invalid'),
      skill('no-status'),
      null,
    ],
  }));
  const { source } = await createSource({ api });
  assert.deepEqual(await source.load(), [ACTIVE, AVAILABLE]);
});

test('an API that throws or answers oddly yields an empty list', async () => {
  for (const answer of [
    () => { throw new Error('ipc down'); },
    () => Promise.reject(new Error('ipc down')),
    () => undefined,
    () => ({ skills: 'nope' }),
  ]) {
    const { source } = await createSource({ api: stubApi(answer) });
    assert.deepEqual(await source.load(), []);
  }
});

test('without getSkillCatalog on the API, load() yields an empty list', async () => {
  for (const api of [undefined, null, {}]) {
    const { source } = await createSource({ api });
    assert.deepEqual(await source.load(), []);
  }
});
