// Einstellungsdialog am echten DOM (Issue #78).
//
// test/settings-dialog-markup.test.js prueft die index.html per Regex und kann
// darum nur sehen, dass Tabs und Panels existieren. Hier laeuft der echte
// initSettingsModal gegen dasselbe Markup: ein Klick auf einen Tab muss den
// zugehoerigen Panel zeigen, aria-selected und die Tabreihenfolge nachziehen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

async function mountSettings(overrides = {}) {
  const dom = setupRendererDom();
  const { initSettingsModal } = await importRenderer('components', 'SettingsModal.js');
  const { appStore } = await importRenderer('state', 'store.js');

  appStore.llmState = {
    encryptionAvailable: true,
    activeProvider: 'openai',
    activePresetId: null,
    presets: [],
    chatTarget: null,
    providers: [{ id: 'openai', name: 'OpenAI', configured: true }],
  };
  appStore.lastFocusBeforeModal = null;

  const api = {
    getUIPrefs: async () => ({ baseSystemPrompt: '', appLocale: 'de', disabledTools: [] }),
    getToolCatalog: async () => ({ tools: [] }),
    getSkillCatalog: async () => ({ skills: [], activeSkills: [] }),
    getPythonState: async () => ({ enabled: false }),
    getShellState: async () => ({ enabled: false }),
    getWebSearchState: async () => ({ hasKey: false }),
    getAppVersion: async () => '1.5.3',
    cancelModelListing: async () => {},
    listModels: async () => ({ models: [] }),
    commitSettings: async () => ({ ok: true }),
    reloadSkills: async () => ({ skills: [] }),
    setWebSearchApiKey: async () => ({ ok: true }),
    onSkillsChanged: () => {},
    ...overrides,
  };

  const modal = initSettingsModal({
    api,
    appStore,
    stopChatVoiceListening() {},
    closeChatModelMenu() {},
    refreshLLMState: async () => {},
    findProviderMeta: (id) => appStore.llmState.providers.find((p) => p.id === id) || null,
    updateChatChrome() {},
    onCheckUpdates() {},
  });

  await modal.openSettingsModal();
  await flush();
  return { dom, modal, appStore };
}

const tabFor = (key) => document.querySelector(`.settings-nav-item[data-settings-panel="${key}"]`);
const panelFor = (key) => document.getElementById(`panel-settings-${key}`);

test('geoeffnet startet der Dialog auf dem Modell-Tab', async (t) => {
  const { dom } = await mountSettings();
  t.after(dom.cleanup);

  assert.equal(document.getElementById('modal-settings').classList.contains('hidden'), false);
  assert.equal(tabFor('models').getAttribute('aria-selected'), 'true');
  assert.equal(panelFor('models').hidden, false);
  assert.equal(document.getElementById('settings-panel-heading').textContent, 'Modelle');
  // Alle uebrigen Panels sind wirklich weg, nicht nur unsichtbar.
  for (const key of ['tools', 'permissions', 'skills', 'mcp', 'general']) {
    assert.equal(panelFor(key).hidden, true, `Panel ${key} muesste versteckt sein`);
  }
});

test('ein Klick auf einen Tab schaltet Panel, aria-selected und Ueberschrift um', async (t) => {
  const { dom } = await mountSettings();
  t.after(dom.cleanup);

  for (const [key, heading] of [
    ['tools', 'Tools'],
    ['permissions', 'Berechtigungen'],
    ['skills', 'Skills'],
    ['general', 'Allgemein'],
    ['models', 'Modelle'],
  ]) {
    tabFor(key).click();
    await flush();

    assert.equal(panelFor(key).hidden, false, `Panel ${key} bleibt versteckt`);
    assert.ok(panelFor(key).classList.contains('settings-panel--active'));
    assert.equal(document.getElementById('settings-panel-heading').textContent, heading);

    const selected = [...document.querySelectorAll('.settings-nav-item[role="tab"]')]
      .filter((t2) => t2.getAttribute('aria-selected') === 'true')
      .map((t2) => t2.dataset.settingsPanel);
    assert.deepEqual(selected, [key], 'genau ein Tab ist ausgewaehlt');
  }
});

test('nur der aktive Tab liegt in der Tabreihenfolge (Roving Tabindex)', async (t) => {
  const { dom } = await mountSettings();
  t.after(dom.cleanup);

  tabFor('skills').click();
  await flush();

  const tabs = [...document.querySelectorAll('.settings-nav-item[role="tab"]')];
  assert.deepEqual(
    tabs.map((tab) => tab.tabIndex),
    tabs.map((tab) => (tab.dataset.settingsPanel === 'skills' ? 0 : -1))
  );
});

test('jeder Tab zeigt auf ein Panel, das es wirklich gibt', async (t) => {
  const { dom } = await mountSettings();
  t.after(dom.cleanup);

  for (const tab of document.querySelectorAll('.settings-nav-item[role="tab"]')) {
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    assert.ok(panel, `aria-controls von ${tab.id} zeigt ins Leere`);
    assert.equal(panel.id, `panel-settings-${tab.dataset.settingsPanel}`);
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
  }
});

test('Escape schliesst den Dialog', async (t) => {
  const { dom } = await mountSettings();
  t.after(dom.cleanup);

  const modalSettings = document.getElementById('modal-settings');
  modalSettings.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();

  assert.ok(modalSettings.classList.contains('hidden'));
  assert.equal(modalSettings.getAttribute('aria-hidden'), 'true');
});

test('nach Schliessen und Wiederoeffnen steht der Dialog wieder auf Modelle', async (t) => {
  const { dom, modal } = await mountSettings();
  t.after(dom.cleanup);

  tabFor('general').click();
  await flush();
  modal.closeSettingsModal();
  await modal.openSettingsModal();
  await flush();

  assert.equal(tabFor('models').getAttribute('aria-selected'), 'true');
  assert.equal(panelFor('general').hidden, true);
});

// --- Skills ohne Obergrenze (Issue #137) ------------------------------------
// Frueher hat der Dialog ab dem neunten Haken abgewinkt (MAX_ACTIVE_SKILLS = 8)
// und einen Hinweis eingeblendet. Der Test haelt fest, dass jetzt beliebig
// viele Skills gleichzeitig angehen und auch alle gespeichert werden.
const MANY_SKILLS = Array.from({ length: 12 }, (_, i) => ({
  name: `skill-${i + 1}`,
  description: `Skill Nummer ${i + 1}`,
  source: 'user-agents',
  status: 'available',
  path: `/tmp/.agents/skills/skill-${i + 1}`,
  detail: '',
  builtin: false,
}));

test('mehr als acht Skills lassen sich gleichzeitig aktivieren und speichern', async (t) => {
  let committed = null;
  const { dom } = await mountSettings({
    getSkillCatalog: async () => ({ skills: MANY_SKILLS, activeSkills: [] }),
    commitSettings: async (payload) => {
      committed = payload;
      return { ok: true };
    },
  });
  t.after(dom.cleanup);

  tabFor('skills').click();
  await flush();

  const boxes = [...document.querySelectorAll('#settings-skill-list input[data-skill-name]')];
  assert.equal(boxes.length, MANY_SKILLS.length, 'alle Skills stehen in der Liste');

  for (const box of boxes) box.click();
  await flush();

  assert.deepEqual(
    boxes.filter((box) => !box.checked).map((box) => box.dataset.skillName),
    [],
    'kein Haken darf zurueckspringen'
  );

  document.getElementById('btn-settings-save').click();
  await flush();

  assert.deepEqual(
    committed?.uiPrefs?.activeSkills,
    MANY_SKILLS.map((skill) => skill.name),
    'alle angehakten Skills landen in den Einstellungen'
  );
});

test('die Fokusfalle greift fuer jeden Unterdialog, nicht nur den Modell-Dialog', () => {
  // Absichtlich am Quelltext und nicht am DOM: happy-dom hat kein Layout,
  // `offsetParent` ist dort immer null, und genau danach filtert die
  // Fokusfalle. Ein DOM-Test waere hier gruen, ohne etwas zu zeigen — das
  // tatsaechliche Tab-Verhalten gehoert in den Electron-Smoke-Test.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'components', 'SettingsModal.js'),
    'utf8'
  );
  const block = source.slice(
    source.indexOf('function getFocusableInSettingsModal'),
    source.indexOf('function handleModalKeydown')
  );
  assert.match(block, /openNestedOverlay\(\)/, 'die Auswahl darf nicht an einer festen id haengen');
  assert.doesNotMatch(block, /addModelOverlay &&/, 'das Modell-Overlay darf nicht mehr fest verdrahtet sein');

  // Und der MCP-Unterdialog traegt die Klasse, ueber die er gefunden wird.
  const markup = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(markup, /id="mcp-server-overlay" class="add-model-overlay hidden"/);
});

test('die Fussleiste sagt je Bereich, ob Aenderungen sofort wirken', async (t) => {
  const { dom } = await mountSettings();
  t.after(dom.cleanup);
  const hint = () => document.getElementById('settings-apply-hint').textContent;

  assert.match(hint(), /erst mit Übernehmen/, 'Modelle sammeln bis „Übernehmen“');

  // Berechtigungen (#67) und MCP (#109) schreiben beim Klick — ein Hinweis
  // auf „Übernehmen“ waere dort schlicht falsch.
  tabFor('permissions').click();
  await flush();
  assert.match(hint(), /wirken sofort/);

  tabFor('mcp').click();
  await flush();
  assert.match(hint(), /wirken sofort/);

  tabFor('general').click();
  await flush();
  assert.match(hint(), /erst mit Übernehmen/);
});
