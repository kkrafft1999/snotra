'use strict';

const path = require('path');

/**
 * Kontextmenü für Dateien im Dateibaum (Issues #58, #59).
 *
 * Baut ein natives Electron-Menü mit Dateioperationen. Die Pfadprüfung gegen
 * den Workspace passiert vorher im IPC-Handler; hier kommt nur noch ein
 * bereits validierter absoluter Pfad an.
 */

const REVEAL_LABELS = Object.freeze({
  darwin: 'Im Finder anzeigen',
  win32: 'Im Explorer anzeigen',
});

function revealLabelForPlatform(platform) {
  return REVEAL_LABELS[platform] || 'Im Dateimanager anzeigen';
}

function createFileContextMenu({ Menu, shell, dialog = null, platform = process.platform, logger = console }) {
  const revealLabel = revealLabelForPlatform(platform);

  async function openWithDefaultApp(filePath) {
    // shell.openPath löst mit '' auf, wenn es geklappt hat, sonst mit Fehlertext.
    const failure = await shell.openPath(filePath);
    if (failure) logger.warn('Datei konnte nicht geöffnet werden:', failure);
  }

  function revealInFileManager(filePath) {
    shell.showItemInFolder(filePath);
  }

  function showMessageBox(window, options) {
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  }

  /**
   * Sicherheitsabfrage, dann Papierkorb (shell.trashItem) statt hartem Löschen.
   * „Abbrechen“ ist Standard- und Escape-Antwort, damit Enter nichts löscht.
   * Ergebnis: { cancelled } | { deleted } | { error }.
   */
  async function deleteWithConfirmation(filePath, window) {
    if (!dialog) return { error: 'Kein Dialog verfügbar.' };
    const { response } = await showMessageBox(window, {
      type: 'warning',
      buttons: ['Löschen', 'Abbrechen'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: `„${path.basename(filePath)}“ löschen?`,
      detail: `${filePath}\n\nDie Datei wird in den Papierkorb verschoben.`,
    });
    if (response !== 0) return { cancelled: true };

    try {
      await shell.trashItem(filePath);
      return { deleted: true };
    } catch (err) {
      const message = err?.message ?? String(err);
      logger.warn('Datei konnte nicht gelöscht werden:', message);
      await showMessageBox(window, {
        type: 'error',
        buttons: ['OK'],
        message: 'Löschen fehlgeschlagen',
        detail: `${filePath}\n\n${message}`,
      });
      return { error: message };
    }
  }

  function buildTemplate(filePath, { window = null, onDeleted = null } = {}) {
    return [
      { label: 'Öffnen', click: () => openWithDefaultApp(filePath) },
      { label: revealLabel, click: () => revealInFileManager(filePath) },
      { type: 'separator' },
      {
        label: 'Löschen…',
        click: async () => {
          const result = await deleteWithConfirmation(filePath, window);
          if (result.deleted && typeof onDeleted === 'function') onDeleted(filePath);
          return result;
        },
      },
    ];
  }

  function popup(filePath, window, { onDeleted = null } = {}) {
    const menu = Menu.buildFromTemplate(buildTemplate(filePath, { window, onDeleted }));
    menu.popup(window ? { window } : {});
    return menu;
  }

  return { buildTemplate, popup, revealLabel, deleteWithConfirmation };
}

module.exports = { createFileContextMenu, revealLabelForPlatform };
