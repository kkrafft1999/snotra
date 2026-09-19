const test = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('../src/shared/contracts');
const {
  normalizePresetWire,
  presetIdentityKey,
  normalizeUiPrefs,
  normalizeUiPrefsPatch,
  clampMaxToolRounds,
  clampSidebarWidth,
  formatConnectionDetail,
  formatPresetSublabelFromView,
  createListModelsResult,
  createSettingsOk,
  createSettingsError,
} = contracts;
const openai = require('../src/main/providers/openai');
const ollama = require('../src/main/providers/ollama');

test('settings contract helpers are exported from the aggregate', () => {
  assert.equal(typeof normalizePresetWire, 'function');
  assert.equal(typeof presetIdentityKey, 'function');
  assert.equal(typeof formatConnectionDetail, 'function');
});

test('normalizePresetWire accepts legacy reasoningEffort for OpenAI', () => {
  const preset = normalizePresetWire(
    { id: 'p1', providerId: 'openai', model: 'gpt-4o', reasoningEffort: 'high' },
    (id) => (id === 'openai' ? openai : null)
  );
  assert.deepEqual(preset, {
    id: 'p1',
    providerId: 'openai',
    model: 'gpt-4o',
    menuVisible: true,
    reasoningEffort: 'high',
  });
});

test('normalizePresetWire strips reasoningEffort for providers without preset fields', () => {
  const preset = normalizePresetWire(
    { id: 'p1', providerId: 'anthropic', model: 'claude', reasoningEffort: 'high' },
    (id) => (id === 'anthropic' ? { defaultModel: 'claude', presentation: {} } : null)
  );
  assert.deepEqual(preset, {
    id: 'p1',
    providerId: 'anthropic',
    model: 'claude',
    menuVisible: true,
  });
});

test('presetIdentityKey distinguishes OpenAI presets by reasoning effort', () => {
  const providerView = { presetFields: openai.presentation.presetFields };
  const a = { providerId: 'openai', model: 'gpt-4o', reasoningEffort: 'low' };
  const b = { providerId: 'openai', model: 'gpt-4o', reasoningEffort: 'high' };
  assert.notEqual(presetIdentityKey(a, providerView), presetIdentityKey(b, providerView));
  assert.equal(
    presetIdentityKey(a, providerView),
    presetIdentityKey({ ...a }, openai)
  );
});

test('formatConnectionDetail renders host and TLS state', () => {
  const text = formatConnectionDetail(ollama, {
    baseUrl: 'https://ollama.internal:11434',
    insecureTls: true,
  });
  assert.equal(text, 'Server: ollama.internal:11434 · TLS insecure');
});

test('formatPresetSublabelFromView uses view DTO presetFields and connectionDetail', () => {
  const openaiView = {
    apiBase: 'https://api.openai.com/v1',
    presetFields: [{
      key: 'reasoningEffort',
      detailPrefix: 'reasoning_effort: ',
      detailStyle: 'mono',
    }],
  };
  const sub = formatPresetSublabelFromView(
    { providerId: 'openai', model: 'gpt-4o', reasoningEffort: 'medium' },
    openaiView
  );
  assert.equal(sub.text, 'reasoning_effort: medium');
  assert.equal(sub.style, 'mono');

  const ollamaView = {
    connectionDetail: true,
    baseUrl: 'http://127.0.0.1:11434',
    insecureTls: false,
    apiBase: 'http://localhost:11434',
    presetFields: [],
  };
  const conn = formatPresetSublabelFromView(
    { providerId: 'ollama', model: 'llama3.2' },
    ollamaView,
    { baseUrl: 'https://draft.local', insecureTls: true }
  );
  assert.match(conn.text, /draft\.local/);
  assert.match(conn.text, /TLS insecure/);
});

test('normalizeUiPrefs and patch apply clamps', () => {
  assert.equal(normalizeUiPrefs({ appLocale: 'en' }).appLocale, 'en');
  // Der Schreibschalter ist seit Issue #66 kein UI-Pref mehr: Altwerte werden
  // verworfen, der Berechtigungsmodus lebt in der Policy-Datei.
  assert.equal('allowWorkspaceWrite' in normalizeUiPrefs({ allowWorkspaceWrite: true }), false);
  assert.equal('allowWorkspaceWrite' in normalizeUiPrefsPatch({ allowWorkspaceWrite: true }), false);
  const patch = normalizeUiPrefsPatch({ maxToolRounds: 9999, sidebarWidth: 50 });
  assert.equal(patch.maxToolRounds, 500);
  assert.equal(patch.sidebarWidth, 150);
  assert.equal(clampMaxToolRounds(0), 1);
  assert.equal(clampSidebarWidth(999), 600);
});

test('normalizeUiPrefs and patch sanitize disabledTools', () => {
  assert.deepEqual(normalizeUiPrefs({}).disabledTools, []);
  assert.deepEqual(normalizeUiPrefs({ disabledTools: 'web_search' }).disabledTools, []);
  assert.deepEqual(
    normalizeUiPrefs({ disabledTools: [' web_search ', 'web_search', 42, '', 'edit_file'] }).disabledTools,
    ['web_search', 'edit_file']
  );

  assert.equal('disabledTools' in normalizeUiPrefsPatch({}), false);
  assert.equal('disabledTools' in normalizeUiPrefsPatch({ disabledTools: 'x' }), false);
  assert.deepEqual(normalizeUiPrefsPatch({ disabledTools: [] }).disabledTools, []);
  assert.deepEqual(
    normalizeUiPrefsPatch({ disabledTools: ['read_file_text', null, 'read_file_text'] }).disabledTools,
    ['read_file_text']
  );
});

test('createListModelsResult and settings result DTOs', () => {
  assert.deepEqual(createSettingsOk(), { ok: true });
  assert.deepEqual(createSettingsError('x'), { ok: false, error: 'x' });
  assert.deepEqual(createListModelsResult({ models: [{ id: 'm1' }] }), {
    models: [{ id: 'm1' }],
  });
  assert.deepEqual(createListModelsResult({ error: 'fail' }), { error: 'fail' });
});

// Seitenleiste (Issue #167): sichtbar, solange nichts anderes dasteht — nur ein
// ausdrueckliches false blendet sie aus. Der Patch uebernimmt ausschliesslich
// echte Booleans, damit ein halber Aufruf den gemerkten Zustand nicht kippt.
test('normalizeUiPrefs merkt die ausgeblendete Seitenleiste', () => {
  const { normalizeUiPrefs, normalizeUiPrefsPatch } = require('../src/shared/contracts/settings');

  assert.equal(normalizeUiPrefs({}).sidebarVisible, true);
  assert.equal(normalizeUiPrefs({ sidebarVisible: false }).sidebarVisible, false);
  assert.equal(normalizeUiPrefs({ sidebarVisible: 'nein' }).sidebarVisible, true);

  assert.equal('sidebarVisible' in normalizeUiPrefsPatch({}), false);
  assert.equal('sidebarVisible' in normalizeUiPrefsPatch({ sidebarVisible: 'nein' }), false);
  assert.equal(normalizeUiPrefsPatch({ sidebarVisible: false }).sidebarVisible, false);
  assert.equal(normalizeUiPrefsPatch({ sidebarVisible: true }).sidebarVisible, true);
});

// Python-Ausfuehrung (Issue #86): standardmaessig aus, Pfad bereinigt.
test('normalizeUiPrefs schaltet die Python-Ausführung standardmäßig ab', () => {
  const { normalizeUiPrefs } = require('../src/shared/contracts/settings');

  assert.equal(normalizeUiPrefs({}).pythonExecutionEnabled, false);
  assert.equal(normalizeUiPrefs({ pythonExecutionEnabled: 'ja' }).pythonExecutionEnabled, false);
  assert.equal(normalizeUiPrefs({ pythonExecutionEnabled: true }).pythonExecutionEnabled, true);
  assert.equal('pythonInterpreterPath' in normalizeUiPrefs({}), false);
  assert.equal(
    normalizeUiPrefs({ pythonInterpreterPath: '  /opt/venv/bin/python3  ' }).pythonInterpreterPath,
    '/opt/venv/bin/python3',
  );
});

// Shell-Ausfuehrung (Issue #102): ebenfalls standardmaessig aus.
test('normalizeUiPrefs schaltet die Shell-Ausführung standardmäßig ab', () => {
  const { normalizeUiPrefs, normalizeUiPrefsPatch } = require('../src/shared/contracts/settings');

  assert.equal(normalizeUiPrefs({}).shellExecutionEnabled, false);
  assert.equal(normalizeUiPrefs({ shellExecutionEnabled: 'ja' }).shellExecutionEnabled, false);
  assert.equal(normalizeUiPrefs({ shellExecutionEnabled: true }).shellExecutionEnabled, true);
  assert.equal('shellExecutionEnabled' in normalizeUiPrefsPatch({ shellExecutionEnabled: 'ja' }), false);
  assert.equal(normalizeUiPrefsPatch({ shellExecutionEnabled: true }).shellExecutionEnabled, true);
  assert.equal(normalizeUiPrefsPatch({ shellExecutionEnabled: false }).shellExecutionEnabled, false);
});

// Issue #138: Anders als die Ausfuehrungs-Schalter ist dieser voreingestellt
// an — er gibt nichts frei, er teilt nur mit. Nur ein ausdrueckliches `false`
// schaltet ihn ab, damit alte Einstellungsdateien ihn nicht stumm verlieren.
test('normalizeUiPrefs schickt Umgebungsinformationen standardmäßig mit', () => {
  const { normalizeUiPrefs, normalizeUiPrefsPatch } = require('../src/shared/contracts/settings');

  assert.equal(normalizeUiPrefs({}).environmentInfoEnabled, true);
  assert.equal(normalizeUiPrefs({ environmentInfoEnabled: 'nein' }).environmentInfoEnabled, true);
  assert.equal(normalizeUiPrefs({ environmentInfoEnabled: false }).environmentInfoEnabled, false);
  assert.equal('environmentInfoEnabled' in normalizeUiPrefsPatch({ environmentInfoEnabled: 0 }), false);
  assert.equal(normalizeUiPrefsPatch({ environmentInfoEnabled: false }).environmentInfoEnabled, false);
  assert.equal(normalizeUiPrefsPatch({ environmentInfoEnabled: true }).environmentInfoEnabled, true);
});

test('normalizeUiPrefsPatch räumt den Interpreter-Pfad auf', () => {
  const { normalizeUiPrefsPatch } = require('../src/shared/contracts/settings');

  // Zeilenumbrueche und Steuerzeichen haetten in einem Programmpfad nichts zu
  // suchen und waeren beim Start ein Einfallstor.
  assert.equal(
    normalizeUiPrefsPatch({ pythonInterpreterPath: '/opt/venv/bin/python3\n; rm -rf /' }).pythonInterpreterPath,
    '/opt/venv/bin/python3; rm -rf /',
  );
  assert.equal(normalizeUiPrefsPatch({ pythonInterpreterPath: '' }).pythonInterpreterPath, '');
  assert.equal('pythonInterpreterPath' in normalizeUiPrefsPatch({ pythonInterpreterPath: 42 }), false);
  assert.equal('pythonExecutionEnabled' in normalizeUiPrefsPatch({ pythonExecutionEnabled: 'ja' }), false);
  assert.equal(normalizeUiPrefsPatch({ pythonExecutionEnabled: true }).pythonExecutionEnabled, true);
});

// --- Provider „OpenAI-kompatibel" (Issue #193) ----------------------------

const COMPAT_META = {
  name: 'OpenAI-kompatibel',
  optionalApiKey: true,
  defaultApiStyle: 'chat',
  fields: {
    apiKey: true,
    baseUrl: true,
    insecureTls: true,
    displayName: true,
    apiStyle: true,
    extraHeaders: true,
    supportsImages: true,
    sendTools: true,
  },
};

test('normalizeProviderPatch übernimmt die neuen Verbindungsfelder', () => {
  const { normalizeProviderPatch } = require('../src/shared/contracts/settings');

  assert.deepEqual(
    normalizeProviderPatch(
      {
        baseUrl: ' http://localhost:1234/v1 ',
        displayName: '  LM Studio  ',
        apiStyle: 'full',
        extraHeaders: 'X-Tenant: acme',
        supportsImages: true,
        sendTools: false,
        insecureTls: true,
      },
      COMPAT_META,
    ),
    {
      baseUrl: 'http://localhost:1234/v1',
      insecureTls: true,
      displayName: 'LM Studio',
      apiStyle: 'full',
      extraHeaders: 'X-Tenant: acme',
      supportsImages: true,
      sendTools: false,
    },
  );
});

test('normalizeProviderPatch lässt den leeren Anzeigenamen durch, unbekannte Stile nicht', () => {
  const { normalizeProviderPatch, MAX_DISPLAY_NAME_CHARS } = require('../src/shared/contracts/settings');

  // Leer heißt „löschen" — anders als bei baseUrl ist das eine echte Angabe.
  assert.equal(normalizeProviderPatch({ displayName: '   ' }, COMPAT_META).displayName, '');
  assert.equal(
    normalizeProviderPatch({ displayName: 'x'.repeat(200) }, COMPAT_META).displayName.length,
    MAX_DISPLAY_NAME_CHARS,
  );
  assert.equal('apiStyle' in normalizeProviderPatch({ apiStyle: 'azure' }, COMPAT_META), false);
  assert.equal(normalizeProviderPatch({ removeExtraHeaders: true }, COMPAT_META).removeExtraHeaders, true);
});

test('normalizeProviderPatch ignoriert Felder, die der Anbieter nicht führt', () => {
  const { normalizeProviderPatch } = require('../src/shared/contracts/settings');
  const ollamaLike = { name: 'Ollama', fields: { baseUrl: true } };

  assert.deepEqual(
    normalizeProviderPatch(
      { baseUrl: 'http://127.0.0.1:11434', displayName: 'Nein', apiStyle: 'full', sendTools: false },
      ollamaLike,
    ),
    { baseUrl: 'http://127.0.0.1:11434' },
  );
});
