const { app, ipcMain, dialog, safeStorage, Menu, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs/promises');
// Nur fuer die Datei-Watcher (Issues #126, #158): fs/promises kennt weder
// watch() noch realpathSync.native.
const { watch: watchFile, realpathSync } = require('fs');
const providers = require('./providers');
const { createWindow, getMainWindow } = require('./window');
const { registerMediaCapturePermissions } = require('./permissions');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../shared/ipc-channels');
const workspaceState = require('./workspace-state');
const { LIMITS } = require('../shared/limits');
const { createApplication } = require('./composition/create-application');
const { APP_NAME, LEGACY_APP_NAME } = require('./app-identity');
const { createUserDataMigration } = require('./services/userdata-migration');
const { createApplicationMenuTemplate } = require('./services/application-menu');

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
    watchFile,
    realpathNative: realpathSync.native,
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(createApplicationMenuTemplate({
    appName: app.getName(),
    getMainWindow,
    shell,
    PUSH,
    onCheckForUpdates: () => { void application.runUpdateCheck({ silent: false }); },
  })));

  // Der aktive Workspace wird nicht vorab gesetzt: er entsteht erst, wenn der
  // Renderer den zuletzt geoeffneten Ordner ueber SETTINGS_ACTIVATE_FOLDER
  // wieder aktiviert (Issue #68). So zeigt die Oberflaeche immer genau den
  // Ordner, der auch die Vertrauensgrenze der Tools ist.

  createWindow();

  // Interpreter suchen und den Stand der Tool-Einstellungen uebernehmen
  // (Issues #63, #86). Bewusst nicht abgewartet: das Fenster soll nicht auf
  // eine Versionsabfrage warten, und vor der ersten Modellantwort ist es
  // laengst durch.
  void application.initToolRuntimes();

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
