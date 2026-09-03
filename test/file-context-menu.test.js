const test = require('node:test');
const assert = require('node:assert/strict');
const { createFileContextMenu, revealLabelForPlatform } = require('../src/main/services/file-context-menu');

function createFakes() {
  const calls = { openPath: [], showItemInFolder: [], popup: [], trashItem: [], dialogs: [] };
  const shell = {
    openPath: async (p) => {
      calls.openPath.push(p);
      return '';
    },
    showItemInFolder: (p) => calls.showItemInFolder.push(p),
    trashItem: async (p) => {
      calls.trashItem.push(p);
    },
  };
  const Menu = {
    buildFromTemplate: (template) => ({
      template,
      popup: (opts) => calls.popup.push(opts),
    }),
  };
  // response 1 = „Abbrechen“ (Standard), 0 = „Löschen“
  const makeDialog = (response = 1) => ({
    showMessageBox: async (...args) => {
      const options = args[args.length - 1];
      calls.dialogs.push(options);
      return { response };
    },
  });
  return { shell, Menu, calls, makeDialog };
}

test('revealLabelForPlatform: Finder auf macOS, Explorer auf Windows, sonst Dateimanager', () => {
  assert.equal(revealLabelForPlatform('darwin'), 'Im Finder anzeigen');
  assert.equal(revealLabelForPlatform('win32'), 'Im Explorer anzeigen');
  assert.equal(revealLabelForPlatform('linux'), 'Im Dateimanager anzeigen');
});

test('buildTemplate: „Öffnen“, plattformabhängiges „anzeigen“, Separator, „Löschen…“', () => {
  const { shell, Menu } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, platform: 'win32' });
  const template = menu.buildTemplate('/ws/a.txt');
  assert.deepEqual(
    template.map((t) => t.label ?? t.type),
    ['Öffnen', 'Im Explorer anzeigen', 'separator', 'Löschen…'],
  );
});

test('Klick auf „Öffnen“ ruft shell.openPath mit dem Dateipfad', async () => {
  const { shell, Menu, calls } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, platform: 'darwin' });
  await menu.buildTemplate('/ws/a.txt')[0].click();
  assert.deepEqual(calls.openPath, ['/ws/a.txt']);
  assert.deepEqual(calls.showItemInFolder, []);
});

test('Klick auf „Im Finder anzeigen“ ruft shell.showItemInFolder mit dem Dateipfad', () => {
  const { shell, Menu, calls } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, platform: 'darwin' });
  menu.buildTemplate('/ws/a.txt')[1].click();
  assert.deepEqual(calls.showItemInFolder, ['/ws/a.txt']);
  assert.deepEqual(calls.openPath, []);
});

test('Fehlertext von shell.openPath wird geloggt statt geworfen', async () => {
  const { Menu } = createFakes();
  const warnings = [];
  const shell = { openPath: async () => 'Keine App gefunden', showItemInFolder() {} };
  const menu = createFileContextMenu({ Menu, shell, platform: 'darwin', logger: { warn: (...a) => warnings.push(a) } });
  await menu.buildTemplate('/ws/a.bin')[0].click();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].join(' '), /Keine App gefunden/);
});

test('popup: baut das Menü und öffnet es am übergebenen Fenster', () => {
  const { shell, Menu, calls } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, platform: 'darwin' });
  const win = { id: 1 };
  const built = menu.popup('/ws/a.txt', win);
  assert.equal(built.template.length, 4);
  assert.deepEqual(calls.popup, [{ window: win }]);
});

test('Löschen: Sicherheitsabfrage mit Dateiname, „Abbrechen“ ist Standard und Cancel-Antwort (#59)', async () => {
  const { shell, Menu, calls, makeDialog } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, dialog: makeDialog(1), platform: 'darwin' });
  const result = await menu.deleteWithConfirmation('/ws/notiz.md', { id: 1 });
  assert.deepEqual(result, { cancelled: true });
  assert.deepEqual(calls.trashItem, []);
  const box = calls.dialogs[0];
  assert.equal(box.type, 'warning');
  assert.match(box.message, /„notiz\.md“ löschen\?/);
  assert.deepEqual(box.buttons, ['Löschen', 'Abbrechen']);
  assert.equal(box.defaultId, 1);
  assert.equal(box.cancelId, 1);
  assert.match(box.detail, /Papierkorb/);
});

test('Löschen: Bestätigung verschiebt in den Papierkorb und meldet deleted (#59)', async () => {
  const { shell, Menu, calls, makeDialog } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, dialog: makeDialog(0), platform: 'darwin' });
  const result = await menu.deleteWithConfirmation('/ws/notiz.md', null);
  assert.deepEqual(result, { deleted: true });
  assert.deepEqual(calls.trashItem, ['/ws/notiz.md']);
});

test('Löschen: Fehler von shell.trashItem wird als Dialog gemeldet, kein hartes Löschen (#59)', async () => {
  const { Menu, calls, makeDialog } = createFakes();
  const shell = {
    trashItem: async () => {
      throw new Error('Kein Papierkorb');
    },
  };
  const warnings = [];
  const menu = createFileContextMenu({
    Menu, shell, dialog: makeDialog(0), platform: 'linux', logger: { warn: (...a) => warnings.push(a) },
  });
  const result = await menu.deleteWithConfirmation('/ws/x.bin', null);
  assert.deepEqual(result, { error: 'Kein Papierkorb' });
  assert.equal(calls.dialogs.length, 2);
  assert.equal(calls.dialogs[1].type, 'error');
  assert.match(calls.dialogs[1].detail, /Kein Papierkorb/);
  assert.equal(warnings.length, 1);
});

test('Menüeintrag „Löschen…“ ruft onDeleted nur nach erfolgreichem Löschen (#59)', async () => {
  const { shell, Menu, makeDialog } = createFakes();
  const deleted = [];
  const menuOk = createFileContextMenu({ Menu, shell, dialog: makeDialog(0), platform: 'darwin' });
  await menuOk.buildTemplate('/ws/a.txt', { onDeleted: (p) => deleted.push(p) })[3].click();
  assert.deepEqual(deleted, ['/ws/a.txt']);

  const menuCancel = createFileContextMenu({ Menu, shell, dialog: makeDialog(1), platform: 'darwin' });
  await menuCancel.buildTemplate('/ws/b.txt', { onDeleted: (p) => deleted.push(p) })[3].click();
  assert.deepEqual(deleted, ['/ws/a.txt']);
});

test('Löschen ohne Dialog-Objekt liefert Fehler statt zu löschen (#59)', async () => {
  const { shell, Menu, calls } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, platform: 'darwin' });
  const result = await menu.deleteWithConfirmation('/ws/a.txt', null);
  assert.match(result.error, /Dialog/);
  assert.deepEqual(calls.trashItem, []);
});
