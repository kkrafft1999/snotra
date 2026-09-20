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

const { detectInstallTarget, pickReleaseAsset } = require('./update-targets');
const { createUpdateDownloader } = require('./update-download');
const { createUpdateInstaller } = require('./update-installer');

const GITHUB_API = 'https://api.github.com';
const DEFAULT_REPO = 'kkrafft1999/snotra';
const REQUEST_TIMEOUT_MS = 8000;

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
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;

  function getTempDir() {
    try {
      return app.getPath('temp');
    } catch {
      return require('os').tmpdir();
    }
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

  async function fetchLatestRelease() {
    const url = `${GITHUB_API}/repos/${repo}/releases/latest`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Snotra-AI-Updater',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!res.ok) {
        return { error: `GitHub antwortete mit HTTP ${res.status}.` };
      }
      const json = await res.json();
      return { release: json };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Prueft auf ein Update. Wirft nie — bei Fehler/Offline kommt
   * { updateAvailable: false, error } zurueck, damit der Start nie blockiert.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.respectIgnored] true -> uebersprungene Version meldet
   *        kein Update (fuer Auto-Check beim Start). Bei manuellem Check false.
   */
  async function checkForUpdate(opts = {}) {
    const respectIgnored = opts.respectIgnored === true;
    const currentVersion = getCurrentVersion();
    let result;
    try {
      result = await fetchLatestRelease();
    } catch (err) {
      const offline = err && (err.name === 'AbortError' || err.cause);
      return {
        updateAvailable: false,
        currentVersion,
        error: offline ? 'Update-Server nicht erreichbar.' : (err?.message || 'Update-Pruefung fehlgeschlagen.'),
      };
    }
    if (result.error) {
      return { updateAvailable: false, currentVersion, error: result.error };
    }

    const release = result.release || {};
    const latestVersion = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
    if (!latestVersion || release.draft === true) {
      return { updateAvailable: false, currentVersion, error: 'Kein gueltiges Release gefunden.' };
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
      : (target.reason || 'Für diese Installation gibt es im Release kein passendes Paket.');

    return {
      updateAvailable: newer && !ignored,
      currentVersion,
      latestVersion,
      isPrerelease: release.prerelease === true,
      releaseUrl: typeof release.html_url === 'string' ? release.html_url : `https://github.com/${repo}/releases/latest`,
      publishedAt: release.published_at || null,
      notes: typeof release.body === 'string' ? release.body : '',
      canSelfUpdate,
      selfUpdateBlockedReason,
      installKind: target.kind,
      asset: asset ? { name: asset.name, size: asset.size } : null,
    };
  }

  /**
   * Laedt das Paket der neuesten Version. `onProgress` bekommt geladene und
   * erwartete Bytes; `cancelDownload()` bricht ab.
   *
   * Prueft dafuer noch einmal frisch — zwischen der Meldung und dem Klick auf
   * „Herunterladen" koennen Minuten liegen. So kommt die Download-Adresse
   * immer direkt von GitHub und nie aus dem Renderer.
   */
  async function downloadUpdate({ onProgress } = {}) {
    const result = await checkForUpdate({ respectIgnored: false });
    if (!result.updateAvailable) {
      return { ok: false, error: result.error || 'Es gibt keine neuere Version.' };
    }
    if (!result.canSelfUpdate || !lastAsset) {
      return {
        ok: false,
        manualOnly: true,
        releaseUrl: result.releaseUrl,
        error: result.selfUpdateBlockedReason || 'Selbst-Update ist hier nicht möglich.',
      };
    }
    return downloader.download({ asset: lastAsset, version: result.latestVersion, onProgress });
  }

  function cancelDownload() {
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
      return { ok: false, error: 'Es liegt keine geladene Version bereit.' };
    }
    const target = getInstallTarget();
    const result = await installer.install({
      filePath: ready.filePath,
      version: ready.version,
      target,
      workDir: downloader.getWorkDir(),
    });
    if (!result.ok) return result;
    if (typeof quitApp === 'function') quitApp();
    return result;
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
      return { ok: false, error: err?.message || 'Konnte Version nicht merken.' };
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
  };
}

module.exports = {
  createUpdateService,
  parseSemver,
  compareSemver,
  isNewerVersion,
};
