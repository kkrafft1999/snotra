/**
 * Der Ordnerdialog ist der einzige Weg, auf dem ein bisher unbekannter Pfad
 * zum aktiven Workspace wird (Issue #68): Auswahl und Aktivierung passieren
 * in einem Main-Vorgang, der Renderer bekommt den Pfad erst danach zu sehen.
 */

/**
 * Startverzeichnis des Dialogs.
 *
 * Bis Electron 42 entschied das Betriebssystem, wo ein Dialog ohne
 * `defaultPath` aufgeht — in der Regel dort, wo der Nutzer zuletzt war.
 * Seit Electron 43 setzt Electron in dem Fall fest den Downloads-Ordner und
 * das OS merkt sich den letzten Ort nicht mehr. Damit der Dialog weiterhin
 * dort startet, wo gearbeitet wird, reichen wir den zuletzt aktiven
 * Workspace-Ordner selbst durch.
 *
 * Fehler sind hier bewusst folgenlos: ohne gueltigen Pfad oeffnet der Dialog
 * einfach mit dem Standardverhalten.
 */
async function resolveDefaultPath(workspaceFolderStore) {
  if (!workspaceFolderStore || typeof workspaceFolderStore.getValidatedLastFolder !== 'function') {
    return null;
  }
  try {
    const folder = await workspaceFolderStore.getValidatedLastFolder();
    return typeof folder === 'string' && folder.trim() ? folder : null;
  } catch {
    return null;
  }
}

function registerDialogHandlers({
  ipcMain,
  dialog,
  getMainWindow,
  workspaceActivation,
  workspaceFolderStore,
  REQ,
}) {
  ipcMain.handle(REQ.DIALOG_OPEN_FOLDER, async () => {
    const options = {
      title: 'Ordner auswählen',
      buttonLabel: 'Ordner öffnen',
      message: 'Wähle einen Ordner aus, der angezeigt werden soll',
      properties: ['openDirectory'],
    };
    const defaultPath = await resolveDefaultPath(workspaceFolderStore);
    if (defaultPath) options.defaultPath = defaultPath;

    const result = await dialog.showOpenDialog(getMainWindow(), options);
    if (result.canceled || result.filePaths.length === 0) return null;
    if (!workspaceActivation) return result.filePaths[0];
    return workspaceActivation.activateChosenFolder(result.filePaths[0]);
  });
}

module.exports = { registerDialogHandlers };
