'use strict';

const path = require('path');
const { LIMITS } = require('../../shared/limits');
const { createSensitivePathMatcher } = require('../../shared/runtime/sensitive-paths');
const { createTranslator } = require('../../shared/i18n');

/**
 * Why a folder of the tree could not be listed (#639), as the code the
 * renderer looks its words up by: no right to read it (a volume of another
 * user, a folder macOS privacy settings keep closed), gone in the meantime,
 * or anything else. 'refused' — outside the workspace — comes from boundPath().
 */
function unreadableReason(err) {
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return 'permission';
  if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return 'missing';
  return 'failed';
}

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

  // A refusal carries a `reason` in the codes of unreadableReason() (#641):
  // 'refused' only for a path that really lies outside the workspace,
  // lexically or through a link. A path component without read permission
  // or a dangling link is what its error says, and without a workspace
  // nothing can be read at all.
  async function boundPath(absPath) {
    const workspaceRoot = getActiveWorkspaceRoot();
    const result = await fsService.assertPathAccessibleInWorkspace(workspaceRoot, absPath);
    if (!result.error) return result;
    let reason = 'refused';
    if (!workspaceRoot) reason = 'failed';
    else if (result.code) reason = unreadableReason(result);
    return { error: result.error, reason };
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
    // `showHidden` (#436) comes from the renderer: whether hidden files are
    // shown is a view setting, not a boundary — the path check stays as it is.
    // A folder that cannot be listed says why in `unreadable` (#639), so the
    // tree can say so in its place instead of drawing it empty.
    async readDirectory(dirPath, options) {
      const { absPath, error, reason } = await boundPath(dirPath);
      if (error) {
        console.error('readDirectory denied:', error);
        return { entries: [], hidden: 0, unreadable: reason };
      }
      try {
        return await fsService.readDirectory(absPath, { showHidden: options?.showHidden === true });
      } catch (err) {
        console.error('readDirectory error:', err.message);
        return { entries: [], hidden: 0, unreadable: unreadableReason(err) };
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
    async listWorkspacePaths(options) {
      const workspaceRoot = getActiveWorkspaceRoot();
      if (!workspaceRoot) {
        return { entries: [], truncated: false, error: ui()('fs.error.noWorkspace') };
      }
      try {
        return await fsService.listWorkspacePaths(workspaceRoot, { showHidden: options?.showHidden === true });
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
    // PDF for the file preview (#346), against the active folder like an image.
    async readWorkspacePdf(pdfPath) {
      return fsService.readWorkspacePdf(getActiveWorkspaceRoot(), pdfPath);
    },
    // A failed read carries a `reason` next to its `error` (CR-B18-09, #641):
    // the message is the system's — English, with the full path in it — and
    // fit for the log; the renderer says why in the interface language
    // (`renderer/file-views/read-failures.js`). The codes are the listing's
    // above, plus 'too-large'.
    async readFilePreview(filePath) {
      const { absPath, error, reason } = await boundPath(filePath);
      if (error) return { error, reason };
      try {
        const result = await fsService.readFilePreview(absPath);
        // The one refusal the service answers instead of throwing: a file
        // over the preview limit. It brings the size along.
        return result?.error ? { ...result, reason: 'too-large' } : result;
      } catch (err) {
        return { error: err.message, reason: unreadableReason(err) };
      }
    },
  };
}

module.exports = {
  createFilesystemIpcAdapter,
};
