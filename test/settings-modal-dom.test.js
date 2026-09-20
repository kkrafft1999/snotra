// Einstellungsdialog am echten DOM (Issue #78).
//
// test/settings-dialog-markup.test.js prueft die index.html per Regex und kann
// darum nur sehen, dass Tabs und Panels existieren. Hier laeuft der echte
// initSettingsModal gegen dasselbe Markup: ein Klick auf einen Tab muss den
// zugehoerigen Panel zeigen, aria-selected und die Tabreihenfolge nachziehen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

async function mountSettings({ providers, modalDeps, ...overrides } = {}) {
  const dom = setupRendererDom();
  const { initSettingsModal } = await importRenderer('components', 'SettingsModal.js');
  const { appStore } = await importRenderer('state', 'store.js');

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
    labelBase: 'LM Studio \u00b7 qwen2.5',
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

test('der Dialog haengt am Menueeintrag statt an einem Knopf im Chat', async (t) => {
  // Das Zahnrad sass in der Kopfzeile des Chats und war mit dessen Spalte weg.
  // Seitdem fuehrt nur noch "Ansicht > Einstellungen" bzw. Cmd/Ctrl+Komma
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
// Der Umschalter sass bis v1.7.3 als Knopf in der Titelleiste; seitdem steht
// er als Auswahl unter „Allgemein". Geprueft wird der Weg, der dabei neu ist:
// Der offene Dialog zeigt den geltenden Stand, und uebernommen wird er erst
// mit „Uebernehmen" — sonst aenderte ein versehentliches Antippen das Theme
// dauerhaft, waehrend daneben steht, dass nichts ohne „Uebernehmen" gilt.

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

test('der Dialog zeigt das geltende Erscheinungsbild', async (t) => {
  const { mounted } = mountMitTheme({ theme: 'dark' });
  const { dom } = await mounted;
  t.after(dom.cleanup);

  assert.equal(document.getElementById('select-app-theme').value, 'dark');
});

test('das gewaehlte Erscheinungsbild gilt erst mit „Uebernehmen"', async (t) => {
  const { mounted, gesetzt } = mountMitTheme({ theme: 'light' });
  const { dom } = await mounted;
  t.after(dom.cleanup);

  document.getElementById('select-app-theme').value = 'dark';
  await flush();
  assert.deepEqual(gesetzt, [], 'die Auswahl allein darf noch nichts umschalten');

  document.getElementById('btn-settings-save').click();
  await flush();
  assert.deepEqual(gesetzt, ['dark']);
});

test('ein abgebrochener Dialog laesst das Erscheinungsbild in Ruhe', async (t) => {
  const { mounted, gesetzt } = mountMitTheme({ theme: 'light' });
  const { dom, modal } = await mounted;
  t.after(dom.cleanup);

  document.getElementById('select-app-theme').value = 'dark';
  modal.closeSettingsModal();
  await flush();

  assert.deepEqual(gesetzt, []);
});

test('scheitert nur der Modellteil, schaltet das Erscheinungsbild trotzdem um', async (t) => {
  // Wie bei der Sprache (Issue #97): Die UI-Einstellungen sind geschrieben,
  // der Dialog bleibt mit der Meldung offen — dann muss das Fenster auch so
  // aussehen, wie es gerade gespeichert wurde.
  const { mounted, gesetzt } = mountMitTheme({
    theme: 'light',
    commitSettings: async () => ({ ok: false, uiPrefsSaved: true, error: 'Modell kaputt' }),
  });
  const { dom } = await mounted;
  t.after(dom.cleanup);

  document.getElementById('select-app-theme').value = 'dark';
  document.getElementById('btn-settings-save').click();
  await flush();

  assert.deepEqual(gesetzt, ['dark']);
  assert.match(document.getElementById('modal-save-error').textContent, /Modell kaputt/);
});
