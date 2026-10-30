const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChatSessionSettings,
  CHAT_ACTIVATION,
} = require('../src/application/chat/chat-session-settings');

/**
 * Modell und Freigabemodus gehören zum Chat (Issue #211). Geprüft wird hier der
 * Dienst dahinter: Was er sich merkt, was er beim Wechsel wieder anwendet — und
 * wo er bewusst *nicht* wiederherstellt.
 */

/** Verlaufsspeicher im Arbeitsspeicher, mit derselben Schnittstelle wie der echte (#985). */
function createFakeChatHistoryStore(sessions = []) {
  const store = { version: 3, activeByWorkspace: {}, sessions: [...sessions] };
  const find = (id) => store.sessions.find((s) => s && s.id === id) || null;
  return {
    store,
    withChatHistoryLock: (fn) => fn(),
    getSessionMeta: async (id) => find(id),
    patchSession: async (id, patch) => {
      const session = find(id);
      if (!session) return false;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete session[key];
        else session[key] = value;
      }
      return true;
    },
  };
}

function setup({
  sessions = [],
  usablePresets = ['preset-a', 'preset-b'],
  defaultPresetId = 'preset-a',
  workspaceMode = null,
  aliases = {},
} = {}) {
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
    getWorkspaceMode: async () => (typeof workspaceMode === 'function' ? workspaceMode() : workspaceMode),
    getPresetAlias: async (presetId) => aliases[presetId] || null,
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
    reasoningEffort: null,
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
  history.patchSession = async () => {
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

// ── Default mode per workspace (#413) ───────────────────────────────────────

test('a new chat starts with the default of its workspace', async () => {
  for (const workspaceMode of ['auto', 'ask-all']) {
    const { settings, applied } = setup({ workspaceMode });
    for (const activation of [CHAT_ACTIVATION.EXPLICIT, CHAT_ACTIVATION.AUTO]) {
      const result = await settings.activate(`chat-new-${activation}`, { activation });
      assert.equal(result.toolPermissionMode, workspaceMode);
    }
    assert.ok(applied.modes.length > 0 && applied.modes.every((mode) => mode === workspaceMode));
  }
});

test('a workspace without a default of its own starts new chats at "smart"', async () => {
  for (const workspaceMode of [null, 'smart', 'nonsense']) {
    const { settings } = setup({ workspaceMode });
    assert.equal((await settings.activate('chat-new')).toolPermissionMode, 'smart');
  }
});

test('a chat restored from "auto" keeps "auto" when that is the workspace default', async () => {
  const { settings } = setup({
    sessions: [{ id: 'chat-auto', toolPermissionMode: 'auto' }],
    workspaceMode: 'auto',
  });
  const result = await settings.activate('chat-auto', { activation: CHAT_ACTIVATION.AUTO });
  assert.equal(result.toolPermissionMode, 'auto');
});

test('a chat restored from "auto" falls back to a stricter workspace default', async () => {
  const { settings } = setup({
    sessions: [{ id: 'chat-auto', toolPermissionMode: 'auto' }],
    workspaceMode: 'ask-all',
  });
  const result = await settings.activate('chat-auto', { activation: CHAT_ACTIVATION.AUTO });
  assert.equal(result.toolPermissionMode, 'ask-all');
});

test('a chat keeps its own mode over the workspace default', async () => {
  const { settings } = setup({
    sessions: [
      { id: 'chat-strict', toolPermissionMode: 'ask-all' },
      { id: 'chat-smart', toolPermissionMode: 'smart' },
    ],
    workspaceMode: 'auto',
  });
  for (const activation of [CHAT_ACTIVATION.EXPLICIT, CHAT_ACTIVATION.AUTO]) {
    assert.equal((await settings.activate('chat-strict', { activation })).toolPermissionMode, 'ask-all');
    assert.equal((await settings.activate('chat-smart', { activation })).toolPermissionMode, 'smart');
  }
});

test('an unreadable workspace default counts as "smart"', async () => {
  const { settings } = setup({
    sessions: [{ id: 'chat-auto', toolPermissionMode: 'auto' }],
    workspaceMode: () => {
      throw new Error('policy file gone');
    },
  });
  assert.equal((await settings.activate('chat-new')).toolPermissionMode, 'smart');
  const restored = await settings.activate('chat-auto', { activation: CHAT_ACTIVATION.AUTO });
  assert.equal(restored.toolPermissionMode, 'smart');
});

test('the workspace default is not written into the chat', async () => {
  // Only an explicit choice belongs to the chat; a chat that merely started
  // with the default follows it when it changes.
  const { settings } = setup({ workspaceMode: 'auto' });
  await settings.activate('chat-new');
  assert.deepEqual(settings.valuesFor('chat-new'), {});
});

// #558: the local copy only holds what changed in this session. It must not
// hide what the chat has stored — above all not a stricter mode.
test('a chat keeps its stored mode after its model changed', async () => {
  for (const workspaceMode of [null, 'auto']) {
    const { settings } = setup({
      sessions: [{ id: 'chat-x', toolPermissionMode: 'ask-all' }, { id: 'chat-y' }],
      workspaceMode,
    });
    await settings.activate('chat-x');
    await settings.rememberPreset('preset-b');
    await settings.activate('chat-y');

    const result = await settings.activate('chat-x');

    assert.equal(result.toolPermissionMode, 'ask-all', `workspace default ${workspaceMode}`);
    assert.equal(result.modelPresetId, 'preset-b');
  }
});

test('a chat keeps its stored model after its mode changed', async () => {
  const { settings } = setup({
    sessions: [{ id: 'chat-x', modelPresetId: 'preset-b' }, { id: 'chat-y' }],
  });
  await settings.activate('chat-x');
  await settings.rememberMode('ask-all');
  await settings.activate('chat-y');

  const result = await settings.activate('chat-x');

  assert.equal(result.modelPresetId, 'preset-b');
  assert.equal(result.toolPermissionMode, 'ask-all');
});

/** A service whose stores hold one mode and one preset, as the real ones do. */
function setupStateful({ sessions, applyPreset }) {
  const history = createFakeChatHistoryStore(sessions);
  const state = { mode: 'smart', preset: 'preset-a' };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
  const settings = createChatSessionSettings({
    chatHistoryStore: history,
    applyPreset: async (presetId) => {
      await tick();
      if (applyPreset) await applyPreset(presetId);
      state.preset = presetId;
    },
    getDefaultPresetId: async () => 'preset-a',
    isPresetUsable: async () => true,
    getActivePresetId: async () => state.preset,
    getActiveMode: async () => {
      await tick();
      return state.mode;
    },
    applyMode: async (mode) => {
      await tick();
      state.mode = mode;
    },
    log: { warn() {} },
  });
  return { settings, state };
}

// #559: the chat on screen runs under its own mode, whatever happened on the way.
test('two overlapping switches end with the second chat\'s mode', async () => {
  const { settings, state } = setupStateful({
    sessions: [{ id: 'chat-p' }, { id: 'chat-x', toolPermissionMode: 'auto' }, { id: 'chat-y' }],
  });
  await settings.activate('chat-p');

  const [, second] = await Promise.all([settings.activate('chat-x'), settings.activate('chat-y')]);

  assert.equal(settings.getCurrentChatId(), 'chat-y');
  assert.equal(second.toolPermissionMode, 'smart');
  assert.equal(state.mode, 'smart');
});

test('a failed model switch still applies the new chat\'s mode', async () => {
  const { settings, state } = setupStateful({
    sessions: [
      { id: 'chat-x', toolPermissionMode: 'auto' },
      { id: 'chat-y', toolPermissionMode: 'ask-all', modelPresetId: 'preset-b' },
    ],
    applyPreset: async (presetId) => {
      if (presetId === 'preset-b') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    },
  });
  await settings.activate('chat-x');
  assert.equal(state.mode, 'auto');

  await assert.rejects(settings.activate('chat-y'), /EPERM/);

  assert.equal(settings.getCurrentChatId(), 'chat-y');
  assert.equal(state.mode, 'ask-all');
  // The queue goes on after a failure.
  const again = await settings.activate('chat-x');
  assert.equal(again.toolPermissionMode, 'auto');
});

// The reasoning level is the chat's third value (#725).

test('a new chat has no level of its own, a stored chat brings its own back (#725)', async () => {
  const { settings } = setup({
    sessions: [{ id: 'chat-alt', modelPresetId: 'preset-b', reasoningEffort: 'high' }],
  });

  assert.equal((await settings.activate('chat-neu')).reasoningEffort, null);
  assert.equal(await settings.reasoningEffortFor(), null);

  assert.equal((await settings.activate('chat-alt')).reasoningEffort, 'high');
  assert.equal(await settings.reasoningEffortFor(), 'high');
  assert.equal(await settings.reasoningEffortFor('chat-alt'), 'high');
});

test('a chosen level is kept for the chat on screen and written into its row (#725)', async () => {
  const { settings, history } = setup({ sessions: [{ id: 'chat-alt', modelPresetId: 'preset-b' }] });
  await settings.activate('chat-alt');

  assert.equal(await settings.rememberReasoningEffort('low'), true);
  assert.equal(await settings.reasoningEffortFor(), 'low');
  assert.equal(history.store.sessions[0].reasoningEffort, 'low');
  assert.equal(settings.valuesFor('chat-alt').reasoningEffort, 'low');
});

test('a level without a chat on screen, or not a level at all, is not kept (#725)', async () => {
  const { settings, history } = setup({ sessions: [{ id: 'chat-alt' }] });
  assert.equal(await settings.rememberReasoningEffort('low'), false);

  await settings.activate('chat-alt');
  for (const bad of ['', 'HIGH', 'low; drop', 42, null]) {
    assert.equal(await settings.rememberReasoningEffort(bad), false, String(bad));
  }
  assert.equal('reasoningEffort' in history.store.sessions[0], false);
});

test('a phone keeps a level for a named chat, never changing the one on screen (#1304)', async () => {
  const { settings, history } = setup({ sessions: [{ id: 'chat-alt' }, { id: 'chat-other' }] });
  await settings.activate('chat-alt');

  assert.equal(await settings.rememberReasoningEffortFor('chat-other', 'high'), true);
  assert.equal(await settings.reasoningEffortFor('chat-other'), 'high');
  assert.equal(history.store.sessions.find((row) => row.id === 'chat-other').reasoningEffort, 'high');
  assert.equal(await settings.reasoningEffortFor(), null);
  assert.equal(settings.getCurrentChatId(), 'chat-alt');

  // A chat not saved yet keeps it for its first save.
  assert.equal(await settings.rememberReasoningEffortFor('chat-new', 'low'), true);
  assert.equal(settings.valuesFor('chat-new').reasoningEffort, 'low');

  assert.equal(await settings.rememberReasoningEffortFor('', 'low'), false);
  assert.equal(await settings.rememberReasoningEffortFor('chat-other', 'HIGH'), false);
});

test('a chat in the background answers with its own level (#725)', async () => {
  const { settings } = setup({
    sessions: [
      { id: 'chat-a', reasoningEffort: 'high' },
      { id: 'chat-b' },
    ],
  });
  await settings.activate('chat-a');
  await settings.activate('chat-b');
  assert.equal(await settings.reasoningEffortFor('chat-a'), 'high');
  assert.equal(await settings.reasoningEffortFor(), null);
});

test('the stored level is read from the history once, not for every round (#725)', async () => {
  const { settings, history } = setup({ sessions: [{ id: 'chat-a', reasoningEffort: 'minimal' }] });
  let reads = 0;
  const read = history.getSessionMeta;
  history.getSessionMeta = async (...args) => {
    reads += 1;
    return read(...args);
  };
  for (let i = 0; i < 3; i += 1) assert.equal(await settings.reasoningEffortFor('chat-a'), 'minimal');
  assert.equal(reads, 1);

  // A chat not saved yet is asked again: its first save may bring a level.
  await settings.reasoningEffortFor('chat-neu');
  await settings.reasoningEffortFor('chat-neu');
  assert.equal(reads, 3);

  settings.forget('chat-a');
  assert.equal(await settings.reasoningEffortFor('chat-a'), 'minimal');
  assert.equal(reads, 4);
});

// A chat from before #726 points at an entry the migration may have merged.
const ALIASES = {
  'preset-alt-hoch': { presetId: 'preset-a', reasoningEffort: 'high' },
  'preset-b': { presetId: 'preset-b', reasoningEffort: 'low' },
};

test('a chat from before #726 is pointed at the surviving entry and given its old level', async () => {
  const { settings, applied, history } = setup({
    sessions: [{ id: 'chat-alt', modelPresetId: 'preset-alt-hoch' }],
    aliases: ALIASES,
  });

  const result = await settings.activate('chat-alt');
  assert.equal(result.modelPresetId, 'preset-a');
  assert.equal(result.reasoningEffort, 'high');
  assert.deepEqual(applied.presets, ['preset-a']);
  assert.equal(history.store.sessions[0].modelPresetId, 'preset-a');
  assert.equal(history.store.sessions[0].reasoningEffort, 'high');
  assert.equal(await settings.reasoningEffortFor(), 'high');
});

test('an entry that stayed brings its old level, a level of the chat\'s own wins (#726)', async () => {
  const { settings, history } = setup({
    sessions: [
      { id: 'chat-b', modelPresetId: 'preset-b' },
      { id: 'chat-eigen', modelPresetId: 'preset-alt-hoch', reasoningEffort: 'minimal' },
    ],
    aliases: ALIASES,
  });

  assert.equal((await settings.activate('chat-b')).reasoningEffort, 'low');
  assert.equal(history.store.sessions[0].reasoningEffort, 'low');

  const own = await settings.activate('chat-eigen');
  assert.equal(own.modelPresetId, 'preset-a');
  assert.equal(own.reasoningEffort, 'minimal');
  assert.equal(history.store.sessions[1].reasoningEffort, 'minimal');
});

test('a chat from before that was not on screen yet still answers with its old level (#726)', async () => {
  const { settings } = setup({
    sessions: [{ id: 'chat-alt', modelPresetId: 'preset-alt-hoch' }],
    aliases: ALIASES,
  });
  assert.equal(await settings.reasoningEffortFor('chat-alt'), 'high');
});

test('a chat without an alias is left alone (#726)', async () => {
  const { settings, history } = setup({
    sessions: [{ id: 'chat-x', modelPresetId: 'preset-a' }],
    aliases: ALIASES,
  });
  const result = await settings.activate('chat-x');
  assert.equal(result.modelPresetId, 'preset-a');
  assert.equal(result.reasoningEffort, null);
  assert.equal('reasoningEffort' in history.store.sessions[0], false);
});

// What a chat switched on a card (#774) is the chat's own: kept in its row,
// read back after a switch, and absent from every other chat.
test('a chat\'s overrides are its own and survive a chat switch (#774)', async () => {
  const { settings, history } = setup({ sessions: [{ id: 'chat-a' }, { id: 'chat-b' }] });
  await settings.activate('chat-a');
  assert.equal(await settings.configOverridesFor('chat-a'), null);

  await settings.acceptConfigProposal('chat-a', { kind: 'tool', name: 'fetch_url', enable: true });
  await settings.declineConfigProposal('chat-a', { kind: 'skill', name: 'release', enable: false });
  const expected = { tools: { on: ['fetch_url'] }, declined: ['skill:off:release'] };
  assert.deepEqual(await settings.configOverridesFor('chat-a'), expected);
  assert.deepEqual(history.store.sessions.find((s) => s.id === 'chat-a').configOverrides, expected);

  // Another chat, and a new one, start without them.
  await settings.activate('chat-b');
  assert.equal(await settings.configOverridesFor('chat-b'), null);
  assert.equal(await settings.configOverridesFor('chat-new'), null);
  // Back on the first chat — and after the service forgot it, from the row.
  await settings.activate('chat-a');
  assert.deepEqual(await settings.configOverridesFor('chat-a'), expected);
  settings.forget('chat-a');
  assert.deepEqual(await settings.configOverridesFor('chat-a'), expected);

  // Switching back drops the entry; the row loses the field.
  await settings.acceptConfigProposal('chat-a', { kind: 'tool', name: 'fetch_url', enable: false });
  assert.deepEqual(await settings.configOverridesFor('chat-a'), { declined: ['skill:off:release'] });
  // Without a chat there is nothing to look up or to keep.
  assert.equal(await settings.configOverridesFor(null), null);
  assert.equal(await settings.acceptConfigProposal('', { kind: 'tool', name: 'x', enable: true }), null);
});

test('a chat not saved yet takes its overrides along on the first save (#774)', async () => {
  const { settings, history } = setup();
  await settings.activate('chat-new');
  await settings.acceptConfigProposal('chat-new', { kind: 'tool', name: 'fetch_url', enable: true });
  assert.equal(history.store.sessions.length, 0);
  assert.deepEqual(settings.valuesFor('chat-new').configOverrides, { tools: { on: ['fetch_url'] } });
});

test('a chat whose "Auto" the store refuses runs at "smart" rather than at the last chat\'s mode (#419)', async () => {
  const history = createFakeChatHistoryStore([{ id: 'chat-auto', toolPermissionMode: 'auto' }]);
  const modes = [];
  const settings = createChatSessionSettings({
    chatHistoryStore: history,
    applyPreset: async () => {},
    getDefaultPresetId: async () => 'preset-a',
    // The store as it answers without encrypted storage: "Auto" is refused.
    applyMode: async (mode) => {
      modes.push(mode);
      return mode === 'auto' ? { ok: false, error: { key: 'permissions.error.autoNeedsEncryption' } } : { ok: true };
    },
    getActiveMode: async () => 'ask-all',
    log: { warn() {} },
  });

  await settings.activate('chat-auto');

  assert.deepEqual(modes, ['auto', 'smart']);
});

test('a refused mode that already is "smart" is not tried twice (#419)', async () => {
  const history = createFakeChatHistoryStore([{ id: 'chat-smart', toolPermissionMode: 'smart' }]);
  const modes = [];
  const settings = createChatSessionSettings({
    chatHistoryStore: history,
    applyPreset: async () => {},
    getDefaultPresetId: async () => 'preset-a',
    applyMode: async (mode) => {
      modes.push(mode);
      return { ok: false };
    },
    getActiveMode: async () => 'ask-all',
    log: { warn() {} },
  });

  await settings.activate('chat-smart');

  assert.deepEqual(modes, ['smart']);
});
