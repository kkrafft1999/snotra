'use strict';

const path = require('path');
const { createFileInfo, formatFields } = require('./file-info');

/**
 * Kontextmenü für Dateien und Ordner im Dateibaum (Issues #58, #59, #120, #123).
 *
 * Baut ein natives Electron-Menü mit Dateioperationen. Die Pfadprüfung gegen
 * den Workspace passiert vorher im IPC-Handler; hier kommt nur noch ein
 * bereits validierter absoluter Pfad an.
 *
 * Ordner bekommen dasselbe Menü ohne „Öffnen“: Auf- und Zuklappen erledigt
 * schon der Linksklick im Baum, und „mit Standardprogramm öffnen“ hätte für
 * einen Ordner keine sinnvolle Bedeutung.
 */

const REVEAL_LABELS = Object.freeze({
  darwin: 'Im Finder anzeigen',
  win32: 'Im Explorer anzeigen',
});

function revealLabelForPlatform(platform) {
  return REVEAL_LABELS[platform] || 'Im Dateimanager anzeigen';
}

function createFileContextMenu({
  Menu,
  shell,
  dialog = null,
  clipboard = null,
  platform = process.platform,
  logger = console,
  fileInfo = null,
}) {
  const revealLabel = revealLabelForPlatform(platform);
  const info = fileInfo || createFileInfo({ platform, logger });

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
  async function deleteWithConfirmation(filePath, window, { isDirectory = false } = {}) {
    if (!dialog) return { error: 'Kein Dialog verfügbar.' };
    const hint = isDirectory
      ? 'Der Ordner wird mit seinem gesamten Inhalt in den Papierkorb verschoben.'
      : 'Die Datei wird in den Papierkorb verschoben.';
    const { response } = await showMessageBox(window, {
      type: 'warning',
      buttons: ['Löschen', 'Abbrechen'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: `„${path.basename(filePath)}“ löschen?`,
      detail: `${filePath}\n\n${hint}`,
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

  /**
   * Issue #123: „Informationen“ als nativer Dialog — dieselbe Machart wie die
   * Lösch-Rückfrage, kein neuer Renderer-Code, auf allen drei Plattformen
   * sofort richtig gesetzt.
   *
   * Der zweite Knopf legt den vollständigen Pfad in die Zwischenablage; ohne
   * `clipboard` gibt es ihn nicht, statt einen toten Knopf zu zeigen.
   * Ergebnis: { shown } | { copied } | { error }.
   */
  async function showInfo(filePath, window, { isDirectory = false } = {}) {
    if (!dialog) return { error: 'Kein Dialog verfügbar.' };

    const described = await info.describe(filePath, { isDirectory });
    if (described.error) {
      logger.warn('Informationen konnten nicht gelesen werden:', described.error);
      await showMessageBox(window, {
        type: 'error',
        buttons: ['OK'],
        noLink: true,
        message: 'Informationen nicht verfügbar',
        detail: `${filePath}\n\n${described.error}`,
      });
      return { error: described.error };
    }

    const canCopy = Boolean(clipboard && typeof clipboard.writeText === 'function');
    const { response } = await showMessageBox(window, {
      type: 'info',
      buttons: canCopy ? ['OK', 'Pfad kopieren'] : ['OK'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: `Informationen zu „${described.name}“`,
      detail: formatFields(described.fields),
    });

    if (canCopy && response === 1) {
      clipboard.writeText(described.path);
      return { copied: true };
    }
    return { shown: true };
  }

  function buildTemplate(filePath, { window = null, onDeleted = null, isDirectory = false } = {}) {
    return [
      ...(isDirectory ? [] : [{ label: 'Öffnen', click: () => openWithDefaultApp(filePath) }]),
      { label: revealLabel, click: () => revealInFileManager(filePath) },
      {
        label: 'Informationen',
        // Der Klick-Handler wird nicht abgewartet: Eine Ablehnung — etwa weil
        // das Fenster während des Dialogs zugeht — wäre sonst eine
        // unbehandelte Rejection und damit ein Absturz des Main-Prozesses.
        click: () => {
          showInfo(filePath, window, { isDirectory }).catch((err) => {
            logger.warn('Informationen konnten nicht angezeigt werden:', err?.message ?? err);
          });
        },
      },
      { type: 'separator' },
      {
        label: 'Löschen…',
        click: async () => {
          const result = await deleteWithConfirmation(filePath, window, { isDirectory });
          if (result.deleted && typeof onDeleted === 'function') onDeleted(filePath);
          return result;
        },
      },
    ];
  }

  function popup(filePath, window, { onDeleted = null, isDirectory = false } = {}) {
    const menu = Menu.buildFromTemplate(buildTemplate(filePath, { window, onDeleted, isDirectory }));
    menu.popup(window ? { window } : {});
    return menu;
  }

  return { buildTemplate, popup, revealLabel, deleteWithConfirmation, showInfo };
}

module.exports = { createFileContextMenu, revealLabelForPlatform };
