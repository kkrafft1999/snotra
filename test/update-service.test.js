const test = require('node:test');
const assert = require('node:assert/strict');
const { translateMessage } = require('../src/shared/i18n');

// Main hands over keys since #353; the German wording is checked through the
// catalogue.
const de = (message) => translateMessage('de', message);
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
  assert.match(de(res.error), /404/);
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

// ── Selbst-Update (Issue #232) ──────────────────────────────────────────────

const MAC_RUNTIME = {
  platform: 'darwin',
  arch: 'arm64',
  execPath: '/Applications/Snotra AI.app/Contents/MacOS/Snotra AI',
  isPackaged: true,
};

function releaseWithAssets(extra = {}) {
  return {
    tag_name: 'v1.4.0',
    html_url: 'https://example.test/releases/v1.4.0',
    published_at: '2026-06-01T00:00:00Z',
    body: 'Neue Sachen',
    assets: [
      { name: 'Snotra-AI-1.4.0-mac-arm64.dmg', size: 4096, browser_download_url: 'https://github.com/kkrafft1999/snotra/releases/download/v1.4.0/Snotra-AI-1.4.0-mac-arm64.dmg' },
      { name: 'Snotra-AI-1.4.0-win-x64.zip', size: 5120, browser_download_url: 'https://github.com/kkrafft1999/snotra/releases/download/v1.4.0/Snotra-AI-1.4.0-win-x64.zip' },
    ],
    ...extra,
  };
}

/** Downloader-Attrappe, die mitschreibt, womit sie gefuettert wurde. */
function fakeDownloader({ ready = null } = {}) {
  const calls = [];
  let current = ready;
  return {
    calls,
    async download(args) {
      calls.push(args);
      current = { filePath: '/tmp/snotra.dmg', version: args.version, assetName: args.asset.name, bytes: args.asset.size };
      return { ok: true, filePath: current.filePath, version: args.version };
    },
    cancel: () => true,
    async discard() { current = null; },
    getReady: () => current,
    getWorkDir: () => '/tmp/snotra-update',
  };
}

test('checkForUpdate meldet das passende Paket und dass ein Selbst-Update geht', async () => {
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    runtime: MAC_RUNTIME,
    fetchImpl: async () => jsonResponse(releaseWithAssets()),
  });
  const res = await svc.checkForUpdate();
  assert.equal(res.canSelfUpdate, true);
  assert.equal(res.installKind, 'macos-bundle');
  // Nur Name und Groesse — die Adresse bleibt im Main-Prozess.
  assert.deepEqual(res.asset, { name: 'Snotra-AI-1.4.0-mac-arm64.dmg', size: 4096 });
  assert.equal(res.selfUpdateBlockedReason, '');
});

test('ohne passendes Paket bleibt nur der Verweis auf die Release-Seite', async () => {
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    runtime: MAC_RUNTIME,
    fetchImpl: async () => jsonResponse(releaseWithAssets({ assets: [] })),
  });
  const res = await svc.checkForUpdate();
  assert.equal(res.updateAvailable, true);
  assert.equal(res.canSelfUpdate, false);
  assert.equal(res.asset, null);
  assert.match(de(res.selfUpdateBlockedReason), /kein passendes Paket/);
});

test('eine Paketinstallation nennt ihren Grund statt eines Downloads', async () => {
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    runtime: { platform: 'linux', arch: 'x64', execPath: '/opt/Snotra AI/Snotra AI', isPackaged: true },
    fetchImpl: async () => jsonResponse(releaseWithAssets()),
  });
  const res = await svc.checkForUpdate();
  assert.equal(res.canSelfUpdate, false);
  assert.match(de(res.selfUpdateBlockedReason), /Administratorrechte/);

  const download = await svc.downloadUpdate();
  assert.equal(download.ok, false);
  assert.equal(download.manualOnly, true);
  assert.equal(download.releaseUrl, 'https://example.test/releases/v1.4.0');
});

test('downloadUpdate prueft frisch nach und laedt die Adresse aus dem Release', async () => {
  const downloader = fakeDownloader();
  let fetches = 0;
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    runtime: MAC_RUNTIME,
    downloader,
    fetchImpl: async () => { fetches += 1; return jsonResponse(releaseWithAssets()); },
  });

  const res = await svc.downloadUpdate();
  assert.equal(res.ok, true);
  assert.equal(fetches, 1, 'genau eine frische Pruefung, kein zweiter Abruf');
  assert.equal(downloader.calls.length, 1);
  assert.equal(
    downloader.calls[0].asset.url,
    'https://github.com/kkrafft1999/snotra/releases/download/v1.4.0/Snotra-AI-1.4.0-mac-arm64.dmg'
  );
  assert.equal(downloader.calls[0].version, '1.4.0');
});

test('downloadUpdate laedt nichts, wenn es gar kein Update mehr gibt', async () => {
  const downloader = fakeDownloader();
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    runtime: MAC_RUNTIME,
    downloader,
    fetchImpl: async () => jsonResponse({ tag_name: 'v1.0.0', assets: [] }),
  });
  const res = await svc.downloadUpdate();
  assert.equal(res.ok, false);
  assert.deepEqual(downloader.calls, []);
});

test('downloadUpdate laedt auch eine zuvor uebersprungene Version', async () => {
  const downloader = fakeDownloader();
  const svc = createUpdateService({
    app,
    storage: makeStorage({ ignoredUpdateVersion: '1.4.0' }),
    runtime: MAC_RUNTIME,
    downloader,
    fetchImpl: async () => jsonResponse(releaseWithAssets()),
  });
  // „Überspringen" gilt fuer die Meldung beim Start, nicht fuer einen Klick
  // auf „Herunterladen".
  assert.equal(downloader.calls.length, 0);
  assert.equal((await svc.downloadUpdate()).ok, true);
  assert.equal(downloader.calls.length, 1);
});

test('installUpdate reicht Datei, Version und Ziel an den Installer und beendet die App', async () => {
  const downloader = fakeDownloader();
  const seen = [];
  let quits = 0;
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    runtime: MAC_RUNTIME,
    downloader,
    installer: { async install(args) { seen.push(args); return { ok: true, relaunching: true }; } },
    quitApp: () => { quits += 1; },
    fetchImpl: async () => jsonResponse(releaseWithAssets()),
  });

  await svc.downloadUpdate();
  const res = await svc.installUpdate();

  assert.deepEqual(res, { ok: true, relaunching: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].filePath, '/tmp/snotra.dmg');
  assert.equal(seen[0].version, '1.4.0');
  assert.equal(seen[0].target.kind, 'macos-bundle');
  assert.equal(seen[0].workDir, '/tmp/snotra-update');
  assert.equal(quits, 1);
});

test('installUpdate ohne geladene Datei beendet die App nicht', async () => {
  let quits = 0;
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    runtime: MAC_RUNTIME,
    downloader: fakeDownloader(),
    installer: { async install() { throw new Error('darf nicht aufgerufen werden'); } },
    quitApp: () => { quits += 1; },
    fetchImpl: async () => jsonResponse(releaseWithAssets()),
  });
  const res = await svc.installUpdate();
  assert.equal(res.ok, false);
  assert.match(de(res.error), /keine geladene Version/);
  assert.equal(quits, 0);
});

test('eine gescheiterte Installation laesst die laufende App stehen', async () => {
  let quits = 0;
  const svc = createUpdateService({
    app,
    storage: makeStorage(),
    runtime: MAC_RUNTIME,
    downloader: fakeDownloader(),
    installer: { async install() { return { ok: false, error: 'Keine Schreibrechte.' }; } },
    quitApp: () => { quits += 1; },
    fetchImpl: async () => jsonResponse(releaseWithAssets()),
  });
  await svc.downloadUpdate();
  const res = await svc.installUpdate();
  assert.deepEqual(res, { ok: false, error: 'Keine Schreibrechte.' });
  assert.equal(quits, 0, 'die App darf sich nicht beenden, wenn nichts getauscht wurde');
});
