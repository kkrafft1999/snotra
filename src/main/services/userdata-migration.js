'use strict';

// Einmalige Uebernahme des userData-Ordners der Vorgaenger-Identitaet
// ("Weyouze Anything") in den Ordner der aktuellen App ("Snotra AI", seit #795 der Name der
// Plattform, unter dem die App ihre Daten ablegt — siehe app-identity.js).
//
// Electron leitet app.getPath('userData') aus dem App-Namen ab; nach der
// Umbenennung startet die App sonst leer. Kopiert wird eine Allowlist
// bekannter Dateien (keine Chromium-Profildaten wie Cache/, Local Storage/,
// Preferences, SingletonLock). Der Quellordner bleibt unangetastet und dient
// als Backup. Verschluesselte Inhalte (apiKeyEnc, chat-history.json) sind
// unter macOS nach dem Rename nicht mehr entschluesselbar, weil der
// safeStorage-Schluessel am App-Namen haengt; das faengt storage-service.js
// (Quarantaene) bzw. settings-handlers.js (Key neu eingeben) ab.
//
// Pures Node-Modul ohne Electron-Abhaengigkeit, damit es mit node --test
// gegen echte Temp-Verzeichnisse getestet werden kann.

const { constants: fsConstants } = require('fs');
const { writeFileAtomic } = require('./atomic-write');

const MIGRATION_MARKER_FILENAME = 'migrated-from-weyouze.json';

const MIGRATED_FILENAMES = [
  'llm-config.json',
  'openai-config.json',
  'last-folder.json',
  'folder-history.json',
  'ui-preferences.json',
  'chat-history.json',
];

// Existiert eine dieser Dateien im Ziel, wurde dort bereits gearbeitet.
const TARGET_POPULATED_FILENAMES = ['llm-config.json', 'chat-history.json'];

/**
 * @typedef {{ status: string, copied: string[], skipped: string[], errors: Array<{ file: string|null, message: string }> }} MigrationResult
 */

/**
 * @param {object} deps
 * @param {Pick<typeof import('fs/promises'), 'stat' | 'mkdir' | 'copyFile' | 'open' | 'unlink' | 'rename'>} deps.fs
 * @param {Pick<typeof import('path'), 'join' | 'resolve'>} deps.path
 * @param {{ info?: (message: string) => void, warn?: (message: string) => void }} [deps.log]
 */
function createUserDataMigration({ fs, path, log = console }) {
  if (!fs || !path) {
    throw new Error('createUserDataMigration requires fs (promises API) and path');
  }

  /** @param {string} msg */
  const info = (msg) => { if (typeof log?.info === 'function') log.info(msg); };
  /** @param {string} msg */
  const warn = (msg) => { if (typeof log?.warn === 'function') log.warn(msg); };

  /** @param {string} p */
  async function exists(p) {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  /** @param {string} p */
  async function isDirectory(p) {
    try {
      return (await fs.stat(p)).isDirectory();
    } catch {
      return false;
    }
  }

  /** @param {{ sourceDir: string, targetDir: string, result: MigrationResult, meta?: object }} params */
  async function writeMarker({ sourceDir, targetDir, result, meta }) {
    const marker = {
      version: 1,
      migratedAt: new Date().toISOString(),
      sourceDir,
      targetDir,
      status: result.status,
      copied: result.copied,
      skipped: result.skipped,
      errors: result.errors,
      meta: meta || {},
    };
    try {
      await fs.mkdir(targetDir, { recursive: true });
      // Temp + rename (#1013): a marker cut off halfway would read as no
      // marker at all, and the next start would migrate a second time.
      await writeFileAtomic(fs, path.join(targetDir, MIGRATION_MARKER_FILENAME), JSON.stringify(marker, null, 2));
    } catch (err) {
      warn(`[userdata-migration] Marker konnte nicht geschrieben werden: ${err?.message || err}`);
    }
  }

  /**
   * @param {{ sourceDir?: string, targetDir?: string, meta?: object, explicitUserDataDir?: boolean }} [options]
   * @returns {Promise<MigrationResult>}
   *   status: 'copied' | 'skipped-marker' | 'skipped-target-populated'
   *         | 'skipped-no-source' | 'skipped-same-dir'
   *         | 'skipped-explicit-user-data-dir' | 'failed'
   *   Wirft nie; der App-Start darf an der Migration nicht scheitern.
   */
  async function migrateLegacyUserData({ sourceDir, targetDir, meta, explicitUserDataDir = false } = {}) {
    /** @type {MigrationResult} */
    const result = { status: 'failed', copied: [], skipped: [], errors: [] };
    try {
      // The migration repairs the default folder the rename moved. A folder
      // given with --user-data-dir — a test run, a second profile — was chosen
      // on purpose and never was that folder; filling it from the real legacy
      // folder would hand it this machine's chat history and keys (#688).
      // Nothing is written, not even the marker.
      if (explicitUserDataDir) {
        result.status = 'skipped-explicit-user-data-dir';
        return result;
      }
      if (!sourceDir || !targetDir) {
        result.status = 'skipped-no-source';
        return result;
      }
      if (path.resolve(sourceDir) === path.resolve(targetDir)) {
        result.status = 'skipped-same-dir';
        return result;
      }
      if (await exists(path.join(targetDir, MIGRATION_MARKER_FILENAME))) {
        result.status = 'skipped-marker';
        return result;
      }
      if (!(await isDirectory(sourceDir))) {
        result.status = 'skipped-no-source';
        return result;
      }
      for (const name of TARGET_POPULATED_FILENAMES) {
        if (await exists(path.join(targetDir, name))) {
          result.status = 'skipped-target-populated';
          await writeMarker({ sourceDir, targetDir, result, meta });
          info(`[userdata-migration] Ziel "${targetDir}" enthaelt bereits Daten, "${sourceDir}" wird nicht uebernommen`);
          return result;
        }
      }

      await fs.mkdir(targetDir, { recursive: true });
      for (const name of MIGRATED_FILENAMES) {
        const src = path.join(sourceDir, name);
        if (!(await exists(src))) continue;
        try {
          await fs.copyFile(src, path.join(targetDir, name), fsConstants.COPYFILE_EXCL);
          result.copied.push(name);
        } catch (err) {
          if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
            result.skipped.push(name);
          } else {
            result.errors.push({ file: name, message: err?.message || String(err) });
            warn(`[userdata-migration] ${name} konnte nicht kopiert werden: ${err?.message || err}`);
          }
        }
      }

      result.status = 'copied';
      await writeMarker({ sourceDir, targetDir, result, meta });
      info(
        `[userdata-migration] ${result.copied.length} Datei(en) aus "${sourceDir}" nach "${targetDir}" uebernommen`
        + (result.errors.length ? `, ${result.errors.length} Fehler` : ''),
      );
      return result;
    } catch (err) {
      result.status = 'failed';
      result.errors.push({ file: null, message: err?.message || String(err) });
      warn(`[userdata-migration] fehlgeschlagen: ${err?.message || err}`);
      return result;
    }
  }

  return { migrateLegacyUserData };
}

module.exports = {
  createUserDataMigration,
  MIGRATION_MARKER_FILENAME,
  MIGRATED_FILENAMES,
};
