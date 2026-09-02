'use strict';

// Einmalige Uebernahme des userData-Ordners der Vorgaenger-Identitaet
// ("Weyouze Anything") in den Ordner der aktuellen App ("Snotra AI").
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

function createUserDataMigration({ fs, path, log = console } = {}) {
  if (!fs || !path) {
    throw new Error('createUserDataMigration requires fs (promises API) and path');
  }

  const info = (msg) => { if (typeof log?.info === 'function') log.info(msg); };
  const warn = (msg) => { if (typeof log?.warn === 'function') log.warn(msg); };

  async function exists(p) {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  async function isDirectory(p) {
    try {
      return (await fs.stat(p)).isDirectory();
    } catch {
      return false;
    }
  }

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
      await fs.writeFile(path.join(targetDir, MIGRATION_MARKER_FILENAME), JSON.stringify(marker, null, 2), 'utf8');
    } catch (err) {
      warn(`[userdata-migration] Marker konnte nicht geschrieben werden: ${err?.message || err}`);
    }
  }

  /**
   * @returns {Promise<{status: string, copied: string[], skipped: string[], errors: Array<{file: string|null, message: string}>}>}
   *   status: 'copied' | 'skipped-marker' | 'skipped-target-populated'
   *         | 'skipped-no-source' | 'skipped-same-dir' | 'failed'
   *   Wirft nie; der App-Start darf an der Migration nicht scheitern.
   */
  async function migrateLegacyUserData({ sourceDir, targetDir, meta } = {}) {
    const result = { status: 'failed', copied: [], skipped: [], errors: [] };
    try {
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
          if (err && err.code === 'EEXIST') {
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
