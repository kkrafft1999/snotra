'use strict';

// Update-Notifier (Stufe 1): prueft die GitHub-Releases-API des oeffentlichen
// Repos auf eine neuere Version und meldet das Ergebnis. Es wird NICHTS
// automatisch heruntergeladen oder installiert — der Renderer verlinkt nur auf
// die Release-Seite. Bewusst ohne native autoUpdater/Squirrel, weil die App
// nicht code-signiert ist.

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
 * @param {object} deps.app            Electron-app (fuer getVersion).
 * @param {object} deps.storage        storage-service (fuer ignoredUpdateVersion).
 * @param {string} [deps.repo]         "owner/name"; default kkrafft1999/snotra.
 * @param {function} [deps.fetchImpl]  Override fuer Tests; default globaler fetch.
 */
function createUpdateService({ app, storage, repo = DEFAULT_REPO, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;

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

    return {
      updateAvailable: newer && !ignored,
      currentVersion,
      latestVersion,
      isPrerelease: release.prerelease === true,
      releaseUrl: typeof release.html_url === 'string' ? release.html_url : `https://github.com/${repo}/releases/latest`,
      publishedAt: release.published_at || null,
      notes: typeof release.body === 'string' ? release.body : '',
    };
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
  };
}

module.exports = {
  createUpdateService,
  parseSemver,
  compareSemver,
  isNewerVersion,
};
