const {
  app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, shell, clipboard, protocol, session, WebContentsView,
  Notification,
} = require('electron');
const path = require('path');
const fs = require('fs/promises');
// Nur fuer die Datei-Watcher (Issues #126, #158): fs/promises kennt weder
// watch() noch realpathSync.native.
const { watch: watchFile, realpathSync } = require('fs');
const providers = require('./providers');
const { createWindow, getMainWindow, keepSpellCheckerOffWhereItFetches } = require('./window');
const { registerMediaCapturePermissions } = require('./permissions');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../shared/ipc-channels');
const workspaceState = require('./workspace-state');
const { LIMITS } = require('../shared/limits');
const { createApplication } = require('./composition/create-application');
const { APP_NAME, STORAGE_NAME, LEGACY_APP_NAME } = require('./app-identity');
const { createUserDataMigration } = require('./services/userdata-migration');
const { createApplicationMenuTemplate, MENU_ITEM_IDS } = require('./services/application-menu');
const { claimSingleInstance, createStartupFailureHandler, holdQuitForPendingWrites } = require('./app-lifecycle');
const { guardIpcMain } = require('./ipc/trusted-sender');
const { HTML_PREVIEW_SCHEME_PRIVILEGES } = require('./services/html-preview-service');
const { APP_SCHEME_PRIVILEGES, registerAppProtocol } = require('./app-protocol');
const { createManualService } = require('./services/manual-service');
const { createManualWindowController, registerManualOpenHandler } = require('./manual-window');
const { createLogFile, teeConsole } = require('./services/log-file');
const { createErrorReporter, installProcessErrorHandlers } = require('./services/error-reporter');
const { createAppNotices } = require('./services/app-notices');
const { createDiagnostics } = require('./services/diagnostics');
const { createRendererCrashHandler } = require('./services/renderer-crash');
const { registerDiagnosticsHandlers } = require('./ipc/diagnostics-handlers');
const { createSafeStorageKeyDurability, LOCAL_STATE_FILENAME } = require('./services/safe-storage-key-durability');
const { requireRealEncryption } = require('./services/safe-storage-backend');

// The storage identity first (#795): userData and the safeStorage key are
// derived from the name the app has at this point, and stay with it. The app
// takes its own name, APP_NAME, as soon as it is ready — see app-identity.js.
//
// macOS: damit in der Menue-Bar ueber dem Bildschirm der App-Name statt
// "Electron" erscheint (zumindest in den Submenus: "Ueber Snotra Agent",
// "Snotra Agent beenden" usw.). Im Packaged-Build kommt der Name aus dem
// productName in package.json -> Info.plist; im Dev-Mode liest macOS den
// FETTEN App-Title links neben dem Apfel allerdings aus dem Bundle der
// laufenden node_modules/electron/dist/Electron.app, daher kann dort trotz
// app.setName() weiterhin "Electron" stehen. Das ist ein bekanntes macOS-
// Limit, kein Bug der App.
app.setName(STORAGE_NAME);

// PRI-1 (#988): Linux's spell checker would fetch a dictionary at start-up.
keepSpellCheckerOffWhereItFetches();

// The scheme of HTML pages in the preview (#479). Privileges can only be
// given before the app is ready; the handler lives in the preview's own
// session alone, so the app's window cannot load anything through it.
// Next to it the scheme the app's own pages come from (#1012), served in the
// default session only.
protocol.registerSchemesAsPrivileged([HTML_PREVIEW_SCHEME_PRIVILEGES, APP_SCHEME_PRIVILEGES]);

const DEFAULT_PROVIDER = 'openai';

/** @type {ReturnType<typeof createApplication>|null} */
let application = null;
/** @type {ReturnType<typeof createManualWindowController>|null} */
let manualWindow = null;
/** @type {ReturnType<typeof createSafeStorageKeyDurability>|null} */
let safeStorageKey = null;

// One instance per userData folder (#507). A second launch brings the first
// window to the front and ends before it has started anything.
const isPrimaryInstance = claimSingleInstance({
  app,
  getMainWindow,
  createWindow: openMainWindow,
  canCreateWindow: () => application !== null,
});

if (isPrimaryInstance) start();

// Off macOS the app ends with its last window. The help window must not be
// that window: without the app window there is no way back to it (#790).
/** @param {import('electron').BrowserWindow|null|undefined} window */
function watchMainWindow(window) {
  window?.once('closed', () => {
    if (process.platform !== 'darwin') manualWindow?.close();
  });
}

/**
 * The app window, with what main does for it: a page that dies is answered
 * with a box that offers a reload instead of a blank window (#978).
 */
function openMainWindow() {
  const window = createWindow();
  window.webContents.on('render-process-gone', createRendererCrashHandler({
    dialog,
    window,
    app,
    appName: APP_NAME,
    getLocale: () => application?.getAppLocale?.(),
  }));
  watchMainWindow(window);
  return window;
}

function start() {
  // The error path first (#978), before anything that could throw: a local
  // log file that `console.warn` and `console.error` write to as well, and
  // main's process-level handlers, which log what nobody caught and count it
  // towards one notice in the window. The notices are made here for that
  // reason and handed to the application below.
  const logFile = createLogFile({ fs: require('fs'), path, dir: path.join(app.getPath('userData'), 'logs') });
  teeConsole(console, logFile);
  logFile.write('info', `${APP_NAME} ${app.getVersion()} started (${process.platform} ${process.arch})`);
  const notices = createAppNotices();
  const errorReporter = createErrorReporter({ notices, logFilePath: logFile.filePath });
  installProcessErrorHandlers(process, errorReporter);

  app.whenReady().then(async () => {
    app.setName(APP_NAME);
    // Before any window: both of them load from this scheme (#1012).
    registerAppProtocol(protocol);
    registerMediaCapturePermissions();

    // Einmalige Uebernahme der Daten aus dem userData-Ordner des alten
    // App-Namens. Muss VOR createApplication laufen: readLLMConfig legt beim
    // ersten Lesen sofort eine Default-Konfiguration an, das Ziel gaelte dann
    // als bereits benutzt. Wirft nie, blockiert den Start nie.
    await createUserDataMigration({ fs, path, log: console }).migrateLegacyUserData({
      sourceDir: path.join(app.getPath('appData'), LEGACY_APP_NAME),
      targetDir: app.getPath('userData'),
      // `appData` stays the real one when --user-data-dir moves userData, so
      // without this every test profile would be filled from it (#688).
      explicitUserDataDir: app.commandLine.hasSwitch('user-data-dir'),
      meta: { appVersion: app.getVersion(), platform: process.platform },
    });

    // On Windows the key behind safeStorage lives in Chromium's `Local State`,
    // which a fresh profile gets on disk only seconds after the start (#1060).
    // The stores hold their first ciphertext until it is there.
    safeStorageKey = createSafeStorageKeyDurability({
      localStatePath: () => path.join(app.getPath('sessionData'), LOCAL_STATE_FILENAME),
      readFile: (filePath) => fs.readFile(filePath, 'utf8'),
    });

    // *Help › Copy diagnostics* and *Show log file*, and the same from the
    // background-error notice (#978).
    const diagnostics = createDiagnostics({
      app,
      os: require('os'),
      logFile,
      reporter: errorReporter,
      clipboard,
      shell,
      dialog,
      getMainWindow,
      getLocale: () => application?.getAppLocale?.(),
      appName: APP_NAME,
    });

    // The menu bar is rebuilt on every language change (epic #277) — Electron
    // cannot rename an item after the fact. The function sits before
    // createApplication because it is handed to it as a callback.
    function applyApplicationMenu() {
      Menu.setApplicationMenu(Menu.buildFromTemplate(createApplicationMenuTemplate({
        appName: APP_NAME,
        getMainWindow,
        shell,
        PUSH,
        onCheckForUpdates: () => { void application?.runUpdateCheck({ silent: false }); },
        locale: application?.getAppLocale?.(),
        showHiddenFiles: application?.getShowHiddenFiles?.(),
        onOpenManual: () => { manualWindow?.open(); },
        routeHistoryStep: (direction, focusedWindow) => {
          if (!manualWindow?.isManualWindow(focusedWindow)) return false;
          manualWindow.stepHistory(direction);
          return true;
        },
        onCopyDiagnostics: () => { void diagnostics.copyFromMenu(); },
        onShowLog: () => { diagnostics.revealLog(); },
      })));
    }

    // A checkbox, unlike a label, can change in place (#436). Electron ticks it
    // itself on a click; this follows every other way of switching — the button
    // in the tree, the shortcut, the stored value at start-up.
    /** @param {unknown} showHiddenFiles */
    function syncHiddenFilesMenuItem(showHiddenFiles) {
      const item = Menu.getApplicationMenu()?.getMenuItemById(MENU_ITEM_IDS.SHOW_HIDDEN_FILES);
      if (item) item.checked = showHiddenFiles === true;
    }

    // The manual that ships with the app (#790): read by the help window and,
    // since #947, by the model's search_manual / read_manual_page.
    const manual = createManualService({
      fs: require('fs'),
      path,
      bundleDir: path.join(__dirname, '..', 'manual'),
    });

    const created = createApplication({
      app,
      manual,
      // Every handler checks who is calling (#509).
      ipcMain: guardIpcMain(ipcMain),
      dialog,
      // Linux's basic_text backend is no encryption and counts as none (#1012).
      safeStorage: requireRealEncryption(safeStorage),
      safeStorageKey,
      fs,
      path,
      fetchImpl: fetch,
      providersModule: providers,
      workspaceState,
      getMainWindow,
      Menu,
      shell,
      clipboard,
      session,
      WebContentsView,
      // A card waiting out of sight (#792, step 5).
      Notification,
      REQ,
      PUSH,
      LIMITS,
      defaultProviderId: DEFAULT_PROVIDER,
      watchFile,
      realpathNative: realpathSync.native,
      onAppLocaleChanged: () => {
        applyApplicationMenu();
        manualWindow?.onLocaleChanged();
      },
      onShowHiddenFilesChanged: syncHiddenFilesMenuItem,
      notices,
    });
    application = created;
    registerDiagnosticsHandlers({ ipcMain: guardIpcMain(ipcMain), REQ, reporter: errorReporter, diagnostics });

    // The help window with the manual that ships with the app (#790). It reads
    // `src/manual/` alone and has channels of its own, see manual-window.js.
    manualWindow = createManualWindowController({
      BrowserWindow,
      ipcMain,
      shell,
      app,
      manual,
      getLocale: () => application?.getAppLocale?.(),
    });
    // The `?` next to a settings section opens it at its page (#848).
    // Since #947 also a manual link in a chat answer; one that names no
    // bundled page goes to the browser. Without a bundle the window opens
    // the web anyway.
    registerManualOpenHandler({
      ipcMain: guardIpcMain(ipcMain),
      REQ,
      open: (target) => manualWindow?.open(target),
      hasPage: (slug) => !manual.isAvailable()
        || Object.hasOwn(manual.getIndex(application?.getAppLocale?.()).pages, slug),
    });

    // The stored language is only known once the preferences have been read.
    // Until then the menu carries the default; if the stored one differs,
    // createApplication calls `onAppLocaleChanged` and it is rebuilt.
    applyApplicationMenu();

    // Der aktive Workspace wird nicht vorab gesetzt: er entsteht erst, wenn der
    // Renderer den zuletzt geoeffneten Ordner ueber SETTINGS_ACTIVATE_FOLDER
    // wieder aktiviert (Issue #68). So zeigt die Oberflaeche immer genau den
    // Ordner, der auch die Vertrauensgrenze der Tools ist.

    openMainWindow();

    // This version is up: an update helper waiting for it may now delete the
    // previous one (#1003).
    void created.confirmUpdateStarted().catch(() => {});

    // Interpreter suchen und den Stand der Tool-Einstellungen uebernehmen
    // (Issues #63, #86). Bewusst nicht abgewartet: das Fenster soll nicht auf
    // eine Versionsabfrage warten, und vor der ersten Modellantwort ist es
    // laengst durch.
    void created.initToolRuntimes();

    // Verzoegerter Auto-Check, damit der Start nicht auf das Netzwerk wartet.
    setTimeout(() => { void created.runUpdateCheck({ silent: true }); }, 4000);

    app.on('activate', () => {
      if (!getMainWindow()) {
        openMainWindow();
      }
    });
  })
    // Without this a failed start leaves a process without a window (#509).
    .catch(createStartupFailureHandler({ app, dialog, appName: APP_NAME, logFilePath: logFile.filePath }));

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // An orderly quit writes `Local State` on its way out, after the writes
  // held for the key (#1060): they go ahead now, and the quit waits for them.
  app.on('before-quit', () => safeStorageKey?.releaseForQuit());
  // A chat written in the moment of the quit is not cut off (#679).
  holdQuitForPendingWrites({ app, whenWritesSettled: () => application?.whenWritesSettled() });

  app.on('will-quit', () => {
    application?.dispose();
  });
}
