const test = require('node:test');
const assert = require('node:assert/strict');
const { translateMessage } = require('../src/shared/i18n');
const { removeTempDirSync } = require('./helpers/temp-dir');

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

// ── Rate limit (#943) ───────────────────────────────────────────────────────

const en = (message) => translateMessage('en', message);
const NOW = Date.UTC(2026, 9, 14, 7, 45, 0);

function limitedResponse(status, headers) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: false, status, headers: { get: (name) => map.get(name.toLowerCase()) ?? null }, async json() { return {}; } };
}

function limitedService(response) {
  return createUpdateService({ app, storage: makeStorage(), now: () => NOW, fetchImpl: async () => response });
}

test('a 403 with an exhausted rate limit names the reset time, not the status', async () => {
  const reset = Math.floor(NOW / 1000) + 9 * 60;
  const res = await limitedService(limitedResponse(403, {
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(reset),
  })).checkForUpdate();
  assert.equal(res.updateAvailable, false);
  assert.equal(res.error.key, 'update.error.rateLimited');
  assert.equal(res.error.params.resetTime, reset * 1000);
  const clock = new Intl.DateTimeFormat('de', { hour: 'numeric', minute: '2-digit' }).format(reset * 1000);
  assert.equal(de(res.error), `GitHub begrenzt gerade die Anfragen aus deinem Netz. Versuch es ab ${clock} Uhr wieder.`);
  assert.doesNotMatch(en(res.error), /403/);
  assert.equal(res.releaseUrl, 'https://github.com/kkrafft1999/snotra/releases/latest');
});

test('a 429 with retry-after counts from now', async () => {
  const res = await limitedService(limitedResponse(429, { 'retry-after': '120' })).checkForUpdate();
  assert.equal(res.error.key, 'update.error.rateLimited');
  assert.equal(res.error.params.resetTime, NOW + 120 * 1000);
});

test('a rate limit without a usable reset time says "in a few minutes"', async () => {
  const past = Math.floor(NOW / 1000) - 60;
  for (const headers of [{ 'x-ratelimit-remaining': '0' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(past) }]) {
    const res = await limitedService(limitedResponse(403, headers)).checkForUpdate();
    assert.equal(res.error.key, 'update.error.rateLimitedNoTime');
    assert.match(en(res.error), /in a few minutes/);
  }
});

test('a 403 with budget left is a plain refusal, not the rate limit', async () => {
  const res = await limitedService(limitedResponse(403, { 'x-ratelimit-remaining': '42' })).checkForUpdate();
  assert.equal(res.error.key, 'update.error.githubHttp');
  assert.equal(en(res.error), 'GitHub could not answer the request (HTTP 403).');
});

test('a 500 stays the generic HTTP message, even without headers', async () => {
  const res = await limitedService(jsonResponse({}, false, 500)).checkForUpdate();
  assert.equal(res.error.key, 'update.error.githubHttp');
  assert.equal(res.releaseUrl, 'https://github.com/kkrafft1999/snotra/releases/latest');
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
  assert.match(calls[0].opts.headers['User-Agent'], /^Snotra-Agent-/);
});

// ── Selbst-Update (Issue #232) ──────────────────────────────────────────────

const MAC_RUNTIME = {
  platform: 'darwin',
  arch: 'arm64',
  execPath: '/Applications/Snotra Agent.app/Contents/MacOS/Snotra Agent',
  isPackaged: true,
};

function releaseWithAssets(extra = {}) {
  return {
    tag_name: 'v1.4.0',
    html_url: 'https://example.test/releases/v1.4.0',
    published_at: '2026-06-01T00:00:00Z',
    body: 'Neue Sachen',
    assets: [
      { name: 'Snotra-Agent-1.4.0-mac-arm64.dmg', size: 4096, browser_download_url: 'https://github.com/kkrafft1999/snotra/releases/download/v1.4.0/Snotra-Agent-1.4.0-mac-arm64.dmg' },
      { name: 'Snotra-Agent-1.4.0-win-x64.zip', size: 5120, browser_download_url: 'https://github.com/kkrafft1999/snotra/releases/download/v1.4.0/Snotra-Agent-1.4.0-win-x64.zip' },
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
  assert.deepEqual(res.asset, { name: 'Snotra-Agent-1.4.0-mac-arm64.dmg', size: 4096 });
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
    runtime: { platform: 'linux', arch: 'x64', execPath: '/opt/Snotra Agent/Snotra Agent', isPackaged: true },
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
    'https://github.com/kkrafft1999/snotra/releases/download/v1.4.0/Snotra-Agent-1.4.0-mac-arm64.dmg'
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

// #442: the Windows helper reports a failed swap after the app has quit.
function makeUserDataApp(t, version = '1.12.0') {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-update-status-'));
  t.after(() => removeTempDirSync(dir));
  return {
    dir,
    statusFile: path.join(dir, 'update-install-failed.json'),
    logFile: path.join(dir, 'update-install.log'),
    pendingFile: path.join(dir, 'update-install-pending.json'),
    app: {
      getVersion: () => version,
      getPath: (name) => (name === 'userData' ? dir : os.tmpdir()),
    },
  };
}

test('installUpdate gibt dem Installer Protokoll und Status im Benutzerordner mit', async (t) => {
  const { app: userApp, logFile, statusFile, pendingFile } = makeUserDataApp(t, '1.0.0');
  const seen = [];
  const svc = createUpdateService({
    app: userApp,
    storage: makeStorage(),
    runtime: MAC_RUNTIME,
    downloader: fakeDownloader(),
    installer: { async install(args) { seen.push(args); return { ok: true, relaunching: true }; } },
    quitApp: () => {},
    fetchImpl: async () => jsonResponse(releaseWithAssets()),
  });
  await svc.downloadUpdate();
  await svc.installUpdate();
  assert.equal(seen[0].logFile, logFile);
  assert.equal(seen[0].statusFile, statusFile);
  assert.equal(seen[0].pendingFile, pendingFile, 'the POSIX helper waits on it (#1003)');
});

test('readInstallFailure reports a failed swap until it is cleared (#573)', async (t) => {
  const fs = require('node:fs');
  const { app: userApp, statusFile } = makeUserDataApp(t);
  // Windows PowerShell 5 writes a byte order mark in front of the JSON.
  fs.writeFileSync(statusFile, `\uFEFF${JSON.stringify({
    version: '1.13.0',
    error: ' The process cannot access the file because it is being used by another process. ',
    log: 'C:\\Users\\k\\AppData\\Roaming\\Snotra Agent\\update-install.log',
  })}`);
  const svc = createUpdateService({ app: userApp, storage: makeStorage() });

  const expected = {
    version: '1.13.0',
    stage: 'swap',
    error: 'The process cannot access the file because it is being used by another process.',
    logFile: 'C:\\Users\\k\\AppData\\Roaming\\Snotra Agent\\update-install.log',
  };
  assert.deepEqual(await svc.readInstallFailure(), expected);
  // Reading alone does not forget it: the check that follows may still fail.
  assert.deepEqual(await svc.readInstallFailure(), expected);
  await svc.clearInstallFailure();
  assert.equal(fs.existsSync(statusFile), false);
  assert.equal(await svc.readInstallFailure(), null);
});

test('readInstallFailure verwirft eine Meldung, die inzwischen ueberholt ist', async (t) => {
  const fs = require('node:fs');
  const { app: userApp, statusFile } = makeUserDataApp(t, '1.13.0');
  fs.writeFileSync(statusFile, JSON.stringify({ version: '1.13.0', error: 'locked' }));
  const svc = createUpdateService({ app: userApp, storage: makeStorage() });
  assert.equal(await svc.readInstallFailure(), null);
  assert.equal(fs.existsSync(statusFile), false);
});

test('readInstallFailure uebersteht eine kaputte Datei und faellt auf das eigene Protokoll zurueck', async (t) => {
  const fs = require('node:fs');
  const { app: userApp, statusFile, logFile } = makeUserDataApp(t);
  fs.writeFileSync(statusFile, '{ not json');
  const svc = createUpdateService({ app: userApp, storage: makeStorage() });
  assert.equal(await svc.readInstallFailure(), null);
  assert.equal(fs.existsSync(statusFile), false, 'a file that cannot be read is dropped');

  fs.writeFileSync(statusFile, JSON.stringify({ version: '1.13.0' }));
  assert.deepEqual(await svc.readInstallFailure(), { version: '1.13.0', stage: 'swap', error: '', logFile });
});

test('readInstallFailure tells a version that did not start from a failed swap (#1003)', async (t) => {
  const fs = require('node:fs');
  const { app: userApp, statusFile } = makeUserDataApp(t);
  // As the POSIX helper writes it.
  fs.writeFileSync(statusFile, `${JSON.stringify({
    version: '1.13.0',
    stage: 'start',
    error: 'the new version ended before it had started (exit code 1)',
    log: '/home/k/.config/Snotra AI/update-install.log',
    at: '2026-10-17T10:00:00Z',
  })}\n`);
  const svc = createUpdateService({ app: userApp, storage: makeStorage() });
  assert.deepEqual(await svc.readInstallFailure(), {
    version: '1.13.0',
    stage: 'start',
    error: 'the new version ended before it had started (exit code 1)',
    logFile: '/home/k/.config/Snotra AI/update-install.log',
  });

  fs.writeFileSync(statusFile, JSON.stringify({ version: '1.13.0', stage: 'something else' }));
  assert.equal((await svc.readInstallFailure()).stage, 'swap', 'an unknown stage reads as the old message');
});

test('confirmInstallStarted removes the record of this version, so the helper deletes the backup (#1003)', async (t) => {
  const fs = require('node:fs');
  const { app: userApp, pendingFile } = makeUserDataApp(t, '1.13.0');
  const svc = createUpdateService({ app: userApp, storage: makeStorage() });

  assert.equal(await svc.confirmInstallStarted(), false, 'nothing waits: nothing to do');

  fs.writeFileSync(pendingFile, '{"version":"1.13.0"}\n');
  assert.equal(await svc.confirmInstallStarted(), true);
  assert.equal(fs.existsSync(pendingFile), false);
});

test('confirmInstallStarted leaves a record for a newer version, and drops a stale one (#1003)', async (t) => {
  const fs = require('node:fs');
  const { app: userApp, pendingFile } = makeUserDataApp(t, '1.13.0');
  const svc = createUpdateService({ app: userApp, storage: makeStorage() });

  // The helper is still deciding about 1.14.0 and is about to put this one back.
  fs.writeFileSync(pendingFile, '{"version":"1.14.0"}');
  assert.equal(await svc.confirmInstallStarted(), false);
  assert.equal(fs.existsSync(pendingFile), true);

  for (const leftOver of ['{"version":"1.12.0"}', '{ not json', '{}']) {
    fs.writeFileSync(pendingFile, leftOver);
    assert.equal(await svc.confirmInstallStarted(), false, leftOver);
    assert.equal(fs.existsSync(pendingFile), false, `${leftOver} is a leftover`);
  }
});

// #568: Cancel used to reach only the transfer. Pressed while the fresh check
// still ran, it did nothing, and the download started anyway.
test('cancelDownload during the fresh check ends the run before anything is fetched', async () => {
  const downloader = fakeDownloader();
  let releaseRequest;
  const svc = createUpdateService({
    app: { getVersion: () => '1.3.0', isPackaged: true },
    storage: makeStorage(),
    runtime: MAC_RUNTIME,
    downloader,
    fetchImpl: (_url, opts) => new Promise((resolve, reject) => {
      releaseRequest = () => resolve(jsonResponse(releaseWithAssets()));
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });

  const pending = svc.downloadUpdate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(svc.cancelDownload(), { ok: true });
  assert.deepEqual(await pending, { ok: false, canceled: true });
  assert.equal(downloader.calls.length, 0);
  assert.equal(typeof releaseRequest, 'function');
});

test('a second downloadUpdate while the first is checking is refused (#568)', async () => {
  const downloader = fakeDownloader();
  const svc = createUpdateService({
    app: { getVersion: () => '1.3.0', isPackaged: true },
    storage: makeStorage(),
    runtime: MAC_RUNTIME,
    downloader,
    fetchImpl: async () => jsonResponse(releaseWithAssets()),
  });
  const [first, second] = await Promise.all([svc.downloadUpdate(), svc.downloadUpdate()]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.error.key, 'update.error.downloadRunning');
  assert.equal(downloader.calls.length, 1);
});

test('downloadUpdate hands the asset digest and a signal to the downloader (#568, #569)', async () => {
  const downloader = fakeDownloader();
  const digest = `sha256:${'ab'.repeat(32)}`;
  const release = releaseWithAssets();
  release.assets[0].digest = digest;
  const svc = createUpdateService({
    app: { getVersion: () => '1.3.0', isPackaged: true },
    storage: makeStorage(),
    runtime: MAC_RUNTIME,
    downloader,
    fetchImpl: async () => jsonResponse(release),
  });
  await svc.downloadUpdate();
  assert.equal(downloader.calls[0].asset.digest, digest);
  assert.ok(downloader.calls[0].signal instanceof AbortSignal);
});
