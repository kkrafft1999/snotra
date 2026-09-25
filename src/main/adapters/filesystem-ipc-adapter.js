'use strict';

const path = require('path');
const { LIMITS } = require('../../shared/limits');
const { createSensitivePathMatcher } = require('../../shared/runtime/sensitive-paths');
const { createTranslator } = require('../../shared/i18n');

function createFilesystemIpcAdapter({
  fsService,
  getActiveWorkspaceRoot,
  limits = LIMITS,
  sensitivePathMatcher = createSensitivePathMatcher(),
  // Everything here ends at the user — the drop dialog and the @ completion —
  // so it speaks the interface language, like fs-service's IPC side (#353).
  getLocale = () => undefined,
}) {
  const ui = () => createTranslator(getLocale());

  async function boundPath(absPath) {
    const workspaceRoot = getActiveWorkspaceRoot();
    return fsService.assertPathAccessibleInWorkspace(workspaceRoot, absPath);
  }

  // Import von außen (Issue #101). Die Prüfung ist hier bewusst asymmetrisch:
  // das **Ziel** läuft wie überall über boundPath(), die **Quelle** wird
  // absichtlich nicht gegen den Workspace geprüft — genau dafür gibt es den
  // Kanal. Stattdessen muss sie absolut sein und darf nicht nach sensiblen
  // Zugangsdaten aussehen (.env*, *.pem, id_*, .ssh/ …, Konzept §4). Wer so
  // eine Datei wirklich im Projekt haben will, legt sie über den Dateimanager
  // ab; beiläufig per Drop in Modellreichweite rutschen soll sie nicht.
  function checkImportSources(sourcePaths) {
    const sources = Array.isArray(sourcePaths)
      ? sourcePaths.filter((p) => typeof p === 'string' && p.trim())
      : [];
    const t = ui();
    if (sources.length === 0) return { error: t('fs.error.noSource') };
    for (const source of sources) {
      if (!path.isAbsolute(source)) {
        return { error: t('fs.error.sourceNotAbsolute', { path: source }) };
      }
      const verdict = sensitivePathMatcher.classifyPath(source);
      if (verdict.sensitive) {
        return {
          error: t('fs.error.sourceSensitive', { name: path.basename(source), pattern: verdict.pattern }),
        };
      }
    }
    return { sources };
  }

  // Grenzen und Symlink-/Geheimnis-Filter für den rekursiven Lauf im Service.
  const importOptions = {
    maxEntries: limits.MAX_IMPORT_ENTRIES,
    maxTotalBytes: limits.MAX_IMPORT_TOTAL_BYTES,
    isSensitiveName: (name) => sensitivePathMatcher.isSensitivePath(name),
  };

  async function prepareImport(sourcePaths, destDir) {
    const checked = checkImportSources(sourcePaths);
    if (checked.error) return { error: checked.error };
    const dest = await boundPath(destDir);
    if (dest.error) return { error: dest.error };
    return { sources: checked.sources, destDir: dest.absPath };
  }

  return {
    async readDirectory(dirPath) {
      const { absPath, error } = await boundPath(dirPath);
      if (error) {
        console.error('readDirectory denied:', error);
        return [];
      }
      try {
        return await fsService.readDirectory(absPath);
      } catch (err) {
        console.error('readDirectory error:', err.message);
        return [];
      }
    },
    async moveItem(sourcePath, destDir) {
      const source = await boundPath(sourcePath);
      if (source.error) return { error: source.error };
      const dest = await boundPath(destDir);
      if (dest.error) return { error: dest.error };
      try {
        return await fsService.moveItem(source.absPath, dest.absPath);
      } catch (err) {
        return { error: err.message };
      }
    },
    // Zählt einen Import, ohne etwas zu schreiben (#101).
    async inspectImport(sourcePaths, destDir) {
      const prepared = await prepareImport(sourcePaths, destDir);
      if (prepared.error) return { error: prepared.error };
      try {
        return await fsService.inspectImportSources(prepared.sources, prepared.destDir, importOptions);
      } catch (err) {
        return { error: err.message };
      }
    },
    async importItems(sourcePaths, destDir) {
      const prepared = await prepareImport(sourcePaths, destDir);
      if (prepared.error) return { error: prepared.error };
      try {
        return await fsService.importExternalItems(prepared.sources, prepared.destDir, importOptions);
      } catch (err) {
        return { error: err.message };
      }
    },
    // Pfadliste für die @-Vervollständigung; immer relativ zum aktiven Workspace,
    // der Renderer übergibt bewusst keinen Pfad (kein Ausbruch aus dem Root möglich).
    async listWorkspacePaths() {
      const workspaceRoot = getActiveWorkspaceRoot();
      if (!workspaceRoot) {
        return { entries: [], truncated: false, error: ui()('fs.error.noWorkspace') };
      }
      try {
        return await fsService.listWorkspacePaths(workspaceRoot);
      } catch (err) {
        return { entries: [], truncated: false, error: err.message };
      }
    },
    // Nur Pfadprüfung, keine Dateizugriffe: der Aufrufer (z. B. Kontextmenü)
    // arbeitet danach mit dem bereinigten absoluten Pfad weiter.
    async resolveWorkspacePath(filePath) {
      return boundPath(filePath);
    },
    // Bild aus dem Arbeitsordner fuer die Chat-Antwort (Issue #244). Der Pfad
    // kommt aus dem Markdown des Modells und laeuft deshalb nicht ueber
    // boundPath(): der darf hier auch relativ sein, und die Fehlergruende sind
    // Codes fuer den Platzhalter statt Saetze fuer eine Fehlermeldung.
    async readWorkspaceImage(imagePath) {
      return fsService.readWorkspaceImage(getActiveWorkspaceRoot(), imagePath);
    },
    async readFilePreview(filePath) {
      const { absPath, error } = await boundPath(filePath);
      if (error) return { error };
      try {
        return await fsService.readFilePreview(absPath);
      } catch (err) {
        return { error: err.message };
      }
    },
  };
}

module.exports = {
  createFilesystemIpcAdapter,
};
