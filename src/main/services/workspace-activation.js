'use strict';

/**
 * Der aktive Workspace ist die Vertrauensgrenze des Dateisystems (Issue #68).
 * Deshalb wird er ausschliesslich hier im Main-Prozess gesetzt, nie durch
 * einen frei uebergebenen Pfad aus dem Renderer:
 *
 *  - `activateChosenFolder` laeuft nach einer echten Auswahl im nativen
 *    Ordnerdialog. Nur dieser Weg nimmt einen bisher unbekannten Pfad an und
 *    schreibt ihn in `last-folder.json` und den Verlauf.
 *  - `activateKnownFolder` bedient Verlaufsmenue, Welcome-Chips und die
 *    Wiederherstellung beim Start. Der Pfad muss bereits im gespeicherten,
 *    erneut validierten Verlauf (oder als letzter Ordner) stehen.
 *
 * Beide liefern den aufgeloesten Pfad oder `null`; `null` heisst „nicht
 * aktiviert“, der bisherige Root bleibt dann unveraendert.
 *
 * `onWorkspaceChanged` hears of an activation that changed the root, with the
 * new one — opening the folder that is already open is no change, and the
 * approvals, watchers and caches tied to it stay (concept §7).
 *
 * @param {object} deps
 * @param {Pick<typeof import('fs').promises, 'stat'>} deps.fs
 * @param {Pick<typeof import('path'), 'resolve'>} deps.path
 * @param {Pick<import('../ports/workspace-folder-store-port').WorkspaceFolderStorePort, 'getValidatedFolderHistory' | 'getValidatedLastFolder' | 'persistLastFolder'>} deps.workspaceFolderStore
 * @param {(folderPath: string | null) => void} deps.setActiveWorkspaceRoot
 * @param {() => string | null} [deps.getActiveWorkspaceRoot]
 * @param {((root: string | null) => void) | null} [deps.onWorkspaceChanged]
 * @param {Pick<Console, 'warn'>} [deps.log]
 */
function createWorkspaceActivation({
  fs,
  path,
  workspaceFolderStore,
  setActiveWorkspaceRoot,
  getActiveWorkspaceRoot = () => null,
  onWorkspaceChanged = null,
  log = console,
}) {
  /**
   * @param {unknown} folderPath
   * @returns {string | null}
   */
  function resolveCandidate(folderPath) {
    const raw = typeof folderPath === 'string' ? folderPath.trim() : '';
    if (!raw) return null;
    return path.resolve(raw);
  }

  /**
   * @param {string} absPath
   */
  async function isExistingDirectory(absPath) {
    try {
      const st = await fs.stat(absPath);
      return st.isDirectory();
    } catch {
      return false;
    }
  }

  async function listKnownFolders() {
    const known = new Set();
    const history = await workspaceFolderStore.getValidatedFolderHistory();
    if (Array.isArray(history)) {
      for (const entry of history) {
        const resolved = resolveCandidate(entry);
        if (resolved) known.add(resolved);
      }
    }
    // Der zuletzt geoeffnete Ordner kann aus dem Verlauf entfernt worden sein
    // (Issue #57) und muss trotzdem beim Start wieder aktivierbar sein.
    const last = resolveCandidate(await workspaceFolderStore.getValidatedLastFolder());
    if (last) known.add(last);
    return known;
  }

  /**
   * @param {string | null} resolved
   */
  async function activate(resolved) {
    if (!resolved || !(await isExistingDirectory(resolved))) return null;
    // Remembering the folder is a convenience; opening it goes on when that
    // fails — a full disk or a read-only userData (#473, #650).
    try {
      await workspaceFolderStore.persistLastFolder(resolved);
    } catch (error) {
      log.warn?.(`Could not remember the last opened folder: ${error?.message ?? error}`);
    }
    const before = getActiveWorkspaceRoot();
    setActiveWorkspaceRoot(resolved);
    const after = getActiveWorkspaceRoot();
    if (after !== before) onWorkspaceChanged?.(after);
    return resolved;
  }

  /**
   * @param {unknown} folderPath
   */
  async function activateChosenFolder(folderPath) {
    return activate(resolveCandidate(folderPath));
  }

  /**
   * @param {unknown} folderPath
   */
  async function activateKnownFolder(folderPath) {
    const resolved = resolveCandidate(folderPath);
    if (!resolved) return null;
    if (!(await isKnownFolder(resolved))) return null;
    return activate(resolved);
  }

  /**
   * Ist der Pfad ein Ordner, den der Nutzer schon einmal geoeffnet hat? Der
   * Chat-Verlauf braucht das, um eine Konversation beim Ordnerwechsel beim
   * *alten* Ordner zu belassen (Issue #131), ohne dafuer einen beliebigen
   * Renderer-Pfad zu uebernehmen.
   *
   * @param {unknown} folderPath
   */
  async function isKnownFolder(folderPath) {
    const resolved = resolveCandidate(folderPath);
    if (!resolved) return false;
    const known = await listKnownFolders();
    return known.has(resolved);
  }

  return { activateChosenFolder, activateKnownFolder, isKnownFolder };
}

module.exports = { createWorkspaceActivation };
