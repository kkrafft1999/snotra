'use strict';

// The language choice in the settings lists every registered language by its
// own name (AR-32, #1007) — it is built from the registry, not written into
// index.html, so a third catalogue shows up without a change here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');
const { LOCALE_INFO } = require('../src/shared/i18n');

async function openSettings(prefs) {
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
    getUIPrefs: async () => ({ baseSystemPrompt: '', disabledTools: [], ...prefs }),
    getToolCatalog: async () => ({ tools: [] }),
    getSkillCatalog: async () => ({ skills: [], activeSkills: [] }),
    getPythonState: async () => ({ enabled: false }),
    getShellState: async () => ({ enabled: false }),
    getWebSearchState: async () => ({ available: true, hasApiKey: false, encryptionAvailable: true }),
    getAppVersion: async () => '1.5.3',
    cancelModelListing: async () => {},
    listModels: async () => ({ models: [] }),
    commitSettings: async () => ({ ok: true }),
    reloadSkills: async () => ({ skills: [] }),
    setWebSearchApiKey: async () => ({ ok: true }),
    onSkillsChanged: () => {},
  };
  const modal = initSettingsModal({
    api,
    appStore,
    stopChatVoiceListening() {},
    closeChatModelMenu() {},
    refreshLLMState: async () => {},
    findProviderMeta: () => null,
    updateChatChrome() {},
    onCheckUpdates() {},
  });
  await modal.openSettingsModal();
  await flush();
  const cleanup = dom.cleanup;
  dom.cleanup = () => {
    dom.document.getElementById('modal-settings')?.classList.add('hidden');
    dom.document.body.replaceChildren();
    cleanup();
  };
  return dom;
}

const options = () => [...document.querySelectorAll('#choice-app-locale label')].map((label) => ({
  value: label.querySelector('input').value,
  name: label.textContent.trim(),
  lang: label.getAttribute('lang'),
}));

test('every registered language is offered once, by its own name', async (t) => {
  const dom = await openSettings({ appLocale: LOCALE_INFO[0].code });
  t.after(dom.cleanup);
  assert.deepEqual(
    options(),
    LOCALE_INFO.map(({ code, name }) => ({ value: code, name, lang: code }))
  );
  assert.ok(options().length >= 2);
});

test('the stored language is the one that is ticked', async (t) => {
  for (const { code } of LOCALE_INFO) {
    const dom = await openSettings({ appLocale: code });
    t.after(dom.cleanup);
    assert.equal(document.querySelector('input[name="app-locale"]:checked')?.value, code);
    dom.cleanup();
  }
});

test('a stored language that is not registered shows the default, not whichever comes last', async (t) => {
  const dom = await openSettings({ appLocale: 'xx' });
  t.after(dom.cleanup);
  const { DEFAULT_LOCALE } = require('../src/shared/i18n');
  assert.equal(document.querySelector('input[name="app-locale"]:checked')?.value, DEFAULT_LOCALE);
});
