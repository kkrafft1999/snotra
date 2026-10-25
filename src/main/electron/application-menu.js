'use strict';

/**
 * Die Menueleiste der App (Issues #167, #266, #381).
 *
 * Gebaut wird nur das Template — Menu.buildFromTemplate bleibt beim Aufrufer,
 * damit dieses Modul ohne laufendes Electron geprueft werden kann. Alles, was
 * die Eintraege auesserlich unterscheidet, haengt an `platform`: auf macOS
 * gibt es das App-Menue neben dem Apfel, auf Windows und Linux nicht.
 */

/**
 * @typedef {import('electron').MenuItemConstructorOptions} MenuItem
 * @typedef {ReturnType<typeof createTranslator>} Translator
 */

const { DEFAULT_LOCALE, LOCALES, createTranslator } = require('../../shared/i18n');
const { manualWebUrl } = require('../../shared/manual/manual-address');

/**
 * „Einstellungen…“ hat auf jeder Plattform dasselbe Kuerzel, aber nicht
 * denselben Platz: Auf dem Mac gehoert der Eintrag ins App-Menue gleich unter
 * „Ueber“, sonst ins Menue „Ansicht“. Genau einmal — zweimal dasselbe Label in
 * der Leiste hiesse auch `CmdOrCtrl+,` zweimal vergeben.
 *
 * @param {() => void} openSettings
 * @param {Translator} t
 * @returns {MenuItem}
 */
function createSettingsItem(openSettings, t) {
  return {
    label: t('menu.settings'),
    accelerator: 'CmdOrCtrl+,',
    click: openSettings,
  };
}

/**
 * The user manual on the web (#777); every language but the root one lives under `/<code>/`. Since
 * #790 *Help › User manual* opens the copy that ships with the app; the web
 * stays the way without a bundled manual (`onOpenManual` not given).
 */
const MANUAL_URLS = Object.freeze(Object.fromEntries(LOCALES.map((code) => [code, manualWebUrl(code)])));

/** Ids of the items the main process changes after the menu is built. */
const MENU_ITEM_IDS = Object.freeze({
  SHOW_HIDDEN_FILES: 'view.showHiddenFiles',
  MANUAL: 'help.manual',
});

/**
 * `locale` decides the labels (epic #277). The menu belongs to the main process
 * and is rebuilt on a language change — Electron cannot rename an item after
 * the fact. `showHiddenFiles` ticks the checkbox of the same name (#436).
 * `onCopyDiagnostics` and `onShowLog` add the two diagnostics items to the
 * Help menu (#978); without them the menu has none.
 *
 * @param {object} options
 * @param {string} options.appName
 * @param {string} [options.platform]
 * @param {() => import('electron').BrowserWindow|null} options.getMainWindow
 * @param {Pick<import('electron').Shell, 'openExternal'>} options.shell
 * @param {Record<string, string>} options.PUSH
 * @param {() => unknown} options.onCheckForUpdates
 * @param {string} [options.locale]
 * @param {boolean} [options.showHiddenFiles]
 * @param {(() => unknown)|null} [options.onOpenManual]
 * @param {((direction: 'back' | 'forward', focusedWindow: import('electron').BaseWindow|undefined) => boolean)|null} [options.routeHistoryStep]
 * @param {(() => unknown)|null} [options.onCopyDiagnostics]
 * @param {(() => unknown)|null} [options.onShowLog]
 * @returns {MenuItem[]}
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
  onOpenManual = null,
  routeHistoryStep = null,
  onCopyDiagnostics = null,
  onShowLog = null,
}) {
  const t = createTranslator(locale);
  // Auf macOS muss das ERSTE Submenu den App-Namen als label tragen — das ist
  // der fett gedruckte Eintrag rechts neben dem Apfel. Auf Windows/Linux gibt
  // es kein App-Menue, dort beginnen wir direkt mit Datei/Bearbeiten.
  const isMac = platform === 'darwin';

  /** @param {string} channel */
  const send = (channel) => getMainWindow()?.webContents.send(channel);
  // Der einzige Weg in die Einstellungen ist das Menue — das Zahnrad im
  // Chat-Kopf ist weg, und mit der Chat-Spalte waere es ohnehin weggeschaltet.
  const settingsItem = createSettingsItem(() => send(PUSH.UI_OPEN_SETTINGS), t);

  /** @type {MenuItem} */
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
  /** @type {MenuItem} */
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

  /** @type {MenuItem} */
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
      { type: 'separator' },
      // #859: dictation into the chat input. On the item, like Cmd/Ctrl+N, so
      // the shortcut works with the focus in the input — where it is wanted.
      {
        label: t('menu.edit.voiceInput'),
        accelerator: 'CmdOrCtrl+D',
        click: () => send(PUSH.UI_TOGGLE_VOICE_INPUT),
      },
    ],
  };

  /** @type {MenuItem[]} */
  // Usage & Cost (#1258) sits next to the settings; on the Mac, where they
  // live in the app menu, it keeps the same place in "View". Cmd/Ctrl+Shift+K
  // rather than +U: on Linux Ctrl+Shift+U starts the Unicode input of GTK and
  // IBus, and a text field with the focus would never let it through.
  /** @type {MenuItem} */
  const usageItem = {
    label: t('usage.menu'),
    accelerator: 'CmdOrCtrl+Shift+K',
    click: () => send(PUSH.UI_OPEN_USAGE_REPORT),
  };
  /** @type {MenuItem[]} */
  const settingsInView = isMac
    ? [usageItem, { type: 'separator' }]
    : [settingsItem, usageItem, { type: 'separator' }];

  /** @type {MenuItem} */
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
        click: (_item, focusedWindow) => {
          if (routeHistoryStep?.('back', focusedWindow)) return;
          send(PUSH.UI_PREVIEW_BACK);
        },
      },
      {
        label: t('menu.view.forward'),
        accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
        registerAccelerator: false,
        click: (_item, focusedWindow) => {
          if (routeHistoryStep?.('forward', focusedWindow)) return;
          send(PUSH.UI_PREVIEW_FORWARD);
        },
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
      ...settingsInView,
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

  /** @type {MenuItem[]} */
  const windowTail = isMac
    ? [{ type: 'separator' }, { role: 'front', label: t('menu.window.front') }]
    : [{ role: 'close', label: t('menu.window.close') }];

  /** @type {MenuItem} */
  const windowMenu = {
    label: t('menu.window'),
    role: 'window',
    submenu: [
      { role: 'minimize', label: t('menu.window.minimize') },
      { role: 'zoom', label: t('menu.window.zoom') },
      ...windowTail,
    ],
  };

  /** @type {MenuItem} */
  const helpMenu = {
    label: t('menu.help'),
    role: 'help',
    submenu: [
      {
        id: MENU_ITEM_IDS.MANUAL,
        label: t('menu.help.manual'),
        accelerator: 'F1',
        click: () => {
          if (onOpenManual) onOpenManual();
          else shell.openExternal((locale ? MANUAL_URLS[locale] : undefined) ?? MANUAL_URLS[DEFAULT_LOCALE]);
        },
      },
      { type: 'separator' },
      {
        label: t('menu.help.checkUpdates'),
        click: () => { onCheckForUpdates(); },
      },
      { type: 'separator' },
      // The feedback form (#1045); the sidebar has a button for it, too.
      { label: t('menu.help.feedback'), click: () => send(PUSH.UI_OPEN_FEEDBACK) },
      // What a bug report needs (#978): the report on the clipboard, the log in the file manager.
      ...(onCopyDiagnostics ? [{ label: t('menu.help.copyDiagnostics'), click: () => { onCopyDiagnostics(); } }] : []),
      ...(onShowLog ? [{ label: t('menu.help.showLog'), click: () => { onShowLog(); } }] : []),
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
