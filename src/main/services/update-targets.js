'use strict';

// Wo steckt die laufende Installation, und welches Release-Asset passt dazu?
//
// Bewusst **reine** Funktionen ohne Dateisystem- oder Prozesszugriff: Die
// Entscheidung „was wird getauscht und womit" ist der Teil, der pro Plattform
// schiefgehen kann, und soll deshalb ohne echte Installation testbar bleiben.
// Das Ausfuehren liegt in update-installer.js, das Laden in update-download.js.

const path = require('path');

/** Verzeichnisse, in die nur root schreibt — dort liegt eine Paketinstallation. */
const LINUX_SYSTEM_PREFIXES = ['/opt/', '/usr/', '/snap/'];

const REASONS = Object.freeze({
  dev: 'Das hier ist ein Entwicklungs-Build, kein installiertes Programm. '
    + 'Ein Update spielst du über das Repository ein.',
  package: 'Snotra AI wurde als Systempaket installiert. Das Ersetzen verlangt '
    + 'Administratorrechte, die die App nicht hat — lade das neue Paket von der '
    + 'Release-Seite und installiere es mit deinem Paketmanager.',
  platform: 'Für dieses Betriebssystem kann sich die App nicht selbst '
    + 'aktualisieren. Lade die neue Version von der Release-Seite.',
  layout: 'Der Ablageort der App sieht ungewöhnlich aus — die App tauscht sich '
    + 'lieber nicht selbst aus. Lade die neue Version von der Release-Seite.',
});

/**
 * Pfad des .app-Bundles aus dem Pfad der ausfuehrbaren Datei.
 * `/Applications/Snotra AI.app/Contents/MacOS/Snotra AI` → `/Applications/Snotra AI.app`
 * Liefert '' , wenn der Pfad nicht so aufgebaut ist (z. B. `npm start`).
 */
function macAppBundlePath(execPath) {
  if (typeof execPath !== 'string') return '';
  const marker = '.app/Contents/MacOS/';
  const idx = execPath.indexOf(marker);
  if (idx === -1) return '';
  return execPath.slice(0, idx + '.app'.length);
}

function isLinuxSystemPath(dir) {
  const normalized = `${String(dir).replace(/\/+$/, '')}/`;
  return LINUX_SYSTEM_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Welche Art von Installation laeuft hier gerade?
 *
 * @param {object} ctx
 * @param {string} ctx.platform    process.platform
 * @param {string} ctx.execPath    process.execPath (bzw. app.getPath('exe'))
 * @param {object} [ctx.env]       process.env (nur APPIMAGE wird gelesen)
 * @param {boolean} [ctx.isPackaged] app.isPackaged
 * @returns {{kind: string, canSelfUpdate: boolean, reason?: string,
 *            appBundlePath?: string, installDir?: string, appImagePath?: string}}
 */
function detectInstallTarget({ platform, execPath, env = {}, isPackaged = true } = {}) {
  if (!isPackaged) {
    return { kind: 'dev', canSelfUpdate: false, reason: REASONS.dev };
  }

  if (platform === 'darwin') {
    const appBundlePath = macAppBundlePath(execPath);
    if (!appBundlePath) {
      return { kind: 'unsupported', canSelfUpdate: false, reason: REASONS.layout };
    }
    return { kind: 'macos-bundle', canSelfUpdate: true, appBundlePath };
  }

  if (platform === 'win32') {
    const installDir = path.win32.dirname(String(execPath || ''));
    if (!installDir || installDir === '.') {
      return { kind: 'unsupported', canSelfUpdate: false, reason: REASONS.layout };
    }
    return { kind: 'windows-dir', canSelfUpdate: true, installDir };
  }

  if (platform === 'linux') {
    // Ein laufendes AppImage kennt sich selbst ueber $APPIMAGE. Das ist der
    // einzige Fall, in dem eine einzelne Datei ersetzt wird statt ein Ordner.
    const appImagePath = typeof env.APPIMAGE === 'string' ? env.APPIMAGE.trim() : '';
    if (appImagePath) {
      return { kind: 'linux-appimage', canSelfUpdate: true, appImagePath };
    }
    const installDir = path.posix.dirname(String(execPath || ''));
    if (!installDir || installDir === '.') {
      return { kind: 'unsupported', canSelfUpdate: false, reason: REASONS.layout };
    }
    if (isLinuxSystemPath(installDir)) {
      return { kind: 'linux-package', canSelfUpdate: false, reason: REASONS.package, installDir };
    }
    return { kind: 'linux-dir', canSelfUpdate: true, installDir };
  }

  return { kind: 'unsupported', canSelfUpdate: false, reason: REASONS.platform };
}

/** Endung und Architektur-Kennung, die zur Installationsart passen. */
const ASSET_RULES = Object.freeze({
  'macos-bundle': { suffix: '.dmg', arch: { arm64: 'arm64', x64: 'arm64' } },
  'windows-dir': { suffix: '.zip', arch: { x64: 'x64', arm64: 'x64' } },
  'linux-appimage': { suffix: '.appimage', arch: { x64: 'x64', arm64: 'x64' } },
  'linux-dir': { suffix: '.tar.gz', arch: { x64: 'x64', arm64: 'x64' } },
});

/**
 * Waehlt aus den Release-Assets das Paket, das zur laufenden Installation passt.
 * Gibt `null` zurueck, wenn es keines gibt — der Aufrufer faellt dann auf den
 * Verweis zur Release-Seite zurueck, statt irgendetwas Falsches zu laden.
 *
 * @param {object} args
 * @param {Array} args.assets   `assets` aus der GitHub-Release-Antwort
 * @param {string} args.kind    Ergebnis von detectInstallTarget().kind
 * @param {string} [args.arch]  process.arch
 */
function pickReleaseAsset({ assets, kind, arch = 'x64' } = {}) {
  const rule = ASSET_RULES[kind];
  if (!rule || !Array.isArray(assets)) return null;

  const candidates = assets
    .filter((asset) => asset && typeof asset.name === 'string'
      && typeof asset.browser_download_url === 'string'
      && asset.name.toLowerCase().endsWith(rule.suffix))
    // Ein .tar.gz-Filter darf das AppImage nicht mitnehmen und umgekehrt; die
    // Endungen sind disjunkt, aber die Arch-Kennung entscheidet bei mehreren
    // Builds derselben Plattform.
    .map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: Number.isFinite(asset.size) ? asset.size : 0,
    }));

  if (candidates.length === 0) return null;

  const wanted = rule.arch[arch] || rule.arch.x64;
  const exact = candidates.find((asset) => asset.name.toLowerCase().includes(wanted));
  // Ohne Arch-Treffer nur dann raten, wenn es genau einen Kandidaten gibt.
  if (exact) return exact;
  return candidates.length === 1 ? candidates[0] : null;
}

module.exports = {
  detectInstallTarget,
  pickReleaseAsset,
  macAppBundlePath,
  isLinuxSystemPath,
  REASONS,
};
