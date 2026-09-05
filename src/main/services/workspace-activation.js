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
 */
function createWorkspaceActivation({ fs, path, workspaceFolderStore, setActiveWorkspaceRoot }) {
  function resolveCandidate(folderPath) {
    const raw = typeof folderPath === 'string' ? folderPath.trim() : '';
    if (!raw) return null;
    return path.resolve(raw);
  }

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

  async function activate(resolved) {
    if (!resolved || !(await isExistingDirectory(resolved))) return null;
    await workspaceFolderStore.persistLastFolder(resolved);
    setActiveWorkspaceRoot(resolved);
    return resolved;
  }

  async function activateChosenFolder(folderPath) {
    return activate(resolveCandidate(folderPath));
  }

  async function activateKnownFolder(folderPath) {
    const resolved = resolveCandidate(folderPath);
    if (!resolved) return null;
    const known = await listKnownFolders();
    if (!known.has(resolved)) return null;
    return activate(resolved);
  }

  return { activateChosenFolder, activateKnownFolder };
}

module.exports = { createWorkspaceActivation };
