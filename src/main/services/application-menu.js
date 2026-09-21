'use strict';

/**
 * Die Menueleiste der App (Issues #167, #266).
 *
 * Gebaut wird nur das Template — Menu.buildFromTemplate bleibt beim Aufrufer,
 * damit dieses Modul ohne laufendes Electron geprueft werden kann. Alles, was
 * die Eintraege auesserlich unterscheidet, haengt an `platform`: auf macOS
 * gibt es das App-Menue neben dem Apfel, auf Windows und Linux nicht.
 */

/**
 * „Einstellungen…“ hat auf jeder Plattform dasselbe Kuerzel, aber nicht
 * denselben Platz: Auf dem Mac gehoert der Eintrag ins App-Menue gleich unter
 * „Ueber“, sonst ins Menue „Ansicht“. Genau einmal — zweimal dasselbe Label in
 * der Leiste hiesse auch `CmdOrCtrl+,` zweimal vergeben.
 */
function createSettingsItem(openSettings) {
  return {
    label: 'Einstellungen\u2026',
    accelerator: 'CmdOrCtrl+,',
    click: openSettings,
  };
}

function createApplicationMenuTemplate({
  appName,
  platform = process.platform,
  getMainWindow,
  shell,
  PUSH,
  onCheckForUpdates,
}) {
  // Auf macOS muss das ERSTE Submenu den App-Namen als label tragen — das ist
  // der fett gedruckte Eintrag rechts neben dem Apfel. Auf Windows/Linux gibt
  // es kein App-Menue, dort beginnen wir direkt mit Datei/Bearbeiten.
  const isMac = platform === 'darwin';

  const send = (channel) => getMainWindow()?.webContents.send(channel);
  // Der einzige Weg in die Einstellungen ist das Menue — das Zahnrad im
  // Chat-Kopf ist weg, und mit der Chat-Spalte waere es ohnehin weggeschaltet.
  const settingsItem = createSettingsItem(() => send(PUSH.UI_OPEN_SETTINGS));

  const macAppMenu = {
    label: appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settingsItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide', label: `${appName} ausblenden` },
      { role: 'hideOthers', label: 'Andere ausblenden' },
      { role: 'unhide', label: 'Alle einblenden' },
      { type: 'separator' },
      { role: 'quit', label: `${appName} beenden` },
    ],
  };

  const editMenu = {
    label: 'Bearbeiten',
    submenu: [
      { role: 'undo', label: 'Rueckgaengig' },
      { role: 'redo', label: 'Wiederholen' },
      { type: 'separator' },
      { role: 'cut', label: 'Ausschneiden' },
      { role: 'copy', label: 'Kopieren' },
      { role: 'paste', label: 'Einfuegen' },
      { role: 'selectAll', label: 'Alles auswaehlen' },
    ],
  };

  const viewMenu = {
    label: 'Ansicht',
    submenu: [
      // Issue #167: das Kuerzel haengt bewusst am Menueeintrag statt an einer
      // Tastenabfrage im Renderer — so steht es sichtbar im Menue und gilt
      // auch, wenn der Fokus in einem Eingabefeld liegt.
      {
        label: 'Seitenleiste ein-/ausblenden',
        accelerator: 'CmdOrCtrl+B',
        click: () => send(PUSH.UI_TOGGLE_SIDEBAR),
      },
      { type: 'separator' },
      ...(isMac ? [] : [settingsItem, { type: 'separator' }]),
      { role: 'reload', label: 'Neu laden' },
      { role: 'forceReload', label: 'Hart neu laden' },
      { role: 'toggleDevTools', label: 'Entwicklertools' },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Zoom zuruecksetzen' },
      { role: 'zoomIn', label: 'Vergroessern' },
      { role: 'zoomOut', label: 'Verkleinern' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Vollbild' },
    ],
  };

  const windowMenu = {
    label: 'Fenster',
    role: 'window',
    submenu: [
      { role: 'minimize', label: 'Im Dock ablegen' },
      { role: 'zoom', label: 'Vollbild Fenster' },
      ...(isMac ? [{ type: 'separator' }, { role: 'front', label: 'Alle nach vorne' }] : [{ role: 'close', label: 'Schliessen' }]),
    ],
  };

  const helpMenu = {
    label: 'Hilfe',
    role: 'help',
    submenu: [
      {
        label: 'Nach Updates suchen…',
        click: () => { onCheckForUpdates(); },
      },
      { type: 'separator' },
      {
        label: 'Projekt auf GitHub',
        click: () => shell.openExternal('https://github.com/kkrafft1999/snotra'),
      },
    ],
  };

  return [
    ...(isMac ? [macAppMenu] : []),
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu,
  ];
}

module.exports = { createApplicationMenuTemplate };
