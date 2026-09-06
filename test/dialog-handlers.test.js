// Ordnerdialog: Startverzeichnis und Aktivierung.
//
// Hintergrund zum `defaultPath`: Seit Electron 43 setzt Electron ohne
// `defaultPath` fest den Downloads-Ordner als Startverzeichnis, statt dem
// Betriebssystem den zuletzt benutzten Ort zu ueberlassen. Damit der Dialog
// weiterhin dort aufgeht, wo gearbeitet wird, reicht der Handler den zuletzt
// aktiven Workspace-Ordner selbst durch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerDialogHandlers } = require('../src/main/ipc/dialog-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');

function makeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, handler) => handlers.set(channel, handler),
    invoke: (channel, ...args) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Kein Handler für ${channel}`);
      return handler({}, ...args);
    },
  };
}

function setup({ lastFolder, result, workspaceFolderStore, workspaceActivation } = {}) {
  const seenOptions = [];
  const ipcMain = makeIpcMain();
  const store = workspaceFolderStore === undefined
    ? { getValidatedLastFolder: async () => (lastFolder === undefined ? null : lastFolder) }
    : workspaceFolderStore;

  registerDialogHandlers({
    ipcMain,
    dialog: {
      showOpenDialog: async (_win, options) => {
        seenOptions.push(options);
        return result || { canceled: false, filePaths: ['/gewaehlt'] };
      },
    },
    getMainWindow: () => ({}),
    workspaceActivation: workspaceActivation === undefined ? null : workspaceActivation,
    workspaceFolderStore: store,
    REQ,
  });

  return { ipcMain, seenOptions };
}

test('der Dialog startet im zuletzt aktiven Workspace-Ordner', async () => {
  const { ipcMain, seenOptions } = setup({ lastFolder: '/projekte/snotra' });

  await ipcMain.invoke(REQ.DIALOG_OPEN_FOLDER);

  assert.equal(seenOptions.length, 1);
  assert.equal(seenOptions[0].defaultPath, '/projekte/snotra');
  assert.deepEqual(seenOptions[0].properties, ['openDirectory']);
});

test('ohne bekannten Ordner bleibt defaultPath ungesetzt', async () => {
  const { ipcMain, seenOptions } = setup({ lastFolder: null });

  await ipcMain.invoke(REQ.DIALOG_OPEN_FOLDER);

  assert.ok(!('defaultPath' in seenOptions[0]));
});

// Der zuletzt benutzte Ordner ist Komfort, kein Muss: faellt er aus, soll der
// Dialog trotzdem aufgehen.
test('ein Fehler beim Lesen des letzten Ordners verhindert den Dialog nicht', async () => {
  const { ipcMain, seenOptions } = setup({
    workspaceFolderStore: {
      getValidatedLastFolder: async () => {
        throw new Error('Datei kaputt');
      },
    },
  });

  const gewaehlt = await ipcMain.invoke(REQ.DIALOG_OPEN_FOLDER);

  assert.equal(seenOptions.length, 1);
  assert.ok(!('defaultPath' in seenOptions[0]));
  assert.equal(gewaehlt, '/gewaehlt');
});

test('ein fehlender Store wird vertragen', async () => {
  const { ipcMain, seenOptions } = setup({ workspaceFolderStore: null });

  await ipcMain.invoke(REQ.DIALOG_OPEN_FOLDER);

  assert.ok(!('defaultPath' in seenOptions[0]));
});

test('Abbruch liefert null und aktiviert nichts', async () => {
  const aktiviert = [];
  const { ipcMain } = setup({
    result: { canceled: true, filePaths: [] },
    workspaceActivation: { activateChosenFolder: async (p) => aktiviert.push(p) },
  });

  assert.equal(await ipcMain.invoke(REQ.DIALOG_OPEN_FOLDER), null);
  assert.deepEqual(aktiviert, []);
});

test('die Auswahl wird an workspaceActivation weitergereicht', async () => {
  const aktiviert = [];
  const { ipcMain } = setup({
    workspaceActivation: {
      activateChosenFolder: async (p) => {
        aktiviert.push(p);
        return { path: p, aktiv: true };
      },
    },
  });

  const antwort = await ipcMain.invoke(REQ.DIALOG_OPEN_FOLDER);

  assert.deepEqual(aktiviert, ['/gewaehlt']);
  assert.deepEqual(antwort, { path: '/gewaehlt', aktiv: true });
});
