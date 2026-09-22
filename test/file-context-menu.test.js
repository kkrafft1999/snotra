const test = require('node:test');
const assert = require('node:assert/strict');
const { createFileContextMenu, revealLabelForPlatform } = require('../src/main/services/file-context-menu');

function createFakes() {
  const calls = {
    openPath: [], showItemInFolder: [], popup: [], trashItem: [], dialogs: [], copied: [], described: [],
  };
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
  const clipboard = { writeText: (value) => calls.copied.push(value) };
  // Der Inhalt der Info-Ansicht wird in file-info.test.js geprüft; hier zählt
  // nur, was das Menü daraus macht.
  const makeFileInfo = (result = { name: 'a.txt', path: '/ws/a.txt', fields: [['Name', 'a.txt']] }) => ({
    describe: async (p, opts) => {
      calls.described.push({ path: p, opts });
      return result;
    },
  });
  return { shell, Menu, calls, makeDialog, clipboard, makeFileInfo };
}

test('revealLabelForPlatform: Finder auf macOS, Explorer auf Windows, sonst Dateimanager', () => {
  assert.equal(revealLabelForPlatform('darwin'), 'Reveal in Finder');
  assert.equal(revealLabelForPlatform('win32'), 'Show in Explorer');
  assert.equal(revealLabelForPlatform('linux'), 'Show in file manager');
  // Auf Deutsch dieselbe Unterscheidung (Epic #277).
  assert.equal(revealLabelForPlatform('darwin', 'de'), 'Im Finder anzeigen');
  assert.equal(revealLabelForPlatform('linux', 'de'), 'Im Dateimanager anzeigen');
});

test('buildTemplate: „Öffnen“, plattformabhängiges „anzeigen“, Separator, „Löschen…“', () => {
  const { shell, Menu } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, platform: 'win32' });
  const template = menu.buildTemplate('/ws/a.txt');
  assert.deepEqual(
    template.map((t) => t.label ?? t.type),
    ['Open', 'Show in Explorer', 'Information', 'separator', 'Delete…'],
  );
});

test('buildTemplate für Ordner: kein „Öffnen“, nur anzeigen und löschen (#120)', () => {
  const { shell, Menu } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, platform: 'darwin' });
  const template = menu.buildTemplate('/ws/unterlagen', { isDirectory: true });
  assert.deepEqual(
    template.map((t) => t.label ?? t.type),
    ['Reveal in Finder', 'Information', 'separator', 'Delete…'],
  );
});

test('Ordner-Menü: „Im Explorer anzeigen“ und „Löschen…“ wirken auf den Ordnerpfad (#120)', async () => {
  const { shell, Menu, calls, makeDialog } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, dialog: makeDialog(0), platform: 'win32' });
  const deleted = [];
  const template = menu.buildTemplate('C:\\ws\\unterlagen', {
    isDirectory: true,
    onDeleted: (p) => deleted.push(p),
  });
  template[0].click();
  assert.deepEqual(calls.showItemInFolder, ['C:\\ws\\unterlagen']);
  await template[3].click();
  assert.deepEqual(calls.trashItem, ['C:\\ws\\unterlagen']);
  assert.deepEqual(deleted, ['C:\\ws\\unterlagen']);
  assert.deepEqual(calls.openPath, []);
});

test('Löschen eines Ordners: Hinweistext nennt den Inhalt, Papierkorb statt hartem Löschen (#120)', async () => {
  const { shell, Menu, calls, makeDialog } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, dialog: makeDialog(1), platform: 'darwin' });
  const result = await menu.deleteWithConfirmation('/ws/unterlagen', null, { isDirectory: true });
  assert.deepEqual(result, { cancelled: true });
  assert.deepEqual(calls.trashItem, []);
  const box = calls.dialogs[0];
  assert.match(box.message, /Delete “unterlagen”\?/);
  assert.match(box.detail, /folder and everything in it will be moved to the trash/);
});

test('popup reicht isDirectory an das Template durch (#120)', () => {
  const { shell, Menu } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, platform: 'darwin' });
  const built = menu.popup('/ws/unterlagen', { id: 1 }, { isDirectory: true });
  assert.deepEqual(
    built.template.map((t) => t.label ?? t.type),
    ['Reveal in Finder', 'Information', 'separator', 'Delete…'],
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
  assert.equal(built.template.length, 5);
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
  assert.match(box.message, /Delete “notiz\.md”\?/);
  assert.deepEqual(box.buttons, ['Delete', 'Cancel']);
  assert.equal(box.defaultId, 1);
  assert.equal(box.cancelId, 1);
  assert.match(box.detail, /moved to the trash/);
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
  await menuOk.buildTemplate('/ws/a.txt', { onDeleted: (p) => deleted.push(p) })[4].click();
  assert.deepEqual(deleted, ['/ws/a.txt']);

  const menuCancel = createFileContextMenu({ Menu, shell, dialog: makeDialog(1), platform: 'darwin' });
  await menuCancel.buildTemplate('/ws/b.txt', { onDeleted: (p) => deleted.push(p) })[4].click();
  assert.deepEqual(deleted, ['/ws/a.txt']);
});

test('Löschen ohne Dialog-Objekt liefert Fehler statt zu löschen (#59)', async () => {
  const { shell, Menu, calls } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, platform: 'darwin' });
  const result = await menu.deleteWithConfirmation('/ws/a.txt', null);
  assert.match(result.error, /dialog/i);
  assert.deepEqual(calls.trashItem, []);
});

test('„Informationen“: Dialog mit Name im Titel und den Feldern als Detailtext (#123)', async () => {
  const { shell, Menu, calls, makeDialog, clipboard, makeFileInfo } = createFakes();
  const menu = createFileContextMenu({
    Menu,
    shell,
    dialog: makeDialog(0),
    clipboard,
    platform: 'darwin',
    fileInfo: makeFileInfo({
      name: 'notiz.md',
      path: '/ws/notiz.md',
      fields: [['Name', 'notiz.md'], ['Pfad', '/ws/notiz.md'], ['Größe', '1,4 MB (1.468.006 Bytes)']],
    }),
  });
  const result = await menu.showInfo('/ws/notiz.md', { id: 1 });
  assert.deepEqual(result, { shown: true });
  const box = calls.dialogs[0];
  assert.equal(box.type, 'info');
  assert.match(box.message, /Information about “notiz\.md”/);
  assert.equal(box.detail, 'Name: notiz.md\nPfad: /ws/notiz.md\nGröße: 1,4 MB (1.468.006 Bytes)');
  assert.deepEqual(box.buttons, ['OK', 'Copy path']);
  assert.equal(box.defaultId, 0);
  assert.equal(box.cancelId, 0);
  assert.deepEqual(calls.copied, []);
});

test('„Informationen“: „Pfad kopieren“ legt den vollen Pfad in die Zwischenablage (#123)', async () => {
  const { shell, Menu, calls, makeDialog, clipboard, makeFileInfo } = createFakes();
  const menu = createFileContextMenu({
    Menu,
    shell,
    dialog: makeDialog(1),
    clipboard,
    platform: 'darwin',
    fileInfo: makeFileInfo({ name: 'notiz.md', path: '/ws/unterlagen/notiz.md', fields: [['Name', 'notiz.md']] }),
  });
  const result = await menu.showInfo('/ws/unterlagen/notiz.md', null);
  assert.deepEqual(result, { copied: true });
  assert.deepEqual(calls.copied, ['/ws/unterlagen/notiz.md']);
});

test('„Informationen“: ohne Zwischenablage gibt es keinen toten Knopf (#123)', async () => {
  const { shell, Menu, calls, makeDialog, makeFileInfo } = createFakes();
  const menu = createFileContextMenu({
    Menu, shell, dialog: makeDialog(0), platform: 'linux', fileInfo: makeFileInfo(),
  });
  await menu.showInfo('/ws/a.txt', null);
  assert.deepEqual(calls.dialogs[0].buttons, ['OK']);
});

test('„Informationen“: isDirectory wird an die Auskunft durchgereicht (#123)', async () => {
  const { shell, Menu, calls, makeDialog, clipboard, makeFileInfo } = createFakes();
  const menu = createFileContextMenu({
    Menu,
    shell,
    dialog: makeDialog(0),
    clipboard,
    platform: 'darwin',
    fileInfo: makeFileInfo({ name: 'unterlagen', path: '/ws/unterlagen', fields: [['Typ', 'Ordner']] }),
  });
  await menu.buildTemplate('/ws/unterlagen', { isDirectory: true })[1].click();
  // Der Klick-Handler ist nicht awaitbar; ein Tick reicht für die Zusage.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.described, [{ path: '/ws/unterlagen', opts: { isDirectory: true } }]);
  assert.match(calls.dialogs[0].message, /Information about “unterlagen”/);
});

test('„Informationen“: fehlgeschlagenes stat wird als Fehlerdialog gemeldet, nicht geworfen (#123)', async () => {
  const { shell, Menu, calls, makeDialog, clipboard } = createFakes();
  const warnings = [];
  const menu = createFileContextMenu({
    Menu,
    shell,
    dialog: makeDialog(0),
    clipboard,
    platform: 'darwin',
    logger: { warn: (...a) => warnings.push(a.join(' ')) },
    fileInfo: { describe: async () => ({ error: 'ENOENT: no such file or directory' }) },
  });
  const result = await menu.showInfo('/ws/weg.txt', null);
  assert.deepEqual(result, { error: 'ENOENT: no such file or directory' });
  assert.equal(calls.dialogs[0].type, 'error');
  assert.match(calls.dialogs[0].message, /Information not available/);
  assert.match(calls.dialogs[0].detail, /ENOENT/);
  assert.match(warnings.join(' '), /ENOENT/);
  assert.deepEqual(calls.copied, []);
});

test('„Informationen“ ohne Dialog-Objekt liefert einen Fehler statt zu werfen (#123)', async () => {
  const { shell, Menu, makeFileInfo } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, platform: 'darwin', fileInfo: makeFileInfo() });
  const result = await menu.showInfo('/ws/a.txt', null);
  assert.match(result.error, /dialog/i);
});

test('„Informationen“: ein abstürzender Dialog reißt den Main-Prozess nicht mit (#123)', async () => {
  const { shell, Menu, clipboard, makeFileInfo } = createFakes();
  const warnings = [];
  const menu = createFileContextMenu({
    Menu,
    shell,
    clipboard,
    platform: 'darwin',
    logger: { warn: (...a) => warnings.push(a.join(' ')) },
    fileInfo: makeFileInfo(),
    dialog: { showMessageBox: async () => { throw new Error('Fenster ist weg'); } },
  });
  // Der Menü-Handler gibt nichts zurück; eine Rejection darf hier enden.
  menu.buildTemplate('/ws/a.txt')[2].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(warnings.join(' '), /Fenster ist weg/);
});
