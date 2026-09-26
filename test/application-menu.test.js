const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplicationMenuTemplate } = require('../src/main/services/application-menu');

const PUSH = {
  UI_OPEN_SETTINGS: 'ui:open-settings',
  UI_TOGGLE_SIDEBAR: 'ui:toggle-sidebar',
  UI_NEW_CHAT: 'ui:new-chat',
  UI_TOGGLE_MARKDOWN_SOURCE: 'ui:toggle-markdown-source',
};

function buildTemplate(platform, overrides = {}) {
  const sent = [];
  const opened = [];
  const updateChecks = [];
  const template = createApplicationMenuTemplate({
    appName: 'Snotra AI',
    platform,
    getMainWindow: () => ({ webContents: { send: (channel) => sent.push(channel) } }),
    shell: { openExternal: (url) => opened.push(url) },
    PUSH,
    onCheckForUpdates: () => updateChecks.push(true),
    ...overrides,
  });
  return { template, sent, opened, updateChecks };
}

/** Was im Menue steht: das Label, sonst die Rolle, sonst der Typ (Trenner). */
const labelOf = (item) => item.label || item.role || item.type;

const menuNamed = (template, label) => template.find((entry) => entry.label === label);

/** Alle Eintraege aller Menues flach, damit Doppelungen auffallen. */
function allItems(template) {
  return template.flatMap((menu) => (menu.submenu || []).map((item) => ({ menu: menu.label, ...item })));
}

test('macOS: Einstellungen stehen im App-Menue direkt unter „Ueber“', () => {
  const { template } = buildTemplate('darwin');
  const appMenu = template[0];
  assert.equal(appMenu.label, 'Snotra AI', 'das erste Menue traegt den App-Namen');

  const labels = appMenu.submenu.map(labelOf);
  assert.deepEqual(labels.slice(0, 5), ['about', 'separator', 'Settings\u2026', 'separator', 'services']);
});

test('macOS: Ansicht traegt die Einstellungen nicht mehr', () => {
  const { template } = buildTemplate('darwin');
  const view = menuNamed(template, 'View');
  assert.ok(view, 'das Menue Ansicht existiert weiter');
  assert.ok(!view.submenu.some((item) => item.label === 'Settings\u2026'));
  // Der Rest der Ansicht bleibt unangetastet: Seitenleiste oben, Markdown
  // darunter (#344), dann Neu laden.
  assert.equal(view.submenu[0].label, 'Toggle Sidebar');
  assert.equal(view.submenu[1].label, 'Markdown: Preview or Source');
  assert.equal(view.submenu[3].role, 'reload');
});

for (const platform of ['win32', 'linux']) {
  test(`${platform}: Einstellungen stehen in Ansicht, es gibt kein App-Menue`, () => {
    const { template } = buildTemplate(platform);
    assert.equal(template[0].label, 'File', 'ohne App-Menue beginnt die Leiste mit Datei');

    const view = menuNamed(template, 'View');
    const labels = view.submenu.map(labelOf);
    assert.deepEqual(labels.slice(0, 6), [
      'Toggle Sidebar', 'Markdown: Preview or Source', 'separator', 'Settings\u2026', 'separator', 'Reload',
    ]);
  });
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: Einstellungen genau einmal, mit CmdOrCtrl+,`, () => {
    const { template } = buildTemplate(platform);
    const items = allItems(template).filter((item) => item.label === 'Settings\u2026');
    assert.equal(items.length, 1, 'zweimal dasselbe Label hiesse das Kuerzel zweimal vergeben');
    assert.equal(items[0].accelerator, 'CmdOrCtrl+,');
  });
}

test('Einstellungen schicken UI_OPEN_SETTINGS ans Fenster', () => {
  const { template, sent } = buildTemplate('darwin');
  const settings = allItems(template).find((item) => item.label === 'Settings\u2026');
  settings.click();
  assert.deepEqual(sent, [PUSH.UI_OPEN_SETTINGS]);
});

test('ohne Fenster laeuft der Klick ins Leere statt zu werfen', () => {
  const { template } = buildTemplate('darwin', { getMainWindow: () => null });
  const items = allItems(template);
  assert.doesNotThrow(() => items.find((item) => item.label === 'Settings\u2026').click());
  assert.doesNotThrow(() => items.find((item) => item.label === 'Toggle Sidebar').click());
  assert.doesNotThrow(() => items.find((item) => item.label === 'New Chat').click());
});

test('Hilfe: Update-Pruefung und GitHub-Link haengen an den Callbacks', () => {
  const { template, opened, updateChecks } = buildTemplate('darwin');
  const help = menuNamed(template, 'Help');
  assert.equal(help.role, 'help');
  help.submenu.find((item) => item.label.startsWith('Check for Updates')).click();
  help.submenu.find((item) => item.label === 'Project on GitHub').click();
  assert.deepEqual(updateChecks, [true]);
  assert.deepEqual(opened, ['https://github.com/kkrafft1999/snotra']);
});

test('the menu follows the chosen language (epic #277)', () => {
  const { template: en } = buildTemplate('darwin');
  assert.deepEqual(en.map((m) => m.label), ['Snotra AI', 'File', 'Edit', 'View', 'Window', 'Help']);

  const { template: de } = buildTemplate('darwin', { locale: 'de' });
  assert.deepEqual(de.map((m) => m.label), ['Snotra AI', 'Ablage', 'Bearbeiten', 'Ansicht', 'Fenster', 'Hilfe']);

  // The German labels carry real umlauts again instead of the earlier ASCII
  // stand-ins (epic #277).
  const edit = de.find((m) => m.label === 'Bearbeiten');
  assert.deepEqual(edit.submenu.map(labelOf).slice(0, 2), ['Rückgängig', 'Wiederholen']);
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: File > New Chat with CmdOrCtrl+N, right after the app menu (#381)`, () => {
    const { template, sent } = buildTemplate(platform);
    const file = template[platform === 'darwin' ? 1 : 0];
    assert.equal(file.label, 'File');
    const [newChat] = file.submenu;
    assert.equal(newChat.label, 'New Chat');
    assert.equal(newChat.accelerator, 'CmdOrCtrl+N');
    newChat.click();
    assert.deepEqual(sent, [PUSH.UI_NEW_CHAT]);
  });

  test(`${platform}: View > Markdown: Preview or Source with CmdOrCtrl+Shift+M (#344)`, () => {
    const { template, sent } = buildTemplate(platform);
    const item = menuNamed(template, 'View').submenu.find((entry) => entry.label === 'Markdown: Preview or Source');
    assert.ok(item, 'the item exists');
    // Not Cmd/Ctrl+Shift+V: that is "Paste and Match Style" in every text field.
    assert.equal(item.accelerator, 'CmdOrCtrl+Shift+M');
    item.click();
    assert.deepEqual(sent, [PUSH.UI_TOGGLE_MARKDOWN_SOURCE]);
  });

  test(`${platform}: no accelerator is assigned twice (#381)`, () => {
    const { template } = buildTemplate(platform);
    const accelerators = allItems(template).map((item) => item.accelerator).filter(Boolean);
    assert.deepEqual(accelerators.filter((a, i) => accelerators.indexOf(a) !== i), []);
  });
}

test('the File menu is "Ablage" on the Mac and "Datei" elsewhere in German (#381)', () => {
  const mac = buildTemplate('darwin', { locale: 'de' }).template[1];
  assert.equal(mac.label, 'Ablage');
  assert.equal(mac.submenu[0].label, 'Neuer Chat');
  for (const platform of ['win32', 'linux']) {
    const file = buildTemplate(platform, { locale: 'de' }).template[0];
    assert.equal(file.label, 'Datei');
    assert.equal(file.submenu[0].label, 'Neuer Chat');
  }
});
