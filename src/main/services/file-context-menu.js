'use strict';

/**
 * Kontextmenü für Dateien im Dateibaum (Issue #58).
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

function createFileContextMenu({ Menu, shell, platform = process.platform, logger = console }) {
  const revealLabel = revealLabelForPlatform(platform);

  async function openWithDefaultApp(filePath) {
    // shell.openPath löst mit '' auf, wenn es geklappt hat, sonst mit Fehlertext.
    const failure = await shell.openPath(filePath);
    if (failure) logger.warn('Datei konnte nicht geöffnet werden:', failure);
  }

  function revealInFileManager(filePath) {
    shell.showItemInFolder(filePath);
  }

  function buildTemplate(filePath) {
    return [
      { label: 'Öffnen', click: () => openWithDefaultApp(filePath) },
      { label: revealLabel, click: () => revealInFileManager(filePath) },
    ];
  }

  function popup(filePath, window) {
    const menu = Menu.buildFromTemplate(buildTemplate(filePath));
    menu.popup(window ? { window } : {});
    return menu;
  }

  return { buildTemplate, popup, revealLabel };
}

module.exports = { createFileContextMenu, revealLabelForPlatform };
