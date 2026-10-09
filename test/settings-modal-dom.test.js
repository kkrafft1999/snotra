// Einstellungsdialog am echten DOM (Issue #78).
//
// test/settings-dialog-markup.test.js prueft die index.html per Regex und kann
// darum nur sehen, dass Tabs und Panels existieren. Hier laeuft der echte
// initSettingsModal gegen dasselbe Markup: ein Klick auf einen Tab muss den
// zugehoerigen Panel zeigen, aria-selected und die Tabreihenfolge nachziehen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush, focusFixup } = require('./helpers/dom.js');

async function mountSettings({ providers, modalDeps, ...overrides } = {}) {
  const dom = setupRendererDom();
  const { initSettingsModal } = await importRenderer('components', 'SettingsModal.js');
  const { appStore } = await importRenderer('state', 'store.js');
  // The fixture prefs say German, and the app starts in the stored language.
  // Set it here: until #297 it leaked in from whichever test pressed Apply.
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('de', { force: true });

  appStore.llmState = {
    encryptionAvailable: true,
    activeProvider: 'openai',
    activePresetId: null,
    presets: [],
    chatTarget: null,
    providers: providers || [{ id: 'openai', name: 'OpenAI', configured: true }],
  };
  appStore.lastFocusBeforeModal = null;

  const api = {
    getUIPrefs: async () => ({ baseSystemPrompt: '', appLocale: 'de', disabledTools: [] }),
    getToolCatalog: async () => ({ tools: [] }),
    getSkillCatalog: async () => ({ skills: [], activeSkills: [] }),
    getPythonState: async () => ({ enabled: false }),
    getShellState: async () => ({ enabled: false }),
    // The shape main answers with (settings-handlers.js): `hasApiKey`.
    getWebSearchState: async () => ({ available: true, hasApiKey: false, encryptionAvailable: true }),
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
    ...modalDeps,
  });

  await modal.openSettingsModal();
  await flush();
  dom.reopenSettings = async () => {
    modal.closeSettingsModal?.();
    await modal.openSettingsModal();
    await flush();
  };
  return { dom, modal, appStore };
}

/**
 * Anbieter-Sicht des generischen Anbieters, wie sie der Main-Prozess liefert
 * (Issue #202): Verbindung je Eintrag, acht Felder, freier Modellname.
 */
const COMPAT_VIEW = {
  id: 'openai-compatible',
  name: 'OpenAI-kompatibel',
  builtInName: 'OpenAI-kompatibel',
  configured: true,
  defaultModel: '',
  defaultBaseUrl: 'http://localhost:1234/v1',
  defaultInsecureTls: false,
  apiBase: 'http://localhost:1234/v1',
  capabilities: { images: false },
  optionalApiKey: true,
  connectionDetail: true,
  presetFields: [],
  form: {
    showApiKey: true,
    apiKeyOptional: true,
    apiKeyPlaceholder: 'leer lassen',
    showBaseUrl: true,
    baseUrlPlaceholder: 'http://localhost:1234/v1',
    showInsecureTls: true,
    insecureTlsHint: 'nur bei selbstsigniertem Zertifikat',
    showDisplayName: true,
    displayNamePlaceholder: 'OpenAI-kompatibel',
    showApiStyle: true,
    apiStyleOptions: [{ value: 'chat', label: 'Nur Chat Completions' }],
    defaultApiStyle: 'chat',
    showExtraHeaders: true,
    showSupportsImages: true,
    showSendTools: true,
    allowManualModel: true,
    connectionPerPreset: true,
    templates: [],
  },
};

/** Legt ueber den Dialog eine Zeile an, wie ein Mensch es taete. */
async function zeileAnlegen({ name, baseUrl, model, apiKey, extraHeaders }) {
  document.getElementById('btn-open-add-model').click();
  await flush();
  const sel = document.getElementById('select-provider');
  sel.value = 'openai-compatible';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  const tippen = (id, wert) => {
    const el = document.getElementById(id);
    el.value = wert;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  tippen('input-display-name', name);
  tippen('input-base-url', baseUrl);
  tippen('input-model', model);
  if (apiKey) tippen('input-api-key', apiKey);
  if (extraHeaders) tippen('input-extra-headers', extraHeaders);
  await flush();
  document.getElementById('btn-add-preset-row').click();
  await flush();
}

const zeilenTitel = () => [...document.querySelectorAll('#pref-model-list strong')].map((n) => n.textContent);
const zeilenServer = () => [...document.querySelectorAll('#pref-model-list .settings-pref-detail')].map((n) => n.textContent);

test('zwei Zeilen desselben Anbieters behalten je eigene Adresse und Namen (#202)', async (t) => {
  const { dom } = await mountSettings({ providers: [COMPAT_VIEW] });
  t.after(dom.cleanup);

  await zeileAnlegen({ name: 'Firmen-Gateway', baseUrl: 'https://gw.firma.example/v1', model: 'gpt-4o-mini' });
  await zeileAnlegen({ name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: 'qwen2.5' });

  // Genau der Fall, der vor #202 unmoeglich war: Die zweite Eingabe hat die
  // erste ueberschrieben, beide Zeilen zeigten auf denselben Server.
  assert.deepEqual(zeilenTitel(), ['Firmen-Gateway \u00b7 gpt-4o-mini', 'LM Studio \u00b7 qwen2.5']);
  assert.match(zeilenServer()[0], /gw\.firma\.example/);
  assert.match(zeilenServer()[1], /localhost:1234/);
});

test('getippte Verbindungswerte erreichen den Main-Prozess (#202)', async (t) => {
  // Der Weg, der vorher abriss: Die Feld-Listener schrieben in den Entwurf des
  // *Anbieters*, waehrend das Formular auf dem Entwurf der *Zeile* arbeitete.
  // Adresse und Anzeigename kamen deshalb leer an, Schluessel und Header gar
  // nicht — und zwei Zeilen landeten auf demselben Server.
  let gesendet = null;
  const { dom } = await mountSettings({
    providers: [COMPAT_VIEW],
    commitSettings: async (payload) => { gesendet = payload; return { ok: true }; },
  });
  t.after(dom.cleanup);

  await zeileAnlegen({
    name: 'Mein Ziel',
    baseUrl: 'https://ziel.example/v1',
    model: 'ziel-modell',
    apiKey: 'sk-geheim',
    extraHeaders: 'X-Tenant: acme',
  });
  document.getElementById('btn-settings-save').click();
  await flush();

  const zeile = gesendet.presets.find((pr) => pr.model === 'ziel-modell');
  assert.deepEqual(zeile.connection, {
    displayName: 'Mein Ziel',
    baseUrl: 'https://ziel.example/v1',
    apiStyle: 'chat',
    insecureTls: false,
    supportsImages: false,
    sendTools: true,
    apiKey: 'sk-geheim',
    extraHeaders: 'X-Tenant: acme',
  });
  // Die Ja/Nein-Angaben zu Geheimnissen bleiben im Renderer; der Main-Prozess
  // weiss selbst, was gespeichert ist.
  assert.equal('hasKey' in zeile.connection, false);
  assert.equal('draft' in zeile.connection, false);
});

test('eine bestehende Zeile laesst sich bearbeiten, statt eine neue anzulegen (#202)', async (t) => {
  const { dom } = await mountSettings({ providers: [COMPAT_VIEW] });
  t.after(dom.cleanup);

  await zeileAnlegen({ name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: 'qwen2.5' });
  assert.equal(zeilenTitel().length, 1);

  document.querySelector('.settings-icon-edit').click();
  await flush();

  // Der Dialog sagt, dass er bearbeitet, und der Anbieter steht fest.
  assert.equal(document.getElementById('dialog-add-model-title').textContent, 'Modell bearbeiten');
  assert.equal(document.getElementById('btn-add-preset-row').textContent, '\u00c4nderungen \u00fcbernehmen');
  assert.equal(document.getElementById('select-provider').disabled, true);
  assert.equal(document.getElementById('input-display-name').value, 'LM Studio');
  assert.equal(document.getElementById('input-base-url').value, 'http://localhost:1234/v1');
  assert.equal(document.getElementById('input-model').value, 'qwen2.5');

  const url = document.getElementById('input-base-url');
  url.value = 'http://localhost:9999/v1';
  url.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  document.getElementById('btn-add-preset-row').click();
  await flush();

  assert.equal(zeilenTitel().length, 1, 'Bearbeiten darf keine zweite Zeile anlegen');
  assert.match(zeilenServer()[0], /localhost:9999/);
});

test('der Dialog kehrt nach dem Bearbeiten in den Anlegen-Modus zurueck (#202)', async (t) => {
  const { dom } = await mountSettings({ providers: [COMPAT_VIEW] });
  t.after(dom.cleanup);

  await zeileAnlegen({ name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: 'qwen2.5' });
  document.querySelector('.settings-icon-edit').click();
  await flush();
  document.getElementById('btn-add-model-close').click();
  await flush();
  document.getElementById('btn-open-add-model').click();
  await flush();

  assert.equal(document.getElementById('dialog-add-model-title').textContent, 'Modell hinzuf\u00fcgen');
  assert.equal(document.getElementById('select-provider').disabled, false);
});

test('ein gespeichertes Geheimnis bleibt beim Bearbeiten stehen (#202)', async (t) => {
  let gesendet = null;
  // Zeile mit bereits gespeichertem Schluessel und Header, wie sie aus dem
  // Main-Prozess kommt: nur die Ja/Nein-Angaben, nie die Werte.
  const gespeichert = {
    id: 'p1',
    providerId: 'openai-compatible',
    model: 'qwen2.5',
    menuVisible: true,
    configured: true,
    label: 'LM Studio \u00b7 qwen2.5',
    connection: {
      displayName: 'LM Studio',
      baseUrl: 'http://localhost:1234/v1',
      apiStyle: 'chat',
      insecureTls: false,
      supportsImages: false,
      sendTools: true,
      hasKey: true,
      keyUnreadable: false,
      hasExtraHeaders: true,
    },
  };
  const { dom, appStore } = await mountSettings({
    providers: [COMPAT_VIEW],
    commitSettings: async (payload) => { gesendet = payload; return { ok: true }; },
  });
  t.after(dom.cleanup);
  appStore.llmState.presets = [gespeichert];
  appStore.llmState.activePresetId = 'p1';
  await dom.reopenSettings();

  document.querySelector('.settings-icon-edit').click();
  await flush();
  // Die Felder bleiben leer und sagen stattdessen, dass das Gespeicherte haelt.
  assert.equal(document.getElementById('input-api-key').value, '');
  assert.equal(document.getElementById('input-api-key').placeholder, 'Gespeicherter Key bleibt erhalten');
  assert.equal(document.getElementById('input-extra-headers').placeholder, 'Gespeicherte Header bleiben erhalten');

  document.getElementById('btn-add-preset-row').click();
  await flush();
  document.getElementById('btn-settings-save').click();
  await flush();

  const zeile = gesendet.presets[0];
  assert.equal('apiKey' in zeile.connection, false, 'nichts Neues ueberschreiben');
  assert.equal('removeApiKey' in zeile.connection, false, 'und nichts loeschen');
  assert.equal(zeile.connection.baseUrl, 'http://localhost:1234/v1');
});

test('die Sichtbarkeit im Modellmenue schaltet die native Checkbox, der Fokus bleibt (#336)', async (t) => {
  let gesendet = null;
  const { dom, appStore } = await mountSettings({
    providers: [COMPAT_VIEW],
    commitSettings: async (payload) => { gesendet = payload; return { ok: true }; },
  });
  t.after(dom.cleanup);
  appStore.llmState.presets = [{
    id: 'p1',
    providerId: 'openai-compatible',
    model: 'qwen2.5',
    menuVisible: true,
    configured: true,
    connection: {
      displayName: 'LM Studio',
      baseUrl: 'http://localhost:1234/v1',
      apiStyle: 'chat',
      insecureTls: false,
      supportsImages: false,
      sendTools: true,
      hasKey: false,
      keyUnreadable: false,
      hasExtraHeaders: false,
    },
  }];
  appStore.llmState.activePresetId = 'p1';
  await dom.reopenSettings();

  const sw = document.querySelector('#pref-model-list .ds-switch');
  assert.equal(sw.type, 'checkbox');
  assert.equal(sw.getAttribute('role'), 'switch');
  assert.equal(sw.checked, true);
  // The name says what "on" means and does not change with the state.
  const name = sw.getAttribute('aria-label');
  assert.match(name, /^LM Studio \u00b7 qwen2\.5 \u2014 /);

  sw.focus();
  sw.click();
  await flush();
  assert.equal(sw.checked, false);
  assert.equal(document.activeElement, sw, 'kein Neuzeichnen, das den Fokus verliert');
  assert.equal(sw.getAttribute('aria-label'), name);
  assert.equal(sw.closest('.settings-pref-row-inner').getAttribute('data-pref-menu-off'), 'true');

  document.getElementById('btn-settings-save').click();
  await flush();
  assert.equal(gesendet.presets[0].menuVisible, false);
});

test('der Papierkorb neben dem Feld loescht das gespeicherte Geheimnis (#202)', async (t) => {
  let gesendet = null;
  const { dom, appStore } = await mountSettings({
    providers: [COMPAT_VIEW],
    commitSettings: async (payload) => { gesendet = payload; return { ok: true }; },
  });
  t.after(dom.cleanup);
  appStore.llmState.presets = [{
    id: 'p1',
    providerId: 'openai-compatible',
    model: 'qwen2.5',
    menuVisible: true,
    configured: true,
    connection: {
      displayName: 'LM Studio',
      baseUrl: 'http://localhost:1234/v1',
      apiStyle: 'chat',
      insecureTls: false,
      supportsImages: false,
      sendTools: true,
      hasKey: true,
      keyUnreadable: false,
      hasExtraHeaders: true,
    },
  }];
  appStore.llmState.activePresetId = 'p1';
  await dom.reopenSettings();

  document.querySelector('.settings-icon-edit').click();
  await flush();
  document.getElementById('btn-remove-api-key').click();
  document.getElementById('btn-remove-extra-headers').click();
  await flush();
  assert.equal(document.getElementById('input-api-key').placeholder, 'Key wird beim Speichern entfernt');

  document.getElementById('btn-add-preset-row').click();
  await flush();
  document.getElementById('btn-settings-save').click();
  await flush();

  assert.equal(gesendet.presets[0].connection.removeApiKey, true);
  assert.equal(gesendet.presets[0].connection.removeExtraHeaders, true);
});

test('die Vorlage belegt Adresse und API-Stil vor (#193)', async (t) => {
  const mitVorlagen = {
    ...COMPAT_VIEW,
    form: {
      ...COMPAT_VIEW.form,
      templates: [
        { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiStyle: 'chat', hint: 'Router-Dienst.' },
      ],
      apiStyleOptions: [
        { value: 'chat', label: 'Nur Chat Completions' },
        { value: 'full', label: 'Responses, sonst Chat Completions' },
      ],
    },
  };
  const { dom } = await mountSettings({ providers: [mitVorlagen] });
  t.after(dom.cleanup);

  document.getElementById('btn-open-add-model').click();
  await flush();
  const sel = document.getElementById('select-provider');
  sel.value = 'openai-compatible';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();

  const vorlage = document.getElementById('select-provider-template');
  vorlage.value = 'openrouter';
  vorlage.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();

  assert.equal(document.getElementById('input-base-url').value, 'https://openrouter.ai/api/v1');
  assert.equal(document.getElementById('select-api-style').value, 'chat');
  assert.match(document.getElementById('provider-template-hint').textContent, /Router-Dienst/);
});

// --- The connection on screen (CR-B14-05) -----------------------------------

const type = (id, value) => {
  const el = document.getElementById(id);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

async function openCompatPopup() {
  document.getElementById('btn-open-add-model').click();
  await flush();
  const sel = document.getElementById('select-provider');
  sel.value = 'openai-compatible';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
}

/** A stored gateway row as main sends it: yes/no about secrets, never values. */
const STORED_GATEWAY_ROW = {
  id: 'p1',
  providerId: 'openai-compatible',
  model: 'gpt-4o',
  menuVisible: true,
  configured: true,
  connection: {
    displayName: 'Gateway',
    baseUrl: 'https://gw.example/v1',
    apiStyle: 'chat',
    insecureTls: false,
    supportsImages: false,
    sendTools: true,
    hasKey: true,
    keyUnreadable: false,
    hasExtraHeaders: true,
  },
};

test('"Load models" asks the server typed into the popup, with its key and headers (CR-B14-05)', async (t) => {
  const requests = [];
  const { dom } = await mountSettings({
    providers: [COMPAT_VIEW],
    listModels: async (request) => { requests.push(request); return { models: [] }; },
  });
  t.after(dom.cleanup);

  await openCompatPopup();
  type('input-base-url', 'https://gw.example/v1');
  type('input-api-key', 'sk-gw');
  type('input-extra-headers', 'X-Tenant: acme');
  document.getElementById('btn-load-models').click();
  await flush();

  // Before the fix: the provider's default server, no key, no headers.
  assert.deepEqual(requests, [{
    providerId: 'openai-compatible',
    apiKey: 'sk-gw',
    baseUrl: 'https://gw.example/v1',
    insecureTls: false,
    extraHeaders: 'X-Tenant: acme',
    presetId: undefined,
  }]);
});

test('"Load models" on an edited row names the row, so main can use its stored key (CR-B14-05)', async (t) => {
  const requests = [];
  const { dom, appStore } = await mountSettings({
    providers: [COMPAT_VIEW],
    listModels: async (request) => { requests.push(request); return { models: [] }; },
  });
  t.after(dom.cleanup);
  appStore.llmState.presets = [STORED_GATEWAY_ROW];
  appStore.llmState.activePresetId = 'p1';
  await dom.reopenSettings();

  document.querySelector('.settings-icon-edit').click();
  await flush();
  document.getElementById('btn-load-models').click();
  await flush();

  assert.deepEqual(requests, [{
    providerId: 'openai-compatible',
    apiKey: undefined,
    baseUrl: 'https://gw.example/v1',
    insecureTls: false,
    extraHeaders: undefined,
    presetId: 'p1',
  }]);
});

test('the same model on a second server is a second entry (CR-B14-05)', async (t) => {
  const { dom } = await mountSettings({ providers: [COMPAT_VIEW] });
  t.after(dom.cleanup);

  await zeileAnlegen({ name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: 'qwen2.5' });
  await zeileAnlegen({ name: 'Gateway', baseUrl: 'https://gw.example/v1', model: 'qwen2.5' });

  assert.deepEqual(zeilenTitel(), ['LM Studio · qwen2.5', 'Gateway · qwen2.5']);
  assert.ok(document.getElementById('add-model-overlay').classList.contains('hidden'));
});

test('the same model on the same server is refused as a duplicate (CR-B14-05)', async (t) => {
  const { dom } = await mountSettings({ providers: [COMPAT_VIEW] });
  t.after(dom.cleanup);

  await zeileAnlegen({ name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: 'qwen2.5' });
  // A trailing slash does not make it another server.
  await zeileAnlegen({ name: 'Again', baseUrl: 'http://localhost:1234/v1/', model: 'qwen2.5' });

  assert.deepEqual(zeilenTitel(), ['LM Studio · qwen2.5']);
  assert.equal(document.getElementById('add-model-overlay').classList.contains('hidden'), false, 'the popup stays open');
  assert.equal(
    document.getElementById('model-status').textContent,
    'LM Studio · qwen2.5 steht schon in der Liste. Ändern kannst du den Eintrag mit dem Stift daneben.',
  );
});

// --- #807: the key-less entry of a fresh profile -----------------------------

/** OpenAI as a fresh profile sees it: no key, the one default entry. */
const FRESH_OPENAI_VIEW = {
  id: 'openai',
  name: 'OpenAI',
  builtInName: 'OpenAI',
  configured: false,
  hasKey: false,
  defaultModel: 'gpt-5-mini',
  apiBase: 'https://api.openai.com/v1',
  capabilities: { images: true },
  presetFields: [],
  form: { showApiKey: true, apiKeyPlaceholder: 'sk-…' },
};

async function mountFreshProfile(t, { view = FRESH_OPENAI_VIEW } = {}) {
  let sent = null;
  const mounted = await mountSettings({
    providers: [view],
    commitSettings: async (payload) => { sent = payload; return { ok: true }; },
  });
  t.after(mounted.dom.cleanup);
  mounted.appStore.llmState.presets = [
    { id: 'default', providerId: 'openai', model: 'gpt-5-mini', menuVisible: true, label: 'OpenAI · gpt-5-mini' },
  ];
  mounted.appStore.llmState.activePresetId = 'default';
  await mounted.dom.reopenSettings();
  return { ...mounted, sent: () => sent };
}

/** Add model → OpenAI, the suggested model, optionally a key → Apply. */
async function addOpenAiModel({ apiKey } = {}) {
  document.getElementById('btn-open-add-model').click();
  await flush();
  if (apiKey) {
    const key = document.getElementById('input-api-key');
    key.value = apiKey;
    key.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await flush();
  document.getElementById('btn-add-preset-row').click();
  await flush();
}

test('adding the key-less default entry with a key completes it (#807)', async (t) => {
  const { sent } = await mountFreshProfile(t);

  await addOpenAiModel({ apiKey: 'sk-first' });

  assert.equal(document.getElementById('add-model-overlay').classList.contains('hidden'), true, 'the popup closes');
  assert.deepEqual(zeilenTitel(), ['OpenAI · gpt-5-mini'], 'no second row');
  assert.equal(document.getElementById('model-status').textContent, '');
  // Focus lands on the entry that took the key, as after editing it.
  assert.equal(document.activeElement?.dataset.editPresetId, 'default');

  document.getElementById('btn-settings-save').click();
  await flush();
  assert.deepEqual(sent().presets.map((p) => p.id), ['default'], 'the entry keeps its id');
  assert.equal(sent().activePresetId, 'default');
  assert.equal(sent().providerPatches.openai.apiKey, 'sk-first');
});

test('the key-less entry without a key typed is still refused, naming it (#807)', async (t) => {
  await mountFreshProfile(t);

  await addOpenAiModel();

  assert.equal(document.getElementById('add-model-overlay').classList.contains('hidden'), false);
  assert.deepEqual(zeilenTitel(), ['OpenAI · gpt-5-mini']);
  assert.equal(
    document.getElementById('model-status').textContent,
    'OpenAI · gpt-5-mini steht schon in der Liste. Ändern kannst du den Eintrag mit dem Stift daneben.',
  );
});

test('an entry that already has its key is a real duplicate (#807)', async (t) => {
  await mountFreshProfile(t, { view: { ...FRESH_OPENAI_VIEW, configured: true, hasKey: true } });

  await addOpenAiModel({ apiKey: 'sk-second' });

  assert.equal(document.getElementById('add-model-overlay').classList.contains('hidden'), false);
  assert.deepEqual(zeilenTitel(), ['OpenAI · gpt-5-mini']);
  assert.match(document.getElementById('model-status').textContent, /^OpenAI · gpt-5-mini steht schon in der Liste\./);
});

test('a key that can no longer be decrypted counts as missing (#807)', async (t) => {
  await mountFreshProfile(t, { view: { ...FRESH_OPENAI_VIEW, hasKey: true, keyUnreadable: true } });

  await addOpenAiModel({ apiKey: 'sk-again' });

  assert.equal(document.getElementById('add-model-overlay').classList.contains('hidden'), true);
  assert.deepEqual(zeilenTitel(), ['OpenAI · gpt-5-mini']);
});

test('a key-less entry with its own connection takes the key typed for it (#807)', async (t) => {
  let sent = null;
  const { dom } = await mountSettings({
    providers: [COMPAT_VIEW],
    commitSettings: async (payload) => { sent = payload; return { ok: true }; },
  });
  t.after(dom.cleanup);

  await zeileAnlegen({ name: 'Gateway', baseUrl: 'https://gw.example/v1', model: 'qwen2.5' });
  await zeileAnlegen({ name: 'Gateway', baseUrl: 'https://gw.example/v1', model: 'qwen2.5', apiKey: 'sk-gw' });

  assert.deepEqual(zeilenTitel(), ['Gateway · qwen2.5']);
  assert.equal(document.getElementById('add-model-overlay').classList.contains('hidden'), true);
  document.getElementById('btn-settings-save').click();
  await flush();
  assert.equal(sent.presets.length, 1);
  assert.equal(sent.presets[0].connection.apiKey, 'sk-gw');
});

test('typing a key keeps a loaded model list and the model picked from it (CR-B14-05)', async (t) => {
  const { dom } = await mountSettings({
    providers: [OPENAI_VIEW],
    listModels: async () => ({ models: [{ id: 'gpt-4o' }, { id: 'gpt-4.1' }, { id: 'o3' }] }),
  });
  t.after(dom.cleanup);

  document.getElementById('btn-open-add-model').click();
  await flush();
  document.getElementById('btn-load-models').click();
  await flush();
  const select = document.getElementById('select-model');
  const options = () => [...select.options].map((o) => o.value);
  const loaded = options();
  assert.ok(['gpt-4o', 'gpt-4.1', 'o3'].every((id) => loaded.includes(id)));
  select.value = 'o3';
  select.dispatchEvent(new Event('change', { bubbles: true }));

  type('input-api-key', 's');
  await flush();

  // Before the fix one keystroke left only the stored model.
  assert.deepEqual(options(), loaded);
  assert.equal(select.value, 'o3');
  assert.equal(document.getElementById('model-status').textContent, '3 Modelle gefunden.');
  // What the keystroke is for still happens: the status line knows about the key.
  assert.match(document.getElementById('provider-status').textContent, /Key/);
});

test('typing a header keeps the loaded name suggestions (CR-B14-05)', async (t) => {
  const { dom } = await mountSettings({
    providers: [COMPAT_VIEW],
    listModels: async () => ({ models: [{ id: 'gpt-4o' }, { id: 'gpt-4.1' }, { id: 'o3' }] }),
  });
  t.after(dom.cleanup);

  await openCompatPopup();
  document.getElementById('btn-load-models').click();
  await flush();
  type('input-model', 'o3');
  type('input-extra-headers', 'X-Tenant: a');
  await flush();

  assert.deepEqual(
    [...document.querySelectorAll('#model-name-options option')].map((o) => o.value),
    ['gpt-4o', 'gpt-4.1', 'o3'],
  );
  assert.equal(document.getElementById('input-model').value, 'o3');
  assert.equal(document.getElementById('model-status').textContent, '3 Modelle gefunden.');
});

/**
 * OpenAI as the main process describes it: two options of its own, drawn as a
 * segmented control and a switch (#414).
 */
const OPENAI_VIEW = {
  id: 'openai',
  name: 'OpenAI',
  builtInName: 'OpenAI',
  configured: true,
  hasKey: true,
  defaultModel: 'gpt-4o-mini',
  apiBase: 'https://api.openai.com/v1',
  capabilities: { images: true },
  presetFields: [
    {
      key: 'reasoningEffort',
      type: 'select',
      control: 'segmented',
      label: 'Reasoning',
      hint: 'Wie gr\u00fcndlich das Modell nachdenkt (`reasoning_effort`).',
      options: [
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
      ],
      defaultValue: 'medium',
      affectsPresetIdentity: true,
      detailPrefix: '',
      showAsSuffix: true,
      detailStyle: 'mono',
    },
    {
      key: 'reasoningSummary',
      type: 'select',
      control: 'switch',
      label: 'Zusammenfassung',
      toggleLabel: 'Im Chat zeigen',
      hint: 'Erscheint im Chat (`reasoning.summary`).',
      options: [
        { value: 'off', label: 'aus' },
        { value: 'auto', label: 'auto' },
      ],
      defaultValue: 'off',
      affectsPresetIdentity: false,
      detailPrefix: '',
      showAsSuffix: false,
      detailStyle: 'mono',
    },
  ],
  form: { showApiKey: true, apiKeyPlaceholder: 'sk-\u2026' },
};

test('reasoning effort is a segmented control, the summary a switch (#414)', async (t) => {
  let sent = null;
  const { dom } = await mountSettings({
    providers: [OPENAI_VIEW],
    commitSettings: async (payload) => { sent = payload; return { ok: true }; },
  });
  t.after(dom.cleanup);

  document.getElementById('btn-open-add-model').click();
  await flush();

  const group = document.getElementById('preset-field-reasoningEffort');
  assert.equal(group.getAttribute('role'), 'radiogroup');
  assert.equal(document.getElementById(group.getAttribute('aria-labelledby')).textContent, 'Reasoning');
  const levels = [...group.querySelectorAll('input[type="radio"]')];
  assert.deepEqual(levels.map((r) => r.value), ['low', 'medium', 'high']);
  assert.equal(levels.find((r) => r.checked).value, 'medium');

  const toggle = document.getElementById('preset-field-reasoningSummary');
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.equal(toggle.checked, false);
  assert.equal(toggle.closest('label').textContent, 'Im Chat zeigen');
  assert.equal(document.querySelector('label[for="preset-field-reasoningSummary"]').textContent, 'Zusammenfassung');

  // Parameter names in backticks become code, the rest stays plain text.
  const hint = document.getElementById(group.getAttribute('aria-describedby'));
  assert.equal(hint.querySelector('code').textContent, 'reasoning_effort');
  assert.equal(hint.textContent, 'Wie gr\u00fcndlich das Modell nachdenkt (reasoning_effort).');

  levels[2].click();
  toggle.click();
  await flush();
  document.getElementById('btn-add-preset-row').click();
  await flush();
  document.getElementById('btn-settings-save').click();
  await flush();

  const row = sent.presets.find((pr) => pr.providerId === 'openai');
  assert.equal(row.reasoningEffort, 'high');
  assert.equal(row.reasoningSummary, 'auto');
});

test('the switch turned off again yields the first option (#414)', async (t) => {
  let sent = null;
  const { dom } = await mountSettings({
    providers: [OPENAI_VIEW],
    commitSettings: async (payload) => { sent = payload; return { ok: true }; },
  });
  t.after(dom.cleanup);

  document.getElementById('btn-open-add-model').click();
  await flush();
  const toggle = document.getElementById('preset-field-reasoningSummary');
  toggle.click();
  toggle.click();
  await flush();
  document.getElementById('btn-add-preset-row').click();
  await flush();
  document.getElementById('btn-settings-save').click();
  await flush();

  const row = sent.presets.find((pr) => pr.providerId === 'openai');
  assert.equal(row.reasoningEffort, 'medium');
  assert.equal(row.reasoningSummary, 'off');
});

/** OpenAI with the rule main sends along since #724: GPT-5 and newer. */
const OFFERING_OPENAI_VIEW = {
  ...OPENAI_VIEW,
  defaultModel: 'gpt-5-mini',
  form: {
    ...OPENAI_VIEW.form,
    offeredModels: require('../src/main/providers/openai').presentation.offeredModels,
    offeredModelsHint: 'Snotra bietet GPT-5 und neuer an. Dieses \u00e4ltere Modell l\u00e4uft weiter, aber ohne Reasoning-Level.',
  },
};

test('an entry with an older model keeps it, without the reasoning fields (#724)', async (t) => {
  const { dom, appStore } = await mountSettings({
    providers: [OFFERING_OPENAI_VIEW],
    listModels: async () => ({ models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] }),
  });
  t.after(dom.cleanup);
  appStore.llmState.presets = [{
    id: 'old',
    providerId: 'openai',
    model: 'gpt-4o-mini',
    reasoningEffort: 'high',
    menuVisible: true,
    configured: true,
    label: 'OpenAI \u00b7 gpt-4o-mini',
  }];
  appStore.llmState.activePresetId = 'old';
  await dom.reopenSettings();

  // The list says so, in place of the level.
  assert.equal(document.querySelector('.settings-pref-main strong').textContent, 'OpenAI \u00b7 gpt-4o-mini');
  assert.equal(
    document.querySelector('.settings-pref-detail').textContent,
    '\u00c4lteres Modell, wird nicht mehr angeboten',
  );

  document.querySelector('.settings-icon-edit').click();
  await flush();
  const select = document.getElementById('select-model');
  const fields = document.getElementById('preset-fields-popup');
  const hint = document.getElementById('model-offer-hint');
  assert.equal(select.value, 'gpt-4o-mini');
  assert.equal(fields.classList.contains('hidden'), true);
  assert.equal(hint.classList.contains('hidden'), false);
  assert.equal(hint.textContent, OFFERING_OPENAI_VIEW.form.offeredModelsHint);
  assert.deepEqual(select.getAttribute('aria-describedby').split(' '), [
    'model-status', 'model-offer-hint', 'popup-model-catalog-hint',
  ]);

  // The loaded list keeps the entry's own model; a current one brings the
  // fields back and the hint goes.
  document.getElementById('btn-load-models').click();
  await flush();
  assert.deepEqual([...select.options].map((o) => o.value), ['gpt-5', 'gpt-5-mini', 'gpt-4o-mini']);
  assert.equal(select.value, 'gpt-4o-mini');
  assert.equal(fields.classList.contains('hidden'), true);

  select.value = 'gpt-5';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  assert.equal(fields.classList.contains('hidden'), false);
  assert.equal(hint.classList.contains('hidden'), true);
  assert.equal(select.getAttribute('aria-describedby'), 'model-status popup-model-catalog-hint');
});

test('adding a current OpenAI model shows the reasoning fields and no hint (#724)', async (t) => {
  const { dom } = await mountSettings({ providers: [OFFERING_OPENAI_VIEW] });
  t.after(dom.cleanup);

  document.getElementById('btn-open-add-model').click();
  await flush();
  assert.equal(document.getElementById('select-model').value, 'gpt-5-mini');
  assert.equal(document.getElementById('preset-fields-popup').classList.contains('hidden'), false);
  assert.equal(document.getElementById('model-offer-hint').classList.contains('hidden'), true);
});

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
  for (const key of ['security', 'tools', 'skills', 'general']) {
    assert.equal(panelFor(key).hidden, true, `Panel ${key} muesste versteckt sein`);
  }
});

test('ein Klick auf einen Tab schaltet Panel, aria-selected und Ueberschrift um', async (t) => {
  const { dom } = await mountSettings();
  t.after(dom.cleanup);

  for (const [key, heading] of [
    ['security', 'Tools & Sicherheit'],
    ['tools', 'Tool-Einrichtung'],
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

test('a section picked while the dialog is still loading stays picked (#469)', async (t) => {
  let release = null;
  const { dom, modal } = await mountSettings({
    modalDeps: {
      // The first open (while mounting) loads at once, the second one waits.
      refreshLLMState: () => (release === undefined ? new Promise((resolve) => { release = resolve; }) : undefined),
    },
  });
  t.after(dom.cleanup);
  modal.closeSettingsModal();
  release = undefined;
  const opening = modal.openSettingsModal();
  await flush();
  // On screen and on its default section before loading is done.
  assert.equal(document.getElementById('modal-settings').classList.contains('hidden'), false);
  assert.equal(panelFor('models').hidden, false);

  tabFor('security').click();
  tabFor('security').focus();
  release();
  await opening;
  await flush();

  assert.equal(panelFor('security').hidden, false, 'the dialog went back to Models');
  assert.equal(tabFor('security').getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement, tabFor('security'), 'the focus was taken away');
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

const pressOnTab = (key, keyName, init = {}) =>
  tabFor(key).dispatchEvent(new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init }));

const selectedTabKey = () =>
  document.querySelector('.settings-nav-item[role="tab"][aria-selected="true"]').dataset.settingsPanel;

test('the tab list declares its orientation (#378)', async (t) => {
  const { dom } = await mountSettings();
  t.after(dom.cleanup);

  assert.equal(document.querySelector('[role="tablist"]').getAttribute('aria-orientation'), 'vertical');
});

test('arrow keys move to the next and previous tab, wrapping around (#378)', async (t) => {
  const { dom } = await mountSettings();
  t.after(dom.cleanup);

  const order = [...document.querySelectorAll('.settings-nav-item[role="tab"]')].map((tab) => tab.dataset.settingsPanel);
  const last = order[order.length - 1];

  for (const [from, keyName, expected] of [
    [order[0], 'ArrowDown', order[1]],
    [order[1], 'ArrowRight', order[2]],
    [order[2], 'ArrowUp', order[1]],
    [order[1], 'ArrowLeft', order[0]],
    [order[0], 'ArrowUp', last],
    [last, 'ArrowDown', order[0]],
    [order[0], 'ArrowLeft', last],
    [last, 'ArrowRight', order[0]],
  ]) {
    tabFor(from).focus();
    pressOnTab(from, keyName);
    await flush();

    assert.equal(selectedTabKey(), expected, `${keyName} from ${from}`);
    assert.equal(document.activeElement, tabFor(expected), `focus after ${keyName} from ${from}`);
    assert.equal(panelFor(expected).hidden, false);
    assert.equal(tabFor(expected).tabIndex, 0);
  }
});

test('Home and End jump to the first and last tab (#378)', async (t) => {
  const { dom } = await mountSettings();
  t.after(dom.cleanup);

  const order = [...document.querySelectorAll('.settings-nav-item[role="tab"]')].map((tab) => tab.dataset.settingsPanel);

  pressOnTab('skills', 'End');
  await flush();
  assert.equal(selectedTabKey(), order[order.length - 1]);
  assert.equal(document.activeElement, tabFor(order[order.length - 1]));

  pressOnTab(order[order.length - 1], 'Home');
  await flush();
  assert.equal(selectedTabKey(), order[0]);
  assert.equal(document.activeElement, tabFor(order[0]));
});

test('arrows with a modifier and other keys leave the tabs alone (#378)', async (t) => {
  const { dom } = await mountSettings();
  t.after(dom.cleanup);

  pressOnTab('models', 'ArrowDown', { altKey: true });
  pressOnTab('models', 'a');
  await flush();

  assert.equal(selectedTabKey(), 'models');
});

test('Escape on a focused tab still closes the dialog (#378)', async (t) => {
  const { dom } = await mountSettings();
  t.after(dom.cleanup);

  tabFor('models').focus();
  pressOnTab('models', 'Escape');
  await flush();

  assert.ok(document.getElementById('modal-settings').classList.contains('hidden'));
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

  // Security (#448, #449) writes on the click — a hint at "Apply" would
  // simply be wrong there.
  tabFor('security').click();
  await flush();
  assert.match(hint(), /wirken sofort/);
  // MCP is no section of its own any more; its servers sit on Tool setup (#767).
  assert.equal(tabFor('mcp'), null, 'the MCP tab is gone (#767)');
  assert.equal(panelFor('mcp'), null, 'the MCP panel is gone (#767)');

  // Memory is immediate throughout since #297; tools and general are split.
  assert.equal(document.getElementById('tab-settings-permissions'), null, 'the Permissions tab is gone (#449)');
  tabFor('memory').click();
  await flush();
  assert.match(hint(), /wirken sofort/);

  tabFor('tools').click();
  await flush();
  assert.match(hint(), /Schlüssel wird mit seinem Knopf gespeichert, MCP-Server sofort; Interpreter und Bildmodell mit Übernehmen/);

  tabFor('general').click();
  await flush();
  assert.match(hint(), /Schalter, Erscheinungsbild und Sprache wirken sofort/);
});

test('der Dialog haengt am Menueeintrag statt an einem Knopf im Chat', async (t) => {
  // Das Zahnrad sass in der Kopfzeile des Chats und war mit dessen Spalte weg.
  // Seitdem fuehrt nur noch der Menueeintrag "Einstellungen…" bzw. Cmd/Ctrl+Komma
  // hinein — der Renderer muss sich dafuer beim Main anmelden.
  let trigger = null;
  const { dom, modal } = await mountSettings({
    onOpenSettings: (callback) => { trigger = callback; },
  });
  t.after(dom.cleanup);
  const modalSettings = document.getElementById('modal-settings');

  assert.equal(document.getElementById('btn-chat-settings'), null, 'kein Zahnrad mehr');
  assert.equal(typeof trigger, 'function', 'der Renderer meldet sich beim Menue an');

  modal.closeSettingsModal();
  assert.ok(modalSettings.classList.contains('hidden'));

  trigger();
  await flush();
  assert.ok(!modalSettings.classList.contains('hidden'), 'der Menueeintrag oeffnet ihn');
});

test('ein zweiter Menueaufruf bei offenem Dialog laesst den gemerkten Fokus stehen', async (t) => {
  let trigger = null;
  const { dom, appStore } = await mountSettings({
    onOpenSettings: (callback) => { trigger = callback; },
  });
  t.after(dom.cleanup);

  const davor = document.getElementById('chat-input');
  appStore.lastFocusBeforeModal = davor;

  trigger();
  await flush();

  assert.equal(
    appStore.lastFocusBeforeModal,
    davor,
    'sonst landete der Fokus nach dem Schliessen im Dialog selbst'
  );
});

// —— Erscheinungsbild (hell/dunkel) ——
//
// The switch sat in the title bar as a button until v1.7.3; since then it is
// a choice under "General". The open dialog shows the appearance in force,
// and since #297 a pick takes effect at once — no Apply involved, and the
// footer of that section says so.

function mountMitTheme({ theme = 'light', ...overrides } = {}) {
  const gesetzt = [];
  const mounted = mountSettings({
    modalDeps: {
      getTheme: () => theme,
      setTheme: (mode) => { gesetzt.push(mode); return mode; },
    },
    ...overrides,
  });
  return { mounted, gesetzt };
}

/** Pick a segment the way a click does: check the radio, fire change. */
function pick(name, value) {
  const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
}

const checkedValue = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;

test('der Dialog zeigt das geltende Erscheinungsbild', async (t) => {
  const { mounted } = mountMitTheme({ theme: 'dark' });
  const { dom } = await mounted;
  t.after(dom.cleanup);

  assert.equal(checkedValue('app-theme'), 'dark');
});

test('das Erscheinungsbild wechselt sofort, ohne „Uebernehmen" (#297)', async (t) => {
  let committed = 0;
  const { mounted, gesetzt } = mountMitTheme({
    theme: 'light',
    commitSettings: async () => { committed += 1; return { ok: true }; },
  });
  const { dom } = await mounted;
  t.after(dom.cleanup);

  pick('app-theme', 'dark');
  await flush();

  assert.deepEqual(gesetzt, ['dark']);
  assert.equal(committed, 0, 'no Apply involved');
  const status = document.getElementById('status-app-theme');
  assert.equal(status.textContent, 'Gespeichert');
  assert.ok(status.classList.contains('is-visible'));
});

test('die Sprache wird sofort gespeichert und umgeschaltet (#297)', async (t) => {
  const patches = [];
  const { dom } = await mountSettings({
    setUIPrefs: async (patch) => { patches.push(patch); return { appLocale: 'de', ...patch }; },
  });
  t.after(dom.cleanup);
  assert.equal(checkedValue('app-locale'), 'de');

  pick('app-locale', 'en');
  await flush();

  assert.deepEqual(patches, [{ appLocale: 'en' }]);
  assert.equal(document.getElementById('settings-panel-heading').textContent, 'Models');
  // The confirmation speaks the language that was just chosen.
  assert.equal(document.getElementById('status-app-locale').textContent, 'Saved');
});

test('scheitert das Speichern der Sprache, springt die Auswahl zurueck (#297)', async (t) => {
  const { dom } = await mountSettings({
    setUIPrefs: async () => { throw new Error('disk full'); },
  });
  t.after(dom.cleanup);

  pick('app-locale', 'en');
  await flush();

  assert.equal(checkedValue('app-locale'), 'de');
  assert.equal(document.getElementById('settings-panel-heading').textContent, 'Modelle');
  const status = document.getElementById('status-app-locale');
  assert.equal(status.textContent, 'Nicht gespeichert');
  assert.ok(status.classList.contains('is-error'));
});

for (const [id, key] of [
  ['input-environment-info', 'environmentInfoEnabled'],
  ['input-project-instructions', 'projectInstructionsEnabled'],
  ['input-python-enabled', 'pythonExecutionEnabled'],
  ['input-shell-enabled', 'shellExecutionEnabled'],
]) {
  test(`der Schalter ${id} speichert sofort (#297)`, async (t) => {
    const patches = [];
    const { dom } = await mountSettings({
      setUIPrefs: async (patch) => { patches.push(patch); return { ...patch }; },
    });
    t.after(dom.cleanup);
    const input = document.getElementById(id);
    assert.equal(input.getAttribute('role'), 'switch');

    const before = input.checked;
    input.click();
    await flush();

    assert.deepEqual(patches, [{ [key]: !before }]);
    assert.equal(input.checked, !before);
    assert.equal(document.getElementById(id.replace('input-', 'status-')).textContent, 'Gespeichert');
  });
}

test('ein Schalter, den der Speicher nicht annimmt, springt zurueck (#297)', async (t) => {
  // The store answers with the old value: no exception, but not stored either.
  const { dom } = await mountSettings({
    setUIPrefs: async () => ({ environmentInfoEnabled: true }),
  });
  t.after(dom.cleanup);
  const input = document.getElementById('input-environment-info');
  assert.equal(input.checked, true);

  input.click();
  await flush();

  assert.equal(input.checked, true, 'back to what is stored');
  assert.equal(document.getElementById('status-environment-info').textContent, 'Nicht gespeichert');
});

test('nach einem Fehlschlag steht der Schalter auf dem geladenen Wert (#297)', async (t) => {
  // Not on the one the markup happened to carry: the dialog loaded "on", so
  // that is where a rejected flip has to land.
  const { dom } = await mountSettings({
    getUIPrefs: async () => ({ baseSystemPrompt: '', appLocale: 'de', disabledTools: [], pythonExecutionEnabled: true }),
    setUIPrefs: async () => { throw new Error('disk full'); },
  });
  t.after(dom.cleanup);
  const input = document.getElementById('input-python-enabled');
  assert.equal(input.checked, true, 'geladen: an');

  input.click();
  await flush();

  assert.equal(input.checked, true);
  assert.equal(document.getElementById('status-python-enabled').textContent, 'Nicht gespeichert');
});

test('„Uebernehmen" schickt die Sofort-Einstellungen nicht noch einmal mit (#297)', async (t) => {
  let gesendet = null;
  const { dom } = await mountSettings({
    commitSettings: async (payload) => { gesendet = payload; return { ok: true }; },
  });
  t.after(dom.cleanup);

  document.getElementById('btn-settings-save').click();
  await flush();

  for (const key of [
    'appLocale',
    'environmentInfoEnabled',
    'projectInstructionsEnabled',
    'pythonExecutionEnabled',
    'shellExecutionEnabled',
    'memorySelfEnabled',
    'memoryWorkspaceEnabled',
    'memoryUserEnabled',
  ]) {
    assert.equal(key in gesendet.uiPrefs, false, `${key} must not travel with Apply`);
  }
});

// --- Apply and the open sequence (CR-B14-06) ---------------------------------

/** A promise the test resolves by hand. */
function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

/** Collects unhandled rejections for the duration of a test. */
function watchUnhandledRejections(t) {
  const seen = [];
  const onUnhandled = (reason) => { seen.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  return seen;
}

const SYSTEM_SKILLS = [
  { name: 'pdf', description: 'PDF', source: 'system', status: 'active', path: '/sys/pdf', detail: '', builtin: true },
  { name: 'xlsx', description: 'Excel', source: 'system', status: 'active', path: '/sys/xlsx', detail: '', builtin: true },
];

const applyButton = () => document.getElementById('btn-settings-save');
const footerError = () => document.getElementById('modal-save-error');

test('Apply stays disabled until the whole open sequence has finished (CR-B14-06)', async (t) => {
  let pending = null;
  const commits = [];
  const { dom, modal } = await mountSettings({
    getSkillCatalog: () => (pending ? pending.promise : Promise.resolve({ skills: SYSTEM_SKILLS })),
    commitSettings: async (payload) => { commits.push(payload); return { ok: true }; },
  });
  t.after(dom.cleanup);
  modal.closeSettingsModal();

  // The skill catalogue comes last; until then the dialog is only half there.
  pending = gate();
  const opening = modal.openSettingsModal();
  await flush();
  assert.equal(applyButton().disabled, true, 'enabled before the catalogue arrived');
  applyButton().click();
  await flush();
  assert.equal(commits.length, 0, 'Apply during loading sent something');

  pending.release({ skills: SYSTEM_SKILLS });
  await opening;
  await flush();
  assert.equal(applyButton().disabled, false);
  applyButton().click();
  await flush();
  assert.deepEqual(commits.map((c) => c.uiPrefs.activeSkills), [['pdf', 'xlsx']]);
});

test('without a skill catalogue Apply leaves the selection alone instead of sending none (CR-B14-06)', async (t) => {
  let sent = null;
  const { dom } = await mountSettings({
    getSkillCatalog: async () => { throw new Error('scan failed'); },
    commitSettings: async (payload) => { sent = payload; return { ok: true }; },
  });
  t.after(dom.cleanup);

  applyButton().click();
  await flush();

  assert.ok(sent, 'the rest is still saved');
  assert.equal('activeSkills' in sent.uiPrefs, false, 'an empty list would switch every skill off');
});

test('after a failed load Apply stays disabled and sends nothing (CR-B14-06)', async (t) => {
  let fail = false;
  const commits = [];
  const { dom } = await mountSettings({
    commitSettings: async (payload) => { commits.push(payload); return { ok: true }; },
    modalDeps: {
      refreshLLMState: async () => { if (fail) throw new Error('main is gone'); },
    },
  });
  t.after(dom.cleanup);

  fail = true;
  await dom.reopenSettings();

  assert.equal(footerError().textContent, 'Einstellungen konnten nicht geladen werden: main is gone');
  assert.equal(applyButton().disabled, true);
  applyButton().click();
  await flush();
  assert.equal(commits.length, 0);
});

test('unreadable preferences keep Apply off instead of writing defaults over them (CR-B14-06)', async (t) => {
  let fail = false;
  const commits = [];
  const { dom } = await mountSettings({
    getUIPrefs: async () => {
      if (fail) throw new Error('disk error');
      return { baseSystemPrompt: 'Be brief.', appLocale: 'de', disabledTools: [], maxToolRounds: 30 };
    },
    commitSettings: async (payload) => { commits.push(payload); return { ok: true }; },
  });
  t.after(dom.cleanup);

  fail = true;
  await dom.reopenSettings();

  assert.match(footerError().textContent, /disk error/);
  assert.equal(applyButton().disabled, true);
  applyButton().click();
  await flush();
  assert.equal(commits.length, 0, 'the stored system prompt and round limit would be gone');
});

test('each opening starts from fresh drafts (CR-B14-06)', async (t) => {
  let fail = false;
  const { dom } = await mountSettings({
    providers: [COMPAT_VIEW],
    modalDeps: {
      refreshLLMState: async () => { if (fail) throw new Error('main is gone'); },
    },
  });
  t.after(dom.cleanup);

  // A row added and then cancelled with Close.
  await zeileAnlegen({ name: 'Cancelled', baseUrl: 'http://localhost:1234/v1', model: 'qwen2.5' });
  assert.equal(zeilenTitel().length, 1);

  fail = true;
  await dom.reopenSettings();
  assert.deepEqual(zeilenTitel(), [], 'the cancelled row is back on screen');
  assert.equal(document.getElementById('pref-list-empty').classList.contains('hidden'), true,
    'nothing was loaded, so the list does not claim to be empty');

  fail = false;
  await dom.reopenSettings();
  assert.deepEqual(zeilenTitel(), []);
});

for (const [where, gatedKey] of [
  ['while the model state loads', 'refreshLLMState'],
  ['in the middle of the sequence', 'getPythonState'],
]) {
  test(`a close ${where} opens no sub-panel on the hidden dialog (CR-B14-06)`, async (t) => {
    let pending = null;
    const opened = [];
    const spyPanel = (name) => ({
      open: async () => { opened.push(name); },
      refresh: async () => { opened.push(name); },
      close() {},
    });
    const waitIfGated = (key, value) => () => (pending && gatedKey === key ? pending.promise : Promise.resolve(value));
    const { dom, modal } = await mountSettings({
      getPythonState: waitIfGated('getPythonState', { enabled: false }),
      modalDeps: {
        refreshLLMState: waitIfGated('refreshLLMState', undefined),
        toolPermissionsPanel: spyPanel('permissions'),
        mcpPanel: spyPanel('mcp'),
        memoryPanel: spyPanel('memory'),
      },
    });
    t.after(dom.cleanup);
    modal.closeSettingsModal();
    opened.length = 0;

    pending = gate();
    const opening = modal.openSettingsModal();
    await flush();
    modal.closeSettingsModal();
    pending.release({ enabled: false });
    await opening;
    await flush();

    assert.deepEqual(opened, []);
    assert.ok(document.getElementById('modal-settings').classList.contains('hidden'));
    assert.equal(applyButton().disabled, true);
  });
}

test('a rejected Apply shows the failure in the footer, without an unhandled rejection (CR-B14-06)', async (t) => {
  const unhandled = watchUnhandledRejections(t);
  const { dom } = await mountSettings({
    commitSettings: async () => { throw new Error('IPC closed'); },
  });
  t.after(dom.cleanup);

  applyButton().click();
  await flush();
  await flush();

  assert.equal(footerError().textContent, 'Speichern fehlgeschlagen.');
  assert.equal(footerError().classList.contains('hidden'), false);
  assert.equal(document.getElementById('modal-settings').classList.contains('hidden'), false, 'the dialog stays open');
  assert.equal(applyButton().disabled, false, 'and Apply can be tried again');
  assert.deepEqual(unhandled, []);
});

test('a failing reload after a successful save says so and keeps the dialog open (CR-B14-06)', async (t) => {
  let saved = false;
  const unhandled = watchUnhandledRejections(t);
  const { dom } = await mountSettings({
    commitSettings: async () => { saved = true; return { ok: true }; },
    modalDeps: {
      refreshLLMState: async () => { if (saved) throw new Error('state unreadable'); },
    },
  });
  t.after(dom.cleanup);

  applyButton().click();
  await flush();
  await flush();

  assert.equal(footerError().textContent,
    'Gespeichert, aber die neuen Einstellungen ließen sich nicht zurücklesen: state unreadable');
  assert.equal(document.getElementById('modal-settings').classList.contains('hidden'), false);
  assert.deepEqual(unhandled, []);
});

// --- Keyboard focus after delete, redraw and edit (CR-B14-07) ---------------

/** Chromium drops the focus from a removed or disabled control; replay that. */
const replayFrame = () => focusFixup(document, { isLaidOut: (el) => el.isConnected });

const storedRow = (id, name, model, baseUrl = 'http://localhost:1234/v1') => ({
  id,
  providerId: 'openai-compatible',
  model,
  menuVisible: true,
  configured: true,
  connection: {
    displayName: name,
    baseUrl,
    apiStyle: 'chat',
    insecureTls: false,
    supportsImages: false,
    sendTools: true,
    hasKey: false,
    keyUnreadable: false,
    hasExtraHeaders: false,
  },
});

async function mountWithRows(t, rows, overrides = {}) {
  const mounted = await mountSettings({ providers: [COMPAT_VIEW], ...overrides });
  t.after(mounted.dom.cleanup);
  mounted.appStore.llmState.presets = rows;
  mounted.appStore.llmState.activePresetId = rows[0]?.id ?? null;
  await mounted.dom.reopenSettings();
  return mounted;
}

const trashOf = (id) => document.querySelector(`#pref-model-list .settings-icon-trash[data-preset-id="${id}"]`);
const editOf = (id) => document.querySelector(`#pref-model-list .settings-icon-edit[data-edit-preset-id="${id}"]`);

test('deleting a row moves the focus to the next row, the previous one, then "Add model" (CR-B14-07)', async (t) => {
  await mountWithRows(t, [storedRow('a', 'A', 'm1'), storedRow('b', 'B', 'm2'), storedRow('c', 'C', 'm3')]);

  trashOf('b').focus();
  trashOf('b').click();
  replayFrame();
  assert.ok(document.activeElement === trashOf('c'), 'the next row');

  trashOf('c').click();
  replayFrame();
  assert.ok(document.activeElement === trashOf('a'), 'no next row: the previous one');

  trashOf('a').click();
  replayFrame();
  assert.ok(document.activeElement === document.getElementById('btn-open-add-model'), 'an empty list: "Add model"');
});

test('editing a row moves the focus into the popup and back to the row on close (CR-B14-07)', async (t) => {
  await mountWithRows(t, [storedRow('a', 'A', 'm1'), storedRow('b', 'B', 'm2')]);
  const overlay = document.getElementById('add-model-overlay');

  editOf('b').focus();
  editOf('b').click();
  replayFrame();
  // The provider is fixed while editing, so its choice is disabled; the
  // first field the keyboard can reach is the display name.
  assert.ok(overlay.contains(document.activeElement), 'the focus stayed behind the popup');
  assert.equal(document.activeElement.id, 'input-display-name');

  document.getElementById('btn-add-model-close').click();
  replayFrame();
  assert.ok(document.activeElement === editOf('b'), 'Close returns to the row, not to "Add model"');

  // "Apply changes" redraws the list; the focus finds the row's new button.
  editOf('b').click();
  document.getElementById('btn-add-preset-row').click();
  replayFrame();
  assert.ok(document.activeElement === editOf('b'));

  // Escape closes the popup the same way.
  editOf('a').click();
  document.getElementById('modal-settings').dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  replayFrame();
  assert.ok(overlay.classList.contains('hidden'));
  assert.ok(document.activeElement === editOf('a'));
});

test('"Add model" still opens on the provider choice and returns to its button (CR-B14-07)', async (t) => {
  const { dom } = await mountSettings({ providers: [COMPAT_VIEW] });
  t.after(dom.cleanup);
  const add = document.getElementById('btn-open-add-model');

  add.focus();
  add.click();
  assert.ok(document.activeElement === document.getElementById('select-provider'));
  document.getElementById('btn-add-model-close-x').click();
  replayFrame();
  assert.ok(document.activeElement === add);
});

const TWO_SKILLS = [
  { name: 'pdf', description: 'PDF', source: 'user-agents', status: 'active', path: '/s/pdf', detail: '', builtin: false },
  { name: 'xlsx', description: 'Excel', source: 'user-agents', status: 'active', path: '/s/xlsx', detail: '', builtin: false },
];
const skillBox = (name) => document.querySelector(`#settings-skill-list input[data-skill-name="${name}"]`);

test('a skill list redraw by the file watcher keeps the focus on the same skill (CR-B14-07)', async (t) => {
  let onChanged = null;
  const { dom } = await mountSettings({
    getSkillCatalog: async () => ({ skills: TWO_SKILLS }),
    onSkillsChanged: (callback) => { onChanged = callback; },
  });
  t.after(dom.cleanup);
  tabFor('skills').click();

  const before = skillBox('xlsx');
  before.focus();
  // Its description is open, too.
  before.closest('li').querySelector('.settings-skill-item__summary').click();
  onChanged();
  await flush();
  replayFrame();

  assert.ok(skillBox('xlsx') !== before, 'the list was redrawn');
  assert.ok(document.activeElement === skillBox('xlsx'));
  const summary = skillBox('xlsx').closest('li').querySelector('.settings-skill-item__summary');
  assert.equal(summary.getAttribute('aria-expanded'), 'true', 'the open description stays open');
});

test('"Reload skills" gives the focus back to its button after the busy state (CR-B14-07)', async (t) => {
  const { dom } = await mountSettings({
    getSkillCatalog: async () => ({ skills: TWO_SKILLS }),
    reloadSkills: async () => ({ skills: TWO_SKILLS }),
  });
  t.after(dom.cleanup);
  tabFor('skills').click();
  const reload = document.getElementById('btn-reload-skills');

  reload.focus();
  reload.click();
  // Disabled while it runs: Chromium drops the focus here.
  replayFrame();
  assert.ok(document.activeElement === document.body);
  await flush();
  replayFrame();

  assert.equal(reload.disabled, false);
  assert.ok(document.activeElement === reload);
});

// --- WCAG details of the model list (CR-B14-08) -----------------------------

test('a model row title carries no lang, it holds translated and user-given names (CR-B14-08)', async (t) => {
  await mountWithRows(t, [storedRow('a', 'Mein Gateway', 'gpt-4o')]);
  const title = document.querySelector('#pref-model-list strong');
  assert.equal(title.textContent, 'Mein Gateway · gpt-4o');
  assert.equal(title.hasAttribute('lang'), false);
});

test('the duplicate message lands in the announced status region (CR-B14-08)', async (t) => {
  const { dom } = await mountSettings({ providers: [COMPAT_VIEW] });
  t.after(dom.cleanup);

  await zeileAnlegen({ name: 'A', baseUrl: 'http://localhost:1234/v1', model: 'qwen2.5' });
  await zeileAnlegen({ name: 'B', baseUrl: 'http://localhost:1234/v1', model: 'qwen2.5' });

  const status = document.getElementById('model-status');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.textContent, 'A · qwen2.5 steht schon in der Liste. Ändern kannst du den Eintrag mit dem Stift daneben.');
});

// --- Smaller findings of block B14 (CR-B14-09) ------------------------------

test('"Reload skills" keeps an unsaved untick; a new skill takes its saved state (CR-B14-09, 6)', async (t) => {
  const docx = { name: 'docx', description: 'Word', source: 'user-agents', status: 'active', path: '/s/docx', detail: '', builtin: false };
  let sent = null;
  const { dom } = await mountSettings({
    getSkillCatalog: async () => ({ skills: TWO_SKILLS }),
    reloadSkills: async () => ({ skills: [...TWO_SKILLS, docx] }),
    commitSettings: async (payload) => { sent = payload; return { ok: true }; },
  });
  t.after(dom.cleanup);
  tabFor('skills').click();

  skillBox('xlsx').click();
  assert.equal(skillBox('xlsx').checked, false);
  document.getElementById('btn-reload-skills').click();
  await flush();

  assert.equal(skillBox('xlsx').checked, false, 'the untick was undone');
  assert.equal(skillBox('pdf').checked, true);
  assert.equal(skillBox('docx').checked, true, 'a new skill shows what is saved for it');
  applyButton().click();
  await flush();
  assert.deepEqual(sent.uiPrefs.activeSkills, ['pdf', 'docx']);
});

test('two tool switches in quick succession both land (CR-B14-09, 7)', async (t) => {
  // A store that answers a moment later, like IPC does.
  const store = { baseSystemPrompt: '', appLocale: 'de', disabledTools: ['run_python', 'shell_execute'] };
  const later = (value) => new Promise((resolve) => { setTimeout(() => resolve(structuredClone(value)), 5); });
  const { dom } = await mountSettings({
    getUIPrefs: () => later(store),
    setUIPrefs: async (patch) => { await later(null); Object.assign(store, patch); return structuredClone(store); },
  });
  t.after(dom.cleanup);

  // Switching execution on also clears the tool's old tick-off (#449): two
  // read-modify-writes of the same list, overlapping.
  document.getElementById('input-python-enabled').click();
  document.getElementById('input-shell-enabled').click();
  await new Promise((resolve) => { setTimeout(resolve, 120); });

  assert.deepEqual(store.disabledTools, [], 'one switch undid the other');
});

test('a language change keeps a typed web search key that is not saved yet (CR-B14-09, 8)', async (t) => {
  const { dom } = await mountSettings({
    setUIPrefs: async (patch) => ({ appLocale: 'de', ...patch }),
  });
  t.after(dom.cleanup);
  const key = document.getElementById('input-web-search-key');

  key.value = 'tvly-typed';
  key.dispatchEvent(new Event('input', { bubbles: true }));
  pick('app-locale', 'en');
  await flush();

  assert.equal(key.value, 'tvly-typed');
  assert.equal(document.getElementById('settings-web-search-status').textContent,
    'No key stored — web_search is not offered to the model.');
});

test('an unreadable web search state says so instead of "no key" (CR-B14-09, 8)', async (t) => {
  const { dom } = await mountSettings({
    getWebSearchState: async () => { throw new Error('IPC closed'); },
    setUIPrefs: async (patch) => ({ appLocale: 'de', ...patch }),
  });
  t.after(dom.cleanup);
  const status = document.getElementById('settings-web-search-status');

  assert.equal(status.textContent,
    'Der Stand der Websuche ließ sich nicht lesen — ob ein Schlüssel hinterlegt ist, ist unbekannt.');
  assert.ok(status.classList.contains('error'));
  assert.equal(document.getElementById('btn-web-search-clear').disabled, false, 'a stored key can still be removed');

  // And it stays said in the new language.
  pick('app-locale', 'en');
  await flush();
  assert.equal(status.textContent, 'The web search state could not be read — whether a key is stored is unknown.');
});

test('a double click on a trash icon deletes one row, not two (CR-B14-09, 9)', async (t) => {
  await mountWithRows(t, [storedRow('a', 'A', 'm1'), storedRow('b', 'B', 'm2'), storedRow('c', 'C', 'm3')]);
  const clickTrash = (id, detail) => trashOf(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail }));

  clickTrash('a', 1);
  // The second click of the double click: row b has moved up under the pointer.
  clickTrash('b', 2);

  assert.deepEqual(zeilenTitel(), ['B · m2', 'C · m3']);
  // A keyboard press (detail 0) still deletes.
  clickTrash('b', 0);
  assert.deepEqual(zeilenTitel(), ['C · m3']);
});

test('the model name placeholder comes from the catalogue, in both languages (CR-B14-09, 11)', async (t) => {
  const { dom } = await mountSettings({
    providers: [COMPAT_VIEW],
    setUIPrefs: async (patch) => ({ appLocale: 'de', ...patch }),
  });
  t.after(dom.cleanup);

  await openCompatPopup();
  const input = document.getElementById('input-model');
  assert.equal(input.placeholder, 'Modellname, z. B. qwen2.5-coder-7b');

  pick('app-locale', 'en');
  await flush();
  assert.equal(input.placeholder, 'Model name, e.g. qwen2.5-coder-7b');
});

test('the version label speaks the catalogue and survives a language change (CR-B14-09, 12)', async (t) => {
  const { dom } = await mountSettings({
    getAppVersion: async () => ({ version: '1.13.2' }),
    setUIPrefs: async (patch) => ({ appLocale: 'de', ...patch }),
  });
  t.after(dom.cleanup);
  const label = document.getElementById('settings-version-label');

  assert.equal(label.textContent, 'Version 1.13.2');
  pick('app-locale', 'en');
  await flush();
  assert.equal(label.textContent, 'Version 1.13.2', 'the markup key took the known version away');
});

test('a language change does not fetch a tool catalogue nothing redraws (CR-B14-09, 12)', async (t) => {
  let fetched = 0;
  const { dom, modal } = await mountSettings({
    getToolCatalog: async () => { fetched += 1; return { tools: [] }; },
    setUIPrefs: async (patch) => ({ appLocale: 'de', ...patch }),
  });
  t.after(dom.cleanup);
  const before = fetched;

  pick('app-locale', 'en');
  await flush();

  assert.equal(fetched, before);
  assert.deepEqual(Object.keys(modal).sort(), ['closeSettingsModal', 'openSettingsModal'],
    'nothing unused is handed out');
});
