'use strict';

/**
 * Die Menueleiste der App (Issues #167, #266, #381).
 *
 * Gebaut wird nur das Template — Menu.buildFromTemplate bleibt beim Aufrufer,
 * damit dieses Modul ohne laufendes Electron geprueft werden kann. Alles, was
 * die Eintraege auesserlich unterscheidet, haengt an `platform`: auf macOS
 * gibt es das App-Menue neben dem Apfel, auf Windows und Linux nicht.
 */

const { createTranslator } = require('../../shared/i18n');

/**
 * „Einstellungen…“ hat auf jeder Plattform dasselbe Kuerzel, aber nicht
 * denselben Platz: Auf dem Mac gehoert der Eintrag ins App-Menue gleich unter
 * „Ueber“, sonst ins Menue „Ansicht“. Genau einmal — zweimal dasselbe Label in
 * der Leiste hiesse auch `CmdOrCtrl+,` zweimal vergeben.
 */
function createSettingsItem(openSettings, t) {
  return {
    label: t('menu.settings'),
    accelerator: 'CmdOrCtrl+,',
    click: openSettings,
  };
}

/**
 * `locale` decides the labels (epic #277). The menu belongs to the main process
 * and is rebuilt on a language change — Electron cannot rename an item after
 * the fact.
 */
function createApplicationMenuTemplate({
  appName,
  platform = process.platform,
  getMainWindow,
  shell,
  PUSH,
  onCheckForUpdates,
  locale,
}) {
  const t = createTranslator(locale);
  // Auf macOS muss das ERSTE Submenu den App-Namen als label tragen — das ist
  // der fett gedruckte Eintrag rechts neben dem Apfel. Auf Windows/Linux gibt
  // es kein App-Menue, dort beginnen wir direkt mit Datei/Bearbeiten.
  const isMac = platform === 'darwin';

  const send = (channel) => getMainWindow()?.webContents.send(channel);
  // Der einzige Weg in die Einstellungen ist das Menue — das Zahnrad im
  // Chat-Kopf ist weg, und mit der Chat-Spalte waere es ohnehin weggeschaltet.
  const settingsItem = createSettingsItem(() => send(PUSH.UI_OPEN_SETTINGS), t);

  const macAppMenu = {
    label: appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settingsItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide', label: t('menu.app.hide', { appName }) },
      { role: 'hideOthers', label: t('menu.app.hideOthers') },
      { role: 'unhide', label: t('menu.app.unhide') },
      { type: 'separator' },
      { role: 'quit', label: t('menu.app.quit', { appName }) },
    ],
  };

  // Issue #381: "New Chat" lives where every platform keeps "New" — in the
  // File menu, which the Mac calls "Ablage" in German. Like Cmd/Ctrl+B the
  // shortcut hangs on the item, so it works with the focus anywhere.
  const fileMenu = {
    label: t(isMac ? 'menu.file.mac' : 'menu.file'),
    submenu: [
      {
        label: t('menu.file.newChat'),
        accelerator: 'CmdOrCtrl+N',
        click: () => send(PUSH.UI_NEW_CHAT),
      },
    ],
  };

  const editMenu = {
    label: t('menu.edit'),
    submenu: [
      { role: 'undo', label: t('menu.edit.undo') },
      { role: 'redo', label: t('menu.edit.redo') },
      { type: 'separator' },
      { role: 'cut', label: t('menu.edit.cut') },
      { role: 'copy', label: t('menu.edit.copy') },
      { role: 'paste', label: t('menu.edit.paste') },
      { role: 'selectAll', label: t('menu.edit.selectAll') },
    ],
  };

  const viewMenu = {
    label: t('menu.view'),
    submenu: [
      // Issue #167: das Kuerzel haengt bewusst am Menueeintrag statt an einer
      // Tastenabfrage im Renderer — so steht es sichtbar im Menue und gilt
      // auch, wenn der Fokus in einem Eingabefeld liegt.
      {
        label: t('menu.view.toggleSidebar'),
        accelerator: 'CmdOrCtrl+B',
        click: () => send(PUSH.UI_TOGGLE_SIDEBAR),
      },
      { type: 'separator' },
      ...(isMac ? [] : [settingsItem, { type: 'separator' }]),
      { role: 'reload', label: t('menu.view.reload') },
      { role: 'forceReload', label: t('menu.view.forceReload') },
      { role: 'toggleDevTools', label: t('menu.view.devTools') },
      { type: 'separator' },
      { role: 'resetZoom', label: t('menu.view.resetZoom') },
      { role: 'zoomIn', label: t('menu.view.zoomIn') },
      { role: 'zoomOut', label: t('menu.view.zoomOut') },
      { type: 'separator' },
      { role: 'togglefullscreen', label: t('menu.view.fullscreen') },
    ],
  };

  const windowMenu = {
    label: t('menu.window'),
    role: 'window',
    submenu: [
      { role: 'minimize', label: t('menu.window.minimize') },
      { role: 'zoom', label: t('menu.window.zoom') },
      ...(isMac
        ? [{ type: 'separator' }, { role: 'front', label: t('menu.window.front') }]
        : [{ role: 'close', label: t('menu.window.close') }]),
    ],
  };

  const helpMenu = {
    label: t('menu.help'),
    role: 'help',
    submenu: [
      {
        label: t('menu.help.checkUpdates'),
        click: () => { onCheckForUpdates(); },
      },
      { type: 'separator' },
      {
        label: t('menu.help.github'),
        click: () => shell.openExternal('https://github.com/kkrafft1999/snotra'),
      },
    ],
  };

  return [
    ...(isMac ? [macAppMenu] : []),
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu,
  ];
}

module.exports = { createApplicationMenuTemplate };
