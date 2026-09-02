const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createUpdateService,
  parseSemver,
  compareSemver,
  isNewerVersion,
} = require('../src/main/services/update-service');

test('parseSemver tolerates leading v and prerelease', () => {
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '' });
  assert.deepEqual(parseSemver('v2.0.0'), { major: 2, minor: 0, patch: 0, prerelease: '' });
  assert.deepEqual(parseSemver('1.2.3-beta.1'), { major: 1, minor: 2, patch: 3, prerelease: 'beta.1' });
  assert.equal(parseSemver('nonsense'), null);
  assert.equal(parseSemver(undefined), null);
});

test('compareSemver orders major/minor/patch', () => {
  assert.equal(compareSemver('1.0.0', '2.0.0'), -1);
  assert.equal(compareSemver('1.2.0', '1.1.9'), 1);
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0);
});

test('compareSemver treats release as higher than its prerelease', () => {
  assert.equal(compareSemver('1.2.3', '1.2.3-beta.1'), 1);
  assert.equal(compareSemver('1.2.3-beta.1', '1.2.3-beta.2'), -1);
  assert.equal(compareSemver('1.2.3-alpha', '1.2.3-alpha.1'), -1);
});

test('isNewerVersion only true for a strictly higher version', () => {
  assert.equal(isNewerVersion('1.1.0', '1.0.0'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('0.9.0', '1.0.0'), false);
});

function makeStorage(initial = {}) {
  let prefs = { ...initial };
  return {
    async readUIPrefs() { return { ...prefs }; },
    async updateUIPrefs(updater) { prefs = await updater({ ...prefs }); return prefs; },
    _prefs: () => prefs,
  };
}

const app = { getVersion: () => '1.0.0' };

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; } };
}

test('checkForUpdate reports an available update', async () => {
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    fetchImpl: async () => jsonResponse({
      tag_name: 'v1.4.0',
      html_url: 'https://example.test/releases/v1.4.0',
      published_at: '2026-06-01T00:00:00Z',
      body: 'Neue Sachen',
    }),
  });
  const res = await svc.checkForUpdate();
  assert.equal(res.updateAvailable, true);
  assert.equal(res.latestVersion, '1.4.0');
  assert.equal(res.currentVersion, '1.0.0');
  assert.equal(res.releaseUrl, 'https://example.test/releases/v1.4.0');
});

test('checkForUpdate reports no update when current is latest', async () => {
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    fetchImpl: async () => jsonResponse({ tag_name: 'v1.0.0' }),
  });
  const res = await svc.checkForUpdate();
  assert.equal(res.updateAvailable, false);
});

test('respectIgnored suppresses a skipped version, manual check still shows it', async () => {
  const storage = makeStorage({ ignoredUpdateVersion: '1.4.0' });
  const svc = createUpdateService({
    app,
    storage,
    fetchImpl: async () => jsonResponse({ tag_name: 'v1.4.0' }),
  });
  assert.equal((await svc.checkForUpdate({ respectIgnored: true })).updateAvailable, false);
  assert.equal((await svc.checkForUpdate({ respectIgnored: false })).updateAvailable, true);
});

test('ignoreVersion persists into UI prefs', async () => {
  const storage = makeStorage();
  const svc = createUpdateService({ app, storage });
  const res = await svc.ignoreVersion('1.4.0');
  assert.equal(res.ok, true);
  assert.equal(storage._prefs().ignoredUpdateVersion, '1.4.0');
});

test('checkForUpdate never throws on network failure', async () => {
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    fetchImpl: async () => { throw Object.assign(new Error('boom'), { cause: 'ECONNREFUSED' }); },
  });
  const res = await svc.checkForUpdate();
  assert.equal(res.updateAvailable, false);
  assert.ok(res.error);
});

test('checkForUpdate handles a non-OK HTTP response', async () => {
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    fetchImpl: async () => jsonResponse({}, false, 404),
  });
  const res = await svc.checkForUpdate();
  assert.equal(res.updateAvailable, false);
  assert.match(res.error, /404/);
});

test('checkForUpdate ignores a draft release', async () => {
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    fetchImpl: async () => jsonResponse({ tag_name: 'v2.0.0', draft: true }),
  });
  const res = await svc.checkForUpdate();
  assert.equal(res.updateAvailable, false);
});

test('checkForUpdate targets the Snotra repo with a Snotra User-Agent by default', async () => {
  const calls = [];
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse({ tag_name: 'v1.0.0', html_url: 'https://example.test/r', published_at: '2026-06-01T00:00:00Z', body: '' });
    },
  });
  await svc.checkForUpdate();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/kkrafft1999/snotra/releases/latest');
  assert.match(calls[0].opts.headers['User-Agent'], /^Snotra-AI-/);
});
