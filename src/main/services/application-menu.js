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

/** The user manual (#777); the German pages live under `/de/`. */
const MANUAL_URLS = Object.freeze({
  en: 'https://docs.snotra-ai.dev/',
  de: 'https://docs.snotra-ai.dev/de/',
});

/** Ids of the items the main process changes after the menu is built. */
const MENU_ITEM_IDS = Object.freeze({
  SHOW_HIDDEN_FILES: 'view.showHiddenFiles',
});

/**
 * `locale` decides the labels (epic #277). The menu belongs to the main process
 * and is rebuilt on a language change — Electron cannot rename an item after
 * the fact. `showHiddenFiles` ticks the checkbox of the same name (#436).
 */
function createApplicationMenuTemplate({
  appName,
  platform = process.platform,
  getMainWindow,
  shell,
  PUSH,
  onCheckForUpdates,
  locale,
  showHiddenFiles = false,
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
      // #436: dot files in the tree, next to the sidebar they belong to. The
      // renderer holds the state and answers with it, which ticks this box via
      // MENU_ITEM_IDS. The accelerator is only shown here: Shift+. types a
      // colon on a German keyboard, so the menu would miss it there. The
      // window matches the physical key instead (hidden-files-shortcut.js),
      // the same way on every platform.
      {
        id: MENU_ITEM_IDS.SHOW_HIDDEN_FILES,
        label: t('menu.view.showHiddenFiles'),
        type: 'checkbox',
        checked: showHiddenFiles === true,
        accelerator: 'CmdOrCtrl+Shift+.',
        registerAccelerator: false,
        click: () => send(PUSH.UI_TOGGLE_HIDDEN_FILES),
      },
      // #350: the tree's filter, from anywhere — the chat input included,
      // which is why the shortcut hangs on the item. The renderer opens the
      // sidebar with it if needed, and does nothing without a folder.
      {
        label: t('menu.view.filterFiles'),
        accelerator: 'CmdOrCtrl+P',
        click: () => send(PUSH.UI_FILTER_FILES),
      },
      // #822: back and forward through the files the preview showed. Only
      // shown: the window matches the physical key (preview-history-shortcut.js)
      // — `[` is Option+5 on a German Mac keyboard.
      {
        label: t('menu.view.back'),
        accelerator: isMac ? 'Cmd+[' : 'Alt+Left',
        registerAccelerator: false,
        click: () => send(PUSH.UI_PREVIEW_BACK),
      },
      {
        label: t('menu.view.forward'),
        accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
        registerAccelerator: false,
        click: () => send(PUSH.UI_PREVIEW_FORWARD),
      },
      // Issue #344: switches a Markdown file in the preview between the
      // rendered text and its source. Not Cmd/Ctrl+Shift+V, the shortcut of
      // other editors — on the Mac that is "Paste and Match Style" in every
      // text field, the chat input included. Does nothing unless a Markdown
      // file or, since #345, an SVG is on show.
      {
        label: t('menu.view.toggleMarkdownSource'),
        accelerator: 'CmdOrCtrl+Shift+M',
        click: () => send(PUSH.UI_TOGGLE_MARKDOWN_SOURCE),
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
        label: t('menu.help.manual'),
        click: () => shell.openExternal(MANUAL_URLS[locale] ?? MANUAL_URLS.en),
      },
      { type: 'separator' },
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

module.exports = { createApplicationMenuTemplate, MENU_ITEM_IDS, MANUAL_URLS };
