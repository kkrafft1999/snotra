const path = require('path');
const { LIMITS } = require('../../shared/limits');
const { formatBytesDe } = require('../../shared/runtime/format-bytes');

/**
 * Entscheidet, ob ein Import nativ bestätigt werden muss (Issue #101).
 *
 * Ordner immer — sie bringen unbekannt viel mit. Sonst erst ab einer Menge,
 * bei der ein Versehen weh tut. Eine einzelne kleine Datei geht durch, damit
 * der Alltag nicht leidet.
 */
function needsImportConfirmation(inspection, limits = LIMITS) {
  if (!inspection) return true;
  if ((inspection.dirs || 0) > 0) return true;
  if ((inspection.files || 0) >= limits.IMPORT_CONFIRM_MIN_ENTRIES) return true;
  return (inspection.bytes || 0) >= limits.IMPORT_CONFIRM_MIN_BYTES;
}

function countPhrase(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Klartext für den Bestätigungsdialog: „3 Ordner und 128 Dateien (4,2 MB)“. */
function formatImportSummary(inspection) {
  const parts = [];
  if (inspection.dirs > 0) parts.push(countPhrase(inspection.dirs, 'Ordner', 'Ordner'));
  if (inspection.files > 0 || parts.length === 0) {
    parts.push(countPhrase(inspection.files || 0, 'Datei', 'Dateien'));
  }
  return `${parts.join(' und ')} (${formatBytesDe(inspection.bytes || 0)})`;
}

function formatSkipNote(inspection) {
  const notes = [];
  if (inspection.skippedSymlinks > 0) {
    notes.push(`${countPhrase(inspection.skippedSymlinks, 'Verknüpfung wird', 'Verknüpfungen werden')} übersprungen.`);
  }
  if (inspection.skippedSensitive > 0) {
    notes.push(
      `${countPhrase(inspection.skippedSensitive, 'Datei sieht', 'Dateien sehen')} nach Zugangsdaten aus und `
      + `${inspection.skippedSensitive === 1 ? 'wird' : 'werden'} übersprungen.`
    );
  }
  return notes.join(' ');
}

function registerFsHandlers({
  ipcMain,
  filesystem,
  REQ,
  PUSH = null,
  fileContextMenu = null,
  getMainWindow = () => null,
  dialog = null,
  limits = LIMITS,
}) {
  ipcMain.handle(REQ.FS_READ_DIRECTORY, async (_event, dirPath) =>
    filesystem.readDirectory(dirPath));

  ipcMain.handle(REQ.FS_MOVE_ITEM, async (_event, sourcePath, destDir) =>
    filesystem.moveItem(sourcePath, destDir));

  ipcMain.handle(REQ.FS_READ_FILE, async (_event, filePath) =>
    filesystem.readFilePreview(filePath));

  ipcMain.handle(REQ.FS_LIST_WORKSPACE_PATHS, async () =>
    filesystem.listWorkspacePaths());

  function showMessageBox(options) {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  }

  // Issue #101: Dateien und Ordner von außen per Drag & Drop übernehmen.
  // Nur zählen, nichts schreiben — der Renderer nutzt das beratend (Busy-
  // Anzeige, leerer Drop). Verbindlich prüft FS_IMPORT_ITEMS noch einmal.
  ipcMain.handle(REQ.FS_INSPECT_IMPORT, async (_event, sourcePaths, destDir) =>
    filesystem.inspectImport(sourcePaths, destDir));

  // Der Renderer stößt nur an; geprüft, bestätigt und kopiert wird hier.
  // Dasselbe Muster wie bei den schutzlockernden Aktionen aus #66: Main
  // bestätigt nativ, weil der Renderer keine Sicherheitsgrenze ist
  // (docs/sicherheitskonzept.md §5).
  ipcMain.handle(REQ.FS_IMPORT_ITEMS, async (_event, sourcePaths, destDir) => {
    const inspection = await filesystem.inspectImport(sourcePaths, destDir);
    if (inspection.error) {
      if (dialog) {
        await showMessageBox({
          type: 'error',
          buttons: ['OK'],
          noLink: true,
          message: 'Übernehmen nicht möglich',
          detail: inspection.error,
        });
      }
      return { error: inspection.error };
    }

    if (inspection.dirs === 0 && inspection.files === 0) {
      return { ok: true, copied: [], dirs: 0, files: 0, bytes: 0 };
    }

    if (needsImportConfirmation(inspection, limits)) {
      if (!dialog) return { error: 'Bestätigung nicht verfügbar.' };
      const skipNote = formatSkipNote(inspection);
      // Der aufgelöste Zielpfad aus der Prüfung, nicht der Rohwert aus dem
      // Renderer — im Dialog soll stehen, wohin wirklich kopiert wird.
      const target = inspection.destDir || destDir;
      const { response } = await showMessageBox({
        type: 'question',
        buttons: ['Kopieren', 'Abbrechen'],
        // „Abbrechen“ als Standard- und Escape-Antwort, damit Enter nichts kopiert (#59).
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: `${formatImportSummary(inspection)} nach „${path.basename(target)}“ kopieren?`,
        detail: `${target}${skipNote ? `\n\n${skipNote}` : ''}`,
      });
      if (response !== 0) return { cancelled: true };
    }

    const result = await filesystem.importItems(sourcePaths, destDir);
    if (result.error && dialog) {
      await showMessageBox({
        type: 'error',
        buttons: ['OK'],
        noLink: true,
        message: 'Übernehmen fehlgeschlagen',
        detail: result.error,
      });
    }
    return result;
  });

  // Issue #58: Kontextmenü im Dateibaum. Der Pfad wird wie bei allen fs-Kanälen
  // gegen den aktiven Workspace geprüft, bevor er an die Shell geht.
  // isDirectory steuert nur den Zuschnitt des Menüs (#120) — die Pfadprüfung
  // hängt nicht daran, das Flag aus dem Renderer ist also unkritisch.
  ipcMain.handle(REQ.FS_SHOW_FILE_CONTEXT_MENU, async (_event, filePath, { isDirectory = false } = {}) => {
    if (!fileContextMenu) return { error: 'Kontextmenü nicht verfügbar.' };
    const { absPath, error } = await filesystem.resolveWorkspacePath(filePath);
    if (error) return { error };
    const win = getMainWindow();
    fileContextMenu.popup(absPath, win, {
      isDirectory,
      // Nach dem Löschen (Papierkorb) den Baum im Renderer nachziehen.
      onDeleted: (deletedPath) => {
        if (PUSH && win && !win.isDestroyed()) {
          win.webContents.send(PUSH.FS_ITEM_DELETED, { path: deletedPath });
        }
      },
    });
    return { ok: true };
  });
}

module.exports = { registerFsHandlers, needsImportConfirmation, formatImportSummary };
