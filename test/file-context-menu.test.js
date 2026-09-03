const test = require('node:test');
const assert = require('node:assert/strict');
const { createFileContextMenu, revealLabelForPlatform } = require('../src/main/services/file-context-menu');

function createFakes() {
  const calls = { openPath: [], showItemInFolder: [], popup: [] };
  const shell = {
    openPath: async (p) => {
      calls.openPath.push(p);
      return '';
    },
    showItemInFolder: (p) => calls.showItemInFolder.push(p),
  };
  const Menu = {
    buildFromTemplate: (template) => ({
      template,
      popup: (opts) => calls.popup.push(opts),
    }),
  };
  return { shell, Menu, calls };
}

test('revealLabelForPlatform: Finder auf macOS, Explorer auf Windows, sonst Dateimanager', () => {
  assert.equal(revealLabelForPlatform('darwin'), 'Im Finder anzeigen');
  assert.equal(revealLabelForPlatform('win32'), 'Im Explorer anzeigen');
  assert.equal(revealLabelForPlatform('linux'), 'Im Dateimanager anzeigen');
});

test('buildTemplate: „Öffnen“ zuerst, dann plattformabhängiges „anzeigen“', () => {
  const { shell, Menu } = createFakes();
  const menu = createFileContextMenu({ Menu, shell, platform: 'win32' });
  const template = menu.buildTemplate('/ws/a.txt');
  assert.deepEqual(template.map((t) => t.label), ['Öffnen', 'Im Explorer anzeigen']);
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
  assert.equal(built.template.length, 2);
  assert.deepEqual(calls.popup, [{ window: win }]);
});
