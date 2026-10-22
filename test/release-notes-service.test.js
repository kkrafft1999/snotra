const test = require('node:test');
const assert = require('node:assert/strict');
const { createReleaseNotesService, normalizeVersion } = require('../src/main/services/release-notes-service');
const { userReleaseNotes } = require('../src/shared/runtime/release-notes');
const { createWorkspaceToolRegistry } = require('../src/application/tools/workspace-tool-registry');

// #1191: the model answers "What has changed since X.Y.Z?" from the notes of
// the releases. GitHub is a fake list here; no test reaches the network.

const notes = (en, de) => [
  '<!-- snotra:notes en -->', en, '<!-- snotra:notes de -->', de, '<!-- snotra:notes end -->',
  '', "## What's Changed", '* Measure the performance budgets (#984)',
].join('\r\n');

const RELEASES = [
  { tag_name: 'v1.27.1-winsign.1', prerelease: true, draft: false, published_at: '2026-10-21T15:37:06Z', body: notes('- rc', '- rc') },
  { tag_name: 'v1.27.1', published_at: '2026-10-19T18:37:56Z', html_url: 'https://github.com/x/y/releases/tag/v1.27.1', body: notes('- **Fixed markers.**', '- **Markierungen behoben.**') },
  { tag_name: 'v1.27.0', published_at: '2026-10-18T20:56:11Z', body: notes('- **Images for Gemini.**', '- **Bilder für Gemini.**') },
  { tag_name: 'v1.26.0', published_at: '2026-10-17T10:00:00Z', body: notes('- **English only.**', '') },
  { tag_name: 'v1.25.0', published_at: '2026-10-16T10:00:00Z', body: notes('- **First notes.**', '- **Erste Hinweise.**') },
  { tag_name: 'v1.24.1', published_at: '2026-10-15T10:00:00Z', body: "## What's Changed\n* Fix a test (#1)" },
  { tag_name: 'v1.24.0', published_at: '2026-10-14T10:00:00Z', body: '' },
  { tag_name: 'v1.23.0', draft: true, published_at: '2026-10-13T10:00:00Z', body: notes('- draft', '- Entwurf') },
];

/** @param {{ status?: number, headers?: Record<string, string>, fail?: boolean, releases?: unknown[] }} [options] */
function fakeGithub({ status = 200, headers = {}, fail = false, releases = RELEASES } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (fail) throw new TypeError('fetch failed');
    return {
      ok: status === 200,
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      json: async () => (new URL(url).searchParams.get('page') === '1' ? releases : []),
    };
  };
  return { fetchImpl, calls };
}

function makeService(options = {}, { version = '1.27.1', locale = 'en', now } = {}) {
  const github = fakeGithub(options);
  const service = createReleaseNotesService({
    fetchImpl: github.fetchImpl,
    getCurrentVersion: () => version,
    getLocale: () => locale,
    log: { warn() {} },
    ...(now ? { now } : {}),
  });
  return { service, ...github };
}

test('the user section is cut out in the language, English stands in for a missing one', () => {
  const body = notes('- **Bold** and `code`', '- **Fett** und `Code`');
  assert.equal(userReleaseNotes(body, 'de', 'en'), '- **Fett** und `Code`');
  assert.equal(userReleaseNotes(body, 'fr', 'en'), '- **Bold** and `code`');
  assert.equal(userReleaseNotes(body, 'fr', 'fr'), '');
  assert.equal(userReleaseNotes("## What's Changed\n* x", 'en', 'en'), '');
  assert.equal(userReleaseNotes(undefined, 'en', 'en'), '');
});

test('versions are taken the way people write them', () => {
  assert.equal(normalizeVersion('1.24'), '1.24.0');
  assert.equal(normalizeVersion('v1.24.1'), '1.24.1');
  assert.equal(normalizeVersion(' 1.24.1 '), '1.24.1');
  assert.equal(normalizeVersion('1.24.1-rc.1'), null);
  assert.equal(normalizeVersion('latest'), null);
  assert.equal(normalizeVersion(undefined), null);
});

test('"since 1.25.0" lists every release after it up to the installed one, newest first', async () => {
  const { service } = makeService();
  const answer = await service.read({ from: '1.25.0' });
  assert.deepEqual(answer.releases.map((r) => r.version), ['1.27.1', '1.27.0', '1.26.0']);
  assert.equal(answer.from, '1.25.0');
  assert.equal(answer.to, '1.27.1');
  assert.equal(answer.installedVersion, '1.27.1');
  assert.equal(answer.releases[0].date, '2026-10-19');
  assert.equal(answer.releases[0].url, 'https://github.com/x/y/releases/tag/v1.27.1');
  assert.equal(answer.releases[0].notes, '- **Fixed markers.**');
  assert.equal(answer.note, undefined);
});

test('without `from` it is the installed version alone — a pre-release is never part of it', async () => {
  const { service } = makeService();
  const answer = await service.read({});
  assert.deepEqual(answer.releases.map((r) => r.version), ['1.27.1']);
  assert.equal(answer.latestVersion, '1.27.1');
});

test('`to` ends the range inclusive; "latest" asks for the newest release', async () => {
  const older = makeService({}, { version: '1.26.0' });
  const asked = await older.service.read({ from: '1.24.1', to: '1.27.0' });
  assert.deepEqual(asked.releases.map((r) => r.version), ['1.27.0', '1.26.0', '1.25.0']);

  const updates = await older.service.read({ from: '1.26.0', to: 'latest' });
  assert.deepEqual(updates.releases.map((r) => r.version), ['1.27.1', '1.27.0']);
  assert.equal(updates.to, '1.27.1');
});

test('the German UI gets German notes and English where a release has none', async () => {
  const { service } = makeService({}, { locale: 'de' });
  const answer = await service.read({ from: '1.24.1' });
  const byVersion = Object.fromEntries(answer.releases.map((r) => [r.version, r]));
  assert.equal(byVersion['1.27.1'].notes, '- **Markierungen behoben.**');
  assert.equal(byVersion['1.27.1'].notesLanguage, 'de');
  assert.equal(byVersion['1.26.0'].notes, '- **English only.**');
  assert.equal(byVersion['1.26.0'].notesLanguage, 'en');
  assert.equal(answer.language, 'de');
  // The tool call's own language wins over the app's.
  const english = await service.read({ from: '1.26.0', locale: 'en' });
  assert.equal(english.releases[0].notes, '- **Fixed markers.**');
});

test('releases before the notes started are named, not filled in', async () => {
  const { service } = makeService();
  const answer = await service.read({ from: '1.23.0' });
  assert.deepEqual(answer.versionsWithoutUserNotes, ['1.24.1', '1.24.0']);
  assert.deepEqual(answer.releases.map((r) => r.version), ['1.27.1', '1.27.0', '1.26.0', '1.25.0']);
  assert.match(answer.note, /1\.24\.1, 1\.24\.0/);
  assert.match(answer.note, /start with 1\.25\.0/);
  assert.doesNotMatch(JSON.stringify(answer), /Fix a test/);
});

test('a version without a release, and a range that is empty, say so', async () => {
  const dev = makeService({}, { version: '1.28.0' });
  const answer = await dev.service.read({ from: '1.27.0' });
  assert.match(answer.note, /1\.28\.0 has no published release/);
  assert.deepEqual(answer.releases.map((r) => r.version), ['1.27.1']);

  const same = await makeService().service.read({ from: '1.27.1' });
  assert.deepEqual(same.releases, []);
  assert.match(same.note, /no release after 1\.27\.1/);
});

test('a version that is not one is refused with its reason', async () => {
  const { service, calls } = makeService();
  assert.match((await service.read({ from: 'last week' })).error, /not a version number/);
  assert.match((await service.read({ to: 'soon' })).error, /not a version number/);
  assert.equal(calls.length, 0);
});

test('an unreachable GitHub is an answer of its own', async () => {
  const { service } = makeService({ fail: true });
  const answer = await service.read({ from: '1.25.0' });
  assert.equal(answer.reason, 'offline');
  assert.match(answer.error, /could not be read/);
  assert.match(answer.error, /Do not list changes from memory/);
  assert.equal(answer.releases, undefined);
});

test('GitHub\'s rate limit and other refusals are told apart', async () => {
  const limited = await makeService({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }).service.read({});
  assert.equal(limited.reason, 'rate-limit');
  const refused = await makeService({ status: 500 }).service.read({});
  assert.equal(refused.reason, 'http');
});

test('a second question reads the list once; a failure afterwards falls back to it, marked', async () => {
  let clock = 1_000_000;
  let online = true;
  const github = fakeGithub();
  const service = createReleaseNotesService({
    fetchImpl: (url) => (online ? github.fetchImpl(url) : Promise.reject(new TypeError('fetch failed'))),
    getCurrentVersion: () => '1.27.1',
    getLocale: () => 'en',
    log: { warn() {} },
    now: () => clock,
  });
  await service.read({ from: '1.25.0' });
  await service.read({ from: '1.26.0' });
  assert.equal(github.calls.length, 1);

  // The cache ran out and GitHub is gone: the earlier list answers, and says it is old.
  clock += 11 * 60 * 1000;
  online = false;
  const answer = await service.read({ from: '1.26.0' });
  assert.deepEqual(answer.releases.map((r) => r.version), ['1.27.1', '1.27.0']);
  assert.match(answer.note, /read earlier/);
});

test('a long history is cut by size and the omitted versions are named', async () => {
  const long = 'x'.repeat(12_000);
  const releases = ['1.30.0', '1.29.0', '1.28.0'].map((v) => ({
    tag_name: `v${v}`, published_at: '2026-11-01T00:00:00Z', body: notes(long, long),
  }));
  const { service } = makeService({ releases }, { version: '1.30.0' });
  const answer = await service.read({ from: '1.27.0' });
  assert.deepEqual(answer.releases.map((r) => r.version), ['1.30.0', '1.29.0']);
  assert.deepEqual(answer.omittedVersions, ['1.28.0']);
  assert.match(answer.note, /1\.28\.0/);
});

test('the registry offers the tool only with a release-notes reader and hands the app\'s language on', async () => {
  const fsService = new Proxy({}, { get: () => async () => '{}' });
  const without = createWorkspaceToolRegistry({ fsService });
  assert.equal(without.getTools({}).some((t) => t.function.name === 'list_release_notes'), false);

  const { service } = makeService({}, { locale: 'de' });
  const registry = createWorkspaceToolRegistry({ fsService, releaseNotes: service });
  const tool = registry.getTools({}).find((t) => t.function.name === 'list_release_notes');
  assert.ok(tool, 'list_release_notes is offered');
  assert.deepEqual(tool.function.parameters.required, []);
  assert.equal(registry.listRiskCatalog().find((e) => e.name === 'list_release_notes').riskClasses[0], 'read');

  const result = await registry.getDefinition('list_release_notes').handler({ from: '1.24.0' }, { locale: 'de' });
  const answer = JSON.parse(result);
  assert.equal(answer.language, 'de');
  assert.equal(answer.releases[0].notes, '- **Markierungen behoben.**');
});
