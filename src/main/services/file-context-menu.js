'use strict';

const path = require('path');
const { createFileInfo, formatFields } = require('./file-info');
const { createTranslator } = require('../../shared/i18n');

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

const REVEAL_KEYS = Object.freeze({
  darwin: 'contextMenu.reveal.darwin',
  win32: 'contextMenu.reveal.win32',
});

function revealLabelForPlatform(platform, locale) {
  return createTranslator(locale)(REVEAL_KEYS[platform] || 'contextMenu.reveal.other');
}

function createFileContextMenu({
  Menu,
  shell,
  dialog = null,
  clipboard = null,
  platform = process.platform,
  logger = console,
  fileInfo = null,
  // The language is read afresh every time the menu opens (epic #277): a
  // context menu lives only until the click, so a rebuild is unnecessary.
  getLocale = () => undefined,
}) {
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
    const t = createTranslator(getLocale());
    if (!dialog) return { error: t('contextMenu.noDialog') };
    const hint = t(isDirectory ? 'contextMenu.delete.directory' : 'contextMenu.delete.file');
    const { response } = await showMessageBox(window, {
      type: 'warning',
      buttons: [t('contextMenu.delete.confirm'), t('contextMenu.delete.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: t('contextMenu.delete.confirmTitle', { name: path.basename(filePath) }),
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
        buttons: [t('contextMenu.ok')],
        message: t('contextMenu.delete.failedTitle'),
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
    const t = createTranslator(getLocale());
    if (!dialog) return { error: t('contextMenu.noDialog') };

    // Die Sprache geht mit: Die Feldnamen, die Typangaben und die Zahlen- und
    // Datumsformate der Tabelle entstehen erst in `describe()` (#292).
    const described = await info.describe(filePath, { isDirectory, locale: t.locale });
    if (described.error) {
      logger.warn('Informationen konnten nicht gelesen werden:', described.error);
      await showMessageBox(window, {
        type: 'error',
        buttons: [t('contextMenu.ok')],
        noLink: true,
        message: t('contextMenu.info.unavailable'),
        detail: `${filePath}\n\n${described.error}`,
      });
      return { error: described.error };
    }

    const canCopy = Boolean(clipboard && typeof clipboard.writeText === 'function');
    const { response } = await showMessageBox(window, {
      type: 'info',
      buttons: canCopy ? [t('contextMenu.ok'), t('contextMenu.info.copyPath')] : [t('contextMenu.ok')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: t('contextMenu.info.title', { name: described.name }),
      detail: formatFields(described.fields),
    });

    if (canCopy && response === 1) {
      clipboard.writeText(described.path);
      return { copied: true };
    }
    return { shown: true };
  }

  function buildTemplate(filePath, { window = null, onDeleted = null, isDirectory = false } = {}) {
    const t = createTranslator(getLocale());
    return [
      ...(isDirectory ? [] : [{ label: t('contextMenu.open'), click: () => openWithDefaultApp(filePath) }]),
      { label: revealLabelForPlatform(platform, getLocale()), click: () => revealInFileManager(filePath) },
      {
        label: t('contextMenu.info'),
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
        label: t('contextMenu.delete'),
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

  return {
    buildTemplate,
    popup,
    get revealLabel() { return revealLabelForPlatform(platform, getLocale()); },
    deleteWithConfirmation,
    showInfo,
  };
}

module.exports = { createFileContextMenu, revealLabelForPlatform };
