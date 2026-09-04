const { app, ipcMain, dialog, safeStorage, Menu, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const providers = require('./providers');
const { createWindow, getMainWindow } = require('./window');
const { registerMediaCapturePermissions } = require('./permissions');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../shared/ipc-channels');
const workspaceState = require('./workspace-state');
const { LIMITS } = require('../shared/limits');
const { createApplication } = require('./composition/create-application');
const { APP_NAME, LEGACY_APP_NAME } = require('./app-identity');
const { createUserDataMigration } = require('./services/userdata-migration');

// macOS: damit in der Menue-Bar ueber dem Bildschirm der App-Name statt
// "Electron" erscheint (zumindest in den Submenus: "Ueber Snotra AI",
// "Snotra AI beenden" usw.). Im Packaged-Build kommt der Name aus dem
// productName in package.json -> Info.plist; im Dev-Mode liest macOS den
// FETTEN App-Title links neben dem Apfel allerdings aus dem Bundle der
// laufenden node_modules/electron/dist/Electron.app, daher kann dort trotz
// app.setName() weiterhin "Electron" stehen. Das ist ein bekanntes macOS-
// Limit, kein Bug der App.
app.setName(APP_NAME);

const DEFAULT_PROVIDER = 'openai';

let application = null;

function buildApplicationMenu() {
  // Auf macOS muss das ERSTE Submenu den App-Namen als label tragen — das ist
  // der fett gedruckte Eintrag rechts neben dem Apfel. Auf Windows/Linux gibt
  // es kein App-Menue, dort beginnen wir direkt mit Datei/Bearbeiten.
  const isMac = process.platform === 'darwin';
  const appName = app.getName();

  const macAppMenu = {
    label: appName,
    submenu: [
      { role: 'about' },
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
        click: () => { void application.runUpdateCheck({ silent: false }); },
      },
      { type: 'separator' },
      {
        label: 'Projekt auf GitHub',
        click: () => shell.openExternal('https://github.com/kkrafft1999/snotra'),
      },
    ],
  };

  const template = [
    ...(isMac ? [macAppMenu] : []),
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu,
  ];

  return Menu.buildFromTemplate(template);
}

app.whenReady().then(async () => {
  registerMediaCapturePermissions();

  // Einmalige Uebernahme der Daten aus dem userData-Ordner des alten
  // App-Namens. Muss VOR createApplication laufen: readLLMConfig legt beim
  // ersten Lesen sofort eine Default-Konfiguration an, das Ziel gaelte dann
  // als bereits benutzt. Wirft nie, blockiert den Start nie.
  await createUserDataMigration({ fs, path, log: console }).migrateLegacyUserData({
    sourceDir: path.join(app.getPath('appData'), LEGACY_APP_NAME),
    targetDir: app.getPath('userData'),
    meta: { appVersion: app.getVersion(), platform: process.platform },
  });

  application = createApplication({
    app,
    ipcMain,
    dialog,
    safeStorage,
    fs,
    path,
    fetchImpl: fetch,
    providersModule: providers,
    workspaceState,
    getMainWindow,
    Menu,
    shell,
    clipboard,
    REQ,
    PUSH,
    LIMITS,
    defaultProviderId: DEFAULT_PROVIDER,
  });

  Menu.setApplicationMenu(buildApplicationMenu());

  const lastFolder = await application.getValidatedLastFolder();
  if (lastFolder) {
    workspaceState.setActiveWorkspaceRoot(lastFolder);
  }

  createWindow();

  // Verzoegerter Auto-Check, damit der Start nicht auf das Netzwerk wartet.
  setTimeout(() => { void application.runUpdateCheck({ silent: true }); }, 4000);

  app.on('activate', () => {
    if (!getMainWindow()) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  application?.dispose();
});
