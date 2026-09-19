const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChatSessionSettings,
  CHAT_ACTIVATION,
} = require('../src/main/services/chat-session-settings');

/**
 * Modell und Freigabemodus gehören zum Chat (Issue #211). Geprüft wird hier der
 * Dienst dahinter: Was er sich merkt, was er beim Wechsel wieder anwendet — und
 * wo er bewusst *nicht* wiederherstellt.
 */

/** Verlaufsspeicher im Arbeitsspeicher, mit derselben Form wie der echte. */
function createFakeChatHistoryStore(sessions = []) {
  const store = { version: 2, activeByWorkspace: {}, sessions: [...sessions] };
  return {
    store,
    withChatHistoryLock: (fn) => fn(),
    readChatHistoryStore: async () => store,
    writeChatHistoryStore: async (next) => {
      store.sessions = next.sessions;
    },
  };
}

function setup({ sessions = [], usablePresets = ['preset-a', 'preset-b'], defaultPresetId = 'preset-a' } = {}) {
  const history = createFakeChatHistoryStore(sessions);
  const applied = { presets: [], modes: [] };
  const settings = createChatSessionSettings({
    chatHistoryStore: history,
    applyPreset: async (presetId) => {
      applied.presets.push(presetId);
    },
    getDefaultPresetId: async () => defaultPresetId,
    isPresetUsable: async (presetId) => usablePresets.includes(presetId),
    applyMode: async (mode) => {
      applied.modes.push(mode);
    },
    log: { warn() {} },
  });
  return { settings, applied, history };
}

test('ein neuer Chat bekommt den Standard-Eintrag und „Intelligent“', async () => {
  const { settings, applied } = setup();

  const result = await settings.activate('chat-neu');

  assert.deepEqual(result, {
    chatId: 'chat-neu',
    modelPresetId: 'preset-a',
    toolPermissionMode: 'smart',
  });
  assert.deepEqual(applied.presets, ['preset-a']);
  assert.deepEqual(applied.modes, ['smart']);
});

test('ein gespeicherter Chat bringt Modell und Modus zurück', async () => {
  const { settings, applied } = setup({
    sessions: [{ id: 'chat-alt', modelPresetId: 'preset-b', toolPermissionMode: 'ask-all' }],
  });

  const result = await settings.activate('chat-alt');

  assert.equal(result.modelPresetId, 'preset-b');
  assert.equal(result.toolPermissionMode, 'ask-all');
  assert.deepEqual(applied.presets, ['preset-b']);
  assert.deepEqual(applied.modes, ['ask-all']);
});

test('„Auto“ kommt beim ausdrücklichen Wechsel zurück', async () => {
  const { settings, applied } = setup({
    sessions: [{ id: 'chat-auto', toolPermissionMode: 'auto' }],
  });

  const result = await settings.activate('chat-auto', { activation: CHAT_ACTIVATION.EXPLICIT });

  assert.equal(result.toolPermissionMode, 'auto');
  assert.deepEqual(applied.modes, ['auto']);
});

test('beim automatischen Wiederherstellen fällt „Auto“ auf „Intelligent“ zurück', async () => {
  const { settings, applied } = setup({
    sessions: [{ id: 'chat-auto', toolPermissionMode: 'auto' }],
  });

  const result = await settings.activate('chat-auto', { activation: CHAT_ACTIVATION.AUTO });

  assert.equal(result.toolPermissionMode, 'smart');
  assert.deepEqual(applied.modes, ['smart']);
});

test('„Immer fragen“ überlebt auch das automatische Wiederherstellen', async () => {
  // Nur die Lockerung wird zurückgenommen, nicht die strengere Wahl.
  const { settings } = setup({
    sessions: [{ id: 'chat-streng', toolPermissionMode: 'ask-all' }],
  });

  const result = await settings.activate('chat-streng', { activation: CHAT_ACTIVATION.AUTO });

  assert.equal(result.toolPermissionMode, 'ask-all');
});

test('ein gelöschter oder unvollständiger Eintrag fällt auf den Standard zurück', async () => {
  const { settings, applied } = setup({
    sessions: [{ id: 'chat-weg', modelPresetId: 'preset-geloescht' }],
    usablePresets: ['preset-a'],
  });

  const result = await settings.activate('chat-weg');

  assert.equal(result.modelPresetId, 'preset-a');
  assert.deepEqual(applied.presets, ['preset-a']);
});

test('ein unbekannter Modus in der Datei wird verworfen, nicht angewandt', async () => {
  const { settings } = setup({
    sessions: [{ id: 'chat-kaputt', toolPermissionMode: 'alles-erlauben' }],
  });

  const result = await settings.activate('chat-kaputt');

  assert.equal(result.toolPermissionMode, 'smart');
});

test('gemerkte Werte landen im Verlauf und gelten beim nächsten Wechsel', async () => {
  const { settings, history } = setup({
    sessions: [{ id: 'chat-a', messages: [] }, { id: 'chat-b', messages: [] }],
  });

  await settings.activate('chat-a');
  await settings.rememberPreset('preset-b');
  await settings.rememberMode('auto');

  const stored = history.store.sessions.find((s) => s.id === 'chat-a');
  assert.equal(stored.modelPresetId, 'preset-b');
  assert.equal(stored.toolPermissionMode, 'auto');

  await settings.activate('chat-b');
  const back = await settings.activate('chat-a');
  assert.equal(back.modelPresetId, 'preset-b');
  assert.equal(back.toolPermissionMode, 'auto');
});

test('ein Chat ohne Zeile im Verlauf merkt sich trotzdem — für das erste Speichern', async () => {
  const { settings } = setup();

  await settings.activate('chat-frisch');
  await settings.rememberMode('ask-all');

  assert.deepEqual(settings.valuesFor('chat-frisch'), { toolPermissionMode: 'ask-all' });
});

test('ohne aktiven Chat wird nichts gemerkt', async () => {
  const { settings } = setup();

  await settings.rememberPreset('preset-b');

  assert.deepEqual(settings.valuesFor('preset-b'), {});
  assert.equal(settings.getCurrentChatId(), null);
});

test('ein gelöschter Chat wird vergessen', async () => {
  const { settings } = setup();

  await settings.activate('chat-weg');
  await settings.rememberMode('auto');
  settings.forget('chat-weg');

  assert.deepEqual(settings.valuesFor('chat-weg'), {});
  assert.equal(settings.getCurrentChatId(), null);
});

test('ein nicht schreibbarer Verlauf bricht den Wechsel nicht ab', async () => {
  const history = createFakeChatHistoryStore([{ id: 'chat-a' }]);
  history.writeChatHistoryStore = async () => {
    throw new Error('Platte voll');
  };
  const warnings = [];
  const settings = createChatSessionSettings({
    chatHistoryStore: history,
    applyPreset: async () => {},
    getDefaultPresetId: async () => 'preset-a',
    isPresetUsable: async () => true,
    applyMode: async () => {},
    log: { warn: (msg) => warnings.push(msg) },
  });

  await settings.activate('chat-a');
  await settings.rememberMode('ask-all');

  assert.equal(warnings.length, 1);
  // Im laufenden Betrieb gilt der Wert trotzdem.
  assert.deepEqual(settings.valuesFor('chat-a'), { toolPermissionMode: 'ask-all' });
});

test('was schon gilt, wird nicht noch einmal gesetzt', async () => {
  // Ein Moduswechsel verwirft offene Freigaben (Konzept §7) — das darf nicht
  // bei jedem Chatwechsel passieren, bei dem der Modus ohnehin stimmt.
  const applied = { presets: [], modes: [] };
  const history = createFakeChatHistoryStore([
    { id: 'chat-a', modelPresetId: 'preset-a', toolPermissionMode: 'smart' },
  ]);
  const settings = createChatSessionSettings({
    chatHistoryStore: history,
    applyPreset: async (presetId) => applied.presets.push(presetId),
    getDefaultPresetId: async () => 'preset-a',
    isPresetUsable: async () => true,
    applyMode: async (mode) => applied.modes.push(mode),
    getActivePresetId: async () => 'preset-a',
    getActiveMode: async () => 'smart',
    log: { warn() {} },
  });

  await settings.activate('chat-a');

  assert.deepEqual(applied, { presets: [], modes: [] });
});
