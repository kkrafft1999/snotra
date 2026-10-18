'use strict';

// Selbst-Update (Issue #232): prueft die GitHub-Releases-API des oeffentlichen
// Repos auf eine neuere Version, laedt das passende Release-Asset und spielt es
// ein. Jeder Schritt wird einzeln vom Renderer angestossen — pruefen, laden,
// installieren sind drei getrennte Aufrufe, damit der Nutzer dazwischen
// jederzeit abbrechen kann.
//
// Bewusst ohne nativen autoUpdater/Squirrel: beide setzen eine Code-Signatur
// voraus, die dieses Projekt nicht hat. Stattdessen laedt update-download.js
// das Asset und update-installer.js tauscht die Installation aus; die
// Entscheidung, WAS getauscht wird, steht in update-targets.js.

const fsp = require('fs/promises');
const path = require('path');

const { detectInstallTarget, pickReleaseAsset } = require('./update-targets');
const { createUpdateDownloader } = require('./update-download');
const { createUpdateInstaller } = require('./update-installer');
const { createMessage } = require('../../shared/contracts/message');

const GITHUB_API = 'https://api.github.com';
const DEFAULT_REPO = 'kkrafft1999/snotra';
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Is this response GitHub's rate limit rather than a real refusal (#943)?
 * Unauthenticated callers get 60 requests per hour per IP; behind a VPN or a
 * company NAT that budget is shared and runs out. GitHub answers 403 or 429
 * and says so in the headers. Returns null when it is not the rate limit,
 * otherwise `{ resetAt }` — the epoch millisecond the budget comes back, or
 * null when the headers do not say.
 */
function readRateLimit(res, now) {
  if (res.status !== 403 && res.status !== 429) return null;
  const header = (name) => {
    const value = res.headers?.get?.(name);
    return typeof value === 'string' ? value.trim() : '';
  };
  const retryAfter = header('retry-after');
  const remaining = header('x-ratelimit-remaining');
  if (!retryAfter && remaining !== '0') return null;

  let resetAt = null;
  if (/^\d+$/.test(retryAfter)) {
    resetAt = now + Number(retryAfter) * 1000;
  } else if (/^\d+$/.test(header('x-ratelimit-reset'))) {
    resetAt = Number(header('x-ratelimit-reset')) * 1000;
  }
  // A reset in the past or a day away is no time worth naming.
  if (resetAt !== null && (resetAt <= now || resetAt - now > 24 * 60 * 60 * 1000)) resetAt = null;
  return { resetAt };
}

/**
 * Zerlegt eine Versionsangabe in {major, minor, patch, prerelease}.
 * Toleriert ein fuehrendes "v" (z. B. Git-Tag "v1.2.3") und Prerelease-Suffixe
 * (z. B. "1.2.3-beta.1"). Liefert null, wenn nichts Brauchbares drinsteht.
 */
function parseSemver(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || '',
  };
}

function comparePrerelease(a, b) {
  // SemVer §11: eine Version OHNE Prerelease ist hoeher als dieselbe MIT.
  if (a === b) return 0;
  if (!a) return 1; // a ist Release, b ist Prerelease -> a groesser
  if (!b) return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1; // weniger Felder -> kleiner
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numerisch < alphanumerisch
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Vergleicht zwei Versionen. Rueckgabe: -1 (a<b), 0 (gleich), 1 (a>b).
 * Unparsebare Werte gelten als kleinstmoeglich.
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** True, wenn latest echt neuer als current ist. */
function isNewerVersion(latest, current) {
  return compareSemver(latest, current) > 0;
}

/**
 * @param {object} deps
 * @param {object} deps.app             Electron-app (getVersion, getPath, isPackaged).
 * @param {object} deps.storage         storage-service (fuer ignoredUpdateVersion).
 * @param {string} [deps.repo]          "owner/name"; default kkrafft1999/snotra.
 * @param {function} [deps.fetchImpl]   Override fuer Tests; default globaler fetch.
 * @param {object} [deps.downloader]    Test-Haken; default createUpdateDownloader.
 * @param {object} [deps.installer]     Test-Haken; default createUpdateInstaller.
 * @param {object} [deps.runtime]       Test-Haken fuer Plattform/Pfade der Installation.
 * @param {function} [deps.quitApp]     Wird nach erfolgreicher Installation gerufen.
 * @param {function} [deps.now]         Clock in epoch ms, for tests.
 */
function createUpdateService({
  app,
  storage,
  repo = DEFAULT_REPO,
  fetchImpl,
  downloader: downloaderOverride,
  installer: installerOverride,
  runtime,
  quitApp,
  now = Date.now,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  // Where a user fetches the version by hand — also when the check failed
  // and the API never told us the release's own page (#943).
  const latestReleasePage = `https://github.com/${repo}/releases/latest`;

  function getTempDir() {
    try {
      return app.getPath('temp');
    } catch {
      return require('os').tmpdir();
    }
  }

  /**
   * Where the helper reports after this process has quit (#442, #1003): a log
   * of every step, and a status file that exists only when the update failed.
   * The helper also writes `pendingFile` before it starts the new version,
   * and waits for that version to remove it (#1003, #1067). All three sit
   * in the user data folder, which no update replaces.
   */
  function getHelperFiles() {
    let dir;
    try {
      dir = app.getPath('userData');
    } catch {
      dir = getTempDir();
    }
    return {
      logFile: path.join(dir, 'update-install.log'),
      statusFile: path.join(dir, 'update-install-failed.json'),
      pendingFile: path.join(dir, 'update-install-pending.json'),
    };
  }

  const downloader = downloaderOverride
    || createUpdateDownloader({ tempDir: getTempDir(), fetchImpl: doFetch });
  const installer = installerOverride || createUpdateInstaller();

  /** Wo laeuft diese Installation, und kann sie sich selbst austauschen? */
  function getInstallTarget() {
    if (runtime) return detectInstallTarget(runtime);
    let execPath = process.execPath;
    try {
      execPath = app.getPath('exe');
    } catch { /* Fallback bleibt process.execPath */ }
    return detectInstallTarget({
      platform: process.platform,
      execPath,
      env: process.env,
      isPackaged: app?.isPackaged !== false,
    });
  }

  function getArch() {
    return runtime?.arch || process.arch;
  }

  /**
   * Das im letzten Check gefundene Paket inklusive Download-Adresse. Bleibt
   * absichtlich im Main-Prozess: Der Renderer erfaehrt nur Name und Groesse
   * und kann damit keine andere Quelle unterschieben.
   */
  let lastAsset = null;

  function getCurrentVersion() {
    try {
      return app.getVersion();
    } catch {
      return '0.0.0';
    }
  }

  async function fetchLatestRelease(signal) {
    const url = `${GITHUB_API}/repos/${repo}/releases/latest`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      const res = await doFetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Snotra-Agent-Updater',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!res.ok) {
        const limit = readRateLimit(res, now());
        if (limit) {
          return {
            error: limit.resetAt
              ? createMessage('update.error.rateLimited', { resetTime: limit.resetAt })
              : createMessage('update.error.rateLimitedNoTime'),
          };
        }
        return { error: createMessage('update.error.githubHttp', { status: res.status }) };
      }
      const json = await res.json();
      return { release: json };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  /**
   * Prueft auf ein Update. Wirft nie — bei Fehler/Offline kommt
   * { updateAvailable: false, error } zurueck, damit der Start nie blockiert.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.respectIgnored] true -> uebersprungene Version meldet
   *        kein Update (fuer Auto-Check beim Start). Bei manuellem Check false.
   * @param {AbortSignal} [opts.signal] ends the request early (#568)
   */
  async function checkForUpdate(opts = {}) {
    const respectIgnored = opts.respectIgnored === true;
    const currentVersion = getCurrentVersion();
    let result;
    try {
      result = await fetchLatestRelease(opts.signal);
    } catch (err) {
      const offline = err && (err.name === 'AbortError' || err.cause);
      return {
        updateAvailable: false,
        currentVersion,
        releaseUrl: latestReleasePage,
        error: offline
          ? createMessage('update.error.offline')
          : (err?.message || createMessage('update.error.checkFailed')),
      };
    }
    if (result.error) {
      return { updateAvailable: false, currentVersion, releaseUrl: latestReleasePage, error: result.error };
    }

    const release = result.release || {};
    const latestVersion = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
    if (!latestVersion || release.draft === true) {
      return { updateAvailable: false, currentVersion, releaseUrl: latestReleasePage, error: createMessage('update.error.noRelease') };
    }

    const newer = isNewerVersion(latestVersion, currentVersion);
    let ignored = false;
    if (newer && respectIgnored) {
      ignored = (await getIgnoredVersion()) === latestVersion;
    }

    // Selbst-Update nur anbieten, wenn BEIDES stimmt: Der Ablageort laesst
    // sich austauschen UND das Release hat ein Paket fuer diese Plattform.
    // Fehlt eines, bleibt der bisherige Weg ueber die Release-Seite — lieber
    // ein ehrlicher Verweis als ein Knopf, der nicht kann, was er verspricht.
    const target = getInstallTarget();
    const asset = target.canSelfUpdate
      ? pickReleaseAsset({ assets: release.assets, kind: target.kind, arch: getArch() })
      : null;
    lastAsset = asset;
    const canSelfUpdate = Boolean(target.canSelfUpdate && asset);
    const selfUpdateBlockedReason = canSelfUpdate
      ? ''
      : (target.reason || createMessage('update.reason.noAsset'));

    return {
      updateAvailable: newer && !ignored,
      currentVersion,
      latestVersion,
      isPrerelease: release.prerelease === true,
      releaseUrl: typeof release.html_url === 'string' ? release.html_url : latestReleasePage,
      publishedAt: release.published_at || null,
      notes: typeof release.body === 'string' ? release.body : '',
      canSelfUpdate,
      selfUpdateBlockedReason,
      installKind: target.kind,
      asset: asset ? { name: asset.name, size: asset.size } : null,
    };
  }

  /**
   * The download that is under way, from the click on "Download" on: the
   * fresh check below belongs to it as much as the transfer. Cancelling has to
   * reach both — the check alone can take seconds (#568).
   */
  let pendingDownload = null;

  /**
   * Laedt das Paket der neuesten Version. `onProgress` bekommt geladene und
   * erwartete Bytes; `cancelDownload()` bricht ab.
   *
   * Prueft dafuer noch einmal frisch — zwischen der Meldung und dem Klick auf
   * „Herunterladen" koennen Minuten liegen. So kommt die Download-Adresse
   * immer direkt von GitHub und nie aus dem Renderer.
   */
  async function downloadUpdate({ onProgress } = {}) {
    if (pendingDownload) return { ok: false, error: createMessage('update.error.downloadRunning') };
    const controller = new AbortController();
    pendingDownload = controller;
    try {
      const result = await checkForUpdate({ respectIgnored: false, signal: controller.signal });
      if (controller.signal.aborted) return { ok: false, canceled: true };
      if (!result.updateAvailable) {
        return { ok: false, error: result.error || createMessage('update.error.noNewerVersion') };
      }
      if (!result.canSelfUpdate || !lastAsset) {
        return {
          ok: false,
          manualOnly: true,
          releaseUrl: result.releaseUrl,
          error: result.selfUpdateBlockedReason || createMessage('update.error.selfUpdateImpossible'),
        };
      }
      return await downloader.download({
        asset: lastAsset, version: result.latestVersion, onProgress, signal: controller.signal,
      });
    } finally {
      if (pendingDownload === controller) pendingDownload = null;
    }
  }

  function cancelDownload() {
    if (pendingDownload) {
      pendingDownload.abort();
      return { ok: true };
    }
    return { ok: downloader.cancel() };
  }

  async function discardDownload() {
    await downloader.discard();
    return { ok: true };
  }

  /**
   * Spielt die zuvor geladene Datei ein und startet die App neu. Ein Erfolg
   * beendet die App — der Renderer sieht die Antwort dann nicht mehr.
   */
  async function installUpdate() {
    const ready = downloader.getReady();
    if (!ready) {
      return { ok: false, error: createMessage('update.error.nothingDownloaded') };
    }
    const target = getInstallTarget();
    const result = await installer.install({
      filePath: ready.filePath,
      version: ready.version,
      target,
      workDir: downloader.getWorkDir(),
      ...getHelperFiles(),
    });
    if (!result.ok) return result;
    if (typeof quitApp === 'function') quitApp();
    return result;
  }

  /**
   * Did the last install fail after this app had already quit? Reads the
   * helper's status file. A record for a version that is not newer than the
   * running one is stale — the user has updated some other way since — and is
   * dropped without a word, as is one that cannot be read.
   *
   * A valid record stays until `clearInstallFailure()` (#573): the start check
   * that reads it may still fail to reach GitHub, and then nothing is shown.
   *
   * `stage` is `start` when the new version was put in place but did not
   * start, and the helper went back to this one (#1003); `swap` otherwise.
   *
   * @returns {Promise<{version: string, stage: string, error: string, logFile: string} | null>}
   */
  async function readInstallFailure() {
    const { statusFile, logFile } = getHelperFiles();
    let raw;
    try {
      raw = await fsp.readFile(statusFile, 'utf8');
    } catch {
      return null;
    }
    let record;
    try {
      // Windows PowerShell 5 writes UTF-8 with a byte order mark.
      record = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      await clearInstallFailure();
      return null;
    }
    const version = typeof record?.version === 'string' ? record.version : '';
    if (!version || !isNewerVersion(version, getCurrentVersion())) {
      await clearInstallFailure();
      return null;
    }
    return {
      version,
      stage: record.stage === 'start' ? 'start' : 'swap',
      error: typeof record.error === 'string' ? record.error.trim() : '',
      logFile: typeof record.log === 'string' && record.log ? record.log : logFile,
    };
  }

  /**
   * Tells a waiting update helper that this version has started (#1003): it
   * removes the record the helper wrote before it started the new version,
   * and the helper then deletes the backup of the old one. Called once the
   * main window is open.
   *
   * A record for this version or an older one is done with — it is this start
   * that was waited for, or one left behind by a helper that never finished.
   * A record for a newer version stays: that helper is still deciding, and
   * this version is the one it is about to put back.
   *
   * @returns {Promise<boolean>} whether a record for this version was there
   */
  async function confirmInstallStarted() {
    const { pendingFile } = getHelperFiles();
    let raw;
    try {
      raw = await fsp.readFile(pendingFile, 'utf8');
    } catch {
      return false;
    }
    let version = '';
    try {
      // Windows PowerShell 5 writes UTF-8 with a byte order mark (#1067).
      const record = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (typeof record?.version === 'string') version = record.version;
    } catch { /* unreadable: done with, like a stale one */ }
    const current = getCurrentVersion();
    if (version && isNewerVersion(version, current)) return false;
    await fsp.rm(pendingFile, { force: true }).catch(() => {});
    return version === current;
  }

  /** Forgets a failed install once the user has been told. */
  async function clearInstallFailure() {
    await fsp.rm(getHelperFiles().statusFile, { force: true }).catch(() => {});
  }

  async function getIgnoredVersion() {
    try {
      const prefs = await storage.readUIPrefs();
      return typeof prefs.ignoredUpdateVersion === 'string' ? prefs.ignoredUpdateVersion : '';
    } catch {
      return '';
    }
  }

  async function ignoreVersion(version) {
    if (typeof version !== 'string' || !version.trim()) return { ok: false };
    try {
      await storage.updateUIPrefs(async (out) => {
        out.ignoredUpdateVersion = version.trim();
        return out;
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || createMessage('update.error.rememberFailed') };
    }
  }

  return {
    getCurrentVersion,
    checkForUpdate,
    getIgnoredVersion,
    ignoreVersion,
    getInstallTarget,
    downloadUpdate,
    cancelDownload,
    discardDownload,
    installUpdate,
    readInstallFailure,
    clearInstallFailure,
    confirmInstallStarted,
  };
}

module.exports = {
  createUpdateService,
  parseSemver,
  compareSemver,
  isNewerVersion,
};
