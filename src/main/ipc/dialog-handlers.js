/**
 * Der Ordnerdialog ist der einzige Weg, auf dem ein bisher unbekannter Pfad
 * zum aktiven Workspace wird (Issue #68): Auswahl und Aktivierung passieren
 * in einem Main-Vorgang, der Renderer bekommt den Pfad erst danach zu sehen.
 */
function registerDialogHandlers({ ipcMain, dialog, getMainWindow, workspaceActivation, REQ }) {
  ipcMain.handle(REQ.DIALOG_OPEN_FOLDER, async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Ordner auswählen',
      buttonLabel: 'Ordner öffnen',
      message: 'Wähle einen Ordner aus, der angezeigt werden soll',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    if (!workspaceActivation) return result.filePaths[0];
    return workspaceActivation.activateChosenFolder(result.filePaths[0]);
  });
}

module.exports = { registerDialogHandlers };
