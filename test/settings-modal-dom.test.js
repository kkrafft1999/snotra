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
  for (const key of ['tools', 'permissions', 'skills', 'general']) {
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
