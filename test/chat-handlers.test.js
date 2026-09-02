const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { registerChatHandlers, resolveToolRoundLimit } = require('../src/main/ipc/chat-handlers');
const { createChatApplication } = require('../src/main/composition/create-chat-application');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');

test('resolveToolRoundLimit clamps to configured bounds', () => {
  assert.equal(resolveToolRoundLimit({}, 14), 14);
  assert.equal(resolveToolRoundLimit({ maxToolRounds: 0 }, 14), 1);
  assert.equal(resolveToolRoundLimit({ maxToolRounds: 9999 }, 14), 500);
  assert.equal(resolveToolRoundLimit({ maxToolRounds: 42.7 }, 14), 43);
});

// ---------------------------------------------------------------------------
// Integration-Test-Harness fuer registerChatHandlers: baut minimale, aber
// realistische Stubs fuer ipcMain/storage/providers/toolRegistry, damit der
// komplette Tool-Use-Loop (nicht nur einzelne Hilfsfunktionen) abgedeckt ist.
// ---------------------------------------------------------------------------

function makeIpcMain() {
  const handlers = new Map();
  const onHandlers = new Map();
  return {
    handlers,
    onHandlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    on(channel, fn) { onHandlers.set(channel, fn); },
  };
}

function makeFakeEvent(id = 1) {
  const sent = [];
  return {
    sent,
    event: {
      sender: {
        id,
        isDestroyed: () => false,
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    },
  };
}

function makeScriptedProvider(results, { fields = {}, defaultModel = 'test-model' } = {}) {
  const calls = [];
  let i = 0;
  return {
    provider: {
      defaultModel,
      fields,
      async streamChatRound(args) {
        calls.push(args);
        const result = typeof results === 'function' ? results(args, calls.length - 1) : results[Math.min(i, results.length - 1)];
        i += 1;
        return result;
      },
    },
    calls,
  };
}

function makeUiPrefsStore(overrides = {}) {
  return {
    readUIPrefs: async () => ({}),
    ...overrides,
  };
}

function makeLlmConfigStore(overrides = {}) {
  return {
    readLLMConfig: async () => ({}),
    resolveChatModelTarget: () => ({ providerId: 'test' }),
    ...overrides,
  };
}

function makeProviderSecrets(overrides = {}) {
  return {
    getEffectiveProviderConfig: async () => ({ apiKey: 'sk-test' }),
    ...overrides,
  };
}

function makeStorage(overrides = {}) {
  const { readUIPrefs, ...rest } = overrides;
  return {
    ...makeLlmConfigStore(rest),
    ...makeProviderSecrets(rest),
    readUIPrefs: readUIPrefs || (async () => ({})),
  };
}

function makeToolRegistryStub(impl) {
  const calls = [];
  const readTools = [{ type: 'function', function: { name: 'list_directory' } }];
  const writeTools = [{ type: 'function', function: { name: 'write_file_text' } }];
  return {
    calls,
    getTools({ allowWrite } = {}) {
      return allowWrite ? [...readTools, ...writeTools] : readTools;
    },
    buildSystemPrompt({ allowWrite } = {}) {
      const names = this.getTools({ allowWrite }).map((tool) => tool.function.name);
      return `Tools: ${names.join(', ')}`;
    },
    async execute(toolName, args, context) {
      calls.push({ toolName, args, context });
      if (impl) return impl(toolName, args, context);
      return JSON.stringify({ ok: true });
    },
  };
}

function assistantText(content, extra) {
  return { message: { role: 'assistant', content }, finishReason: 'stop', usage: null, ...extra };
}

function assistantToolCall(toolCalls, extra) {
  return {
    message: { role: 'assistant', content: null, tool_calls: toolCalls },
    finishReason: 'tool_calls',
    usage: null,
    ...extra,
  };
}

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function buildTestChatEngine({
  provider,
  storage = makeStorage(),
  toolRegistry = makeToolRegistryStub(),
  maxToolRounds = 5,
  providerRuntime,
} = {}) {
  const runtime = providerRuntime || { getProvider: () => provider };
  const llmConfigStore = makeLlmConfigStore(storage);
  const providerSecrets = makeProviderSecrets(storage);
  const { engine } = createChatApplication({
    llmConfigStore,
    providerRuntime: runtime,
    providerSecrets,
    uiPrefsStore: makeUiPrefsStore({ readUIPrefs: storage.readUIPrefs || (async () => ({})) }),
    toolRegistry,
    path,
    maxToolRounds,
  });
  return engine;
}

function setupChatHandlers({
  provider,
  storage = makeStorage(),
  toolRegistry = makeToolRegistryStub(),
  maxToolRounds = 5,
  providerRuntime,
} = {}) {
  const ipcMain = makeIpcMain();
  const chatEngine = buildTestChatEngine({
    provider,
    storage,
    toolRegistry,
    maxToolRounds,
    providerRuntime,
  });
  registerChatHandlers({
    ipcMain,
    chatEngine,
    REQ,
    PUSH,
  });
  return {
    sendHandler: ipcMain.handlers.get(REQ.CHAT_SEND),
    abortHandler: ipcMain.onHandlers.get(REQ.CHAT_ABORT),
    toolRegistry,
    chatEngine,
  };
}

test('CHAT_SEND rejects an empty messages payload', async () => {
  const { provider } = makeScriptedProvider([assistantText('unused')]);
  const { sendHandler } = setupChatHandlers({ provider });
  const { event } = makeFakeEvent();

  const res = await sendHandler(event, { messages: [] });
  assert.deepEqual(res, { error: 'Keine Nachrichten übergeben.', code: 'INVALID' });
});

test('CHAT_SEND reports an unknown provider without calling streamChatRound', async () => {
  const { provider, calls } = makeScriptedProvider([assistantText('unused')]);
  const storage = makeStorage({ resolveChatModelTarget: () => ({ providerId: 'ghost', model: 'x' }) });
  const ipcMain = makeIpcMain();
  const chatEngine = buildTestChatEngine({
    provider,
    storage,
    toolRegistry: makeToolRegistryStub(),
    providerRuntime: { getProvider: () => null },
  });
  registerChatHandlers({
    ipcMain,
    chatEngine,
    REQ,
    PUSH,
  });
  const { event } = makeFakeEvent();

  const res = await ipcMain.handlers.get(REQ.CHAT_SEND)(event, { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(res.code, 'INVALID');
  assert.match(res.error, /Unbekannter Provider/);
  assert.equal(calls.length, 0);
});

test('CHAT_SEND fails fast when the API key is missing', async () => {
  const { provider, calls } = makeScriptedProvider([assistantText('unused')], { fields: { apiKey: true } });
  const storage = makeStorage({ getEffectiveProviderConfig: async () => ({}) });
  const { sendHandler } = setupChatHandlers({ provider, storage });
  const { event } = makeFakeEvent();

  const res = await sendHandler(event, { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(res.code, 'NO_API_KEY');
  assert.equal(calls.length, 0);
});

test('CHAT_SEND fails fast when a required base URL is missing', async () => {
  const { provider, calls } = makeScriptedProvider([assistantText('unused')], { fields: { baseUrl: true } });
  const storage = makeStorage({ getEffectiveProviderConfig: async () => ({}) });
  const { sendHandler } = setupChatHandlers({ provider, storage });
  const { event } = makeFakeEvent();

  const res = await sendHandler(event, { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(res.code, 'NO_BASE_URL');
  assert.equal(calls.length, 0);
});

test('CHAT_SEND returns the final assistant text when no tools are called', async () => {
  const { provider } = makeScriptedProvider([
    assistantText('Hallo!', { usage: { prompt: 10, completion: 2, total: 12 } }),
  ]);
  const { sendHandler } = setupChatHandlers({ provider });
  const { event } = makeFakeEvent();

  const res = await sendHandler(event, { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(res.content, 'Hallo!');
  assert.deepEqual(res.toolTrace, []);
  assert.deepEqual(res.usage, { prompt: 10, completion: 2, total: 12 });
  assert.equal(res.rawExchanges, undefined, 'CHAT_SEND no longer returns raw exchanges');
});

test('CHAT_SEND runs a full tool round-trip: tool call -> registry -> follow-up answer', async () => {
  const { provider, calls } = makeScriptedProvider([
    assistantToolCall([toolCall('call_1', 'list_directory', { relative_path: '.' })]),
    assistantText('Im Ordner liegen 3 Dateien.'),
  ]);
  const toolRegistry = makeToolRegistryStub((toolName, args) =>
    JSON.stringify({ relative_path: args.relative_path, items: [] })
  );
  const { sendHandler } = setupChatHandlers({ provider, toolRegistry });
  const { event, sent } = makeFakeEvent();

  const res = await sendHandler(event, {
    messages: [{ role: 'user', content: 'Was liegt hier?' }],
    workspaceRoot: '/tmp/snotra-project',
  });

  assert.equal(res.content, 'Im Ordner liegen 3 Dateien.');
  assert.equal(res.toolTrace.length, 1);
  assert.equal(res.toolTrace[0].tool, 'list_directory');

  assert.equal(toolRegistry.calls.length, 1);
  assert.equal(toolRegistry.calls[0].toolName, 'list_directory');
  assert.deepEqual(toolRegistry.calls[0].args, { relative_path: '.' });
  assert.equal(toolRegistry.calls[0].context.workspaceRoot, path.resolve('/tmp/snotra-project'));

  // Zweite Runde muss die Tool-Antwort als 'tool'-Message an den Provider senden.
  const secondRoundMessages = calls[1].messages;
  const toolMsg = secondRoundMessages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'tool response message must be forwarded to the next round');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.deepEqual(JSON.parse(toolMsg.content), { relative_path: '.', items: [] });

  // Start/Done-Ereignisse enthalten Anzeige-Zeilen und Rohdaten.
  const toolLineEvents = sent.filter((s) => s.channel === PUSH.CHAT_TOOL_LINE);
  assert.deepEqual(toolLineEvents.map((e) => e.payload.phase), ['start', 'done']);
  assert.ok(toolLineEvents.every((e) => typeof e.payload.line === 'string' && e.payload.line.length > 0));
  assert.equal(toolLineEvents[0].payload.tool, 'list_directory');
  assert.equal(toolLineEvents[0].payload.line, 'Projektordner wird durchsucht …');
  assert.equal(toolLineEvents[1].payload.line, 'Projektordner durchsucht');
});

test('CHAT_SEND emits a workspace fileWritten progress event after write_file_text', async () => {
  const { provider } = makeScriptedProvider([
    assistantToolCall([toolCall('call_1', 'write_file_text', { relative_path: 'notes/new.md', content: 'hi' })]),
    assistantText('Geschrieben.'),
  ]);
  const toolRegistry = makeToolRegistryStub((toolName) =>
    JSON.stringify(toolName === 'write_file_text' ? { ok: true } : { ok: true })
  );
  const storage = makeStorage({ readUIPrefs: async () => ({ allowWorkspaceWrite: true }) });
  const { sendHandler } = setupChatHandlers({ provider, toolRegistry, storage });
  const { event, sent } = makeFakeEvent();

  const res = await sendHandler(event, {
    messages: [{ role: 'user', content: 'Schreib eine Datei' }],
    workspaceRoot: '/tmp/snotra-project',
  });

  assert.equal(res.content, 'Geschrieben.');
  const workspaceEvents = sent.filter(
    (s) => s.channel === PUSH.CHAT_PROGRESS && s.payload.type === 'workspace'
  );
  assert.equal(workspaceEvents.length, 1);
  assert.deepEqual(workspaceEvents[0].payload, {
    type: 'workspace',
    event: 'fileWritten',
    relativePath: 'notes/new.md',
  });
});

test('CHAT_SEND rejects tool calls with a synthetic error when no workspace is open', async () => {
  const { provider, calls } = makeScriptedProvider([
    assistantToolCall([toolCall('call_1', 'list_directory', { relative_path: '.' })]),
    assistantText('Kein Ordner offen, aber hier ist eine Antwort.'),
  ]);
  const toolRegistry = makeToolRegistryStub();
  const { sendHandler } = setupChatHandlers({ provider, toolRegistry });
  const { event } = makeFakeEvent();

  const res = await sendHandler(event, {
    messages: [{ role: 'user', content: 'ls' }],
    // kein workspaceRoot
  });

  assert.equal(res.content, 'Kein Ordner offen, aber hier ist eine Antwort.');
  assert.equal(toolRegistry.calls.length, 0, 'registry must never be invoked without an open workspace');
  assert.equal(res.toolTrace[0].noWorkspace, true);

  const toolMsg = calls[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /Kein Arbeitsordner geöffnet/);
});

test('CHAT_SEND attaches the clamped debug_wait duration to the tool trace entry', async () => {
  const { provider } = makeScriptedProvider([
    assistantToolCall([toolCall('call_1', 'debug_wait', { duration_seconds: 0.1 })]),
    assistantText('fertig'),
  ]);
  const toolRegistry = makeToolRegistryStub(() => JSON.stringify({ ok: true, waited_ms: 500 }));
  const { sendHandler } = setupChatHandlers({ provider, toolRegistry });
  const { event } = makeFakeEvent();

  const res = await sendHandler(event, {
    messages: [{ role: 'user', content: 'warte kurz' }],
    workspaceRoot: '/tmp/snotra-project',
  });

  // duration_seconds: 0.1 liegt unter dem Minimum (500ms) und wird geclampt.
  assert.equal(res.toolTrace[0].waitMs, 500);
  assert.equal(res.toolTrace[0].line, '0,5 Sekunden gewartet');
});

test('CHAT_SEND stops with TOOL_LIMIT once the configured round limit is exhausted', async () => {
  const { provider } = makeScriptedProvider(() =>
    assistantToolCall([toolCall(`call_${Math.random()}`, 'list_directory', { relative_path: '.' })])
  );
  const { sendHandler } = setupChatHandlers({ provider, maxToolRounds: 2 });
  const { event } = makeFakeEvent();

  const res = await sendHandler(event, {
    messages: [{ role: 'user', content: 'ls endlos' }],
    workspaceRoot: '/tmp/snotra-project',
  });

  assert.equal(res.code, 'TOOL_LIMIT');
  assert.match(res.error, /Zu viele Tool-Runden/);
});

test('CHAT_SEND surfaces a provider error mid-loop and stops further rounds', async () => {
  const { provider, calls } = makeScriptedProvider([
    { error: 'Kontingent erschöpft', code: 'RATE_LIMIT' },
    assistantText('sollte nie erreicht werden'),
  ]);
  const { sendHandler } = setupChatHandlers({ provider });
  const { event } = makeFakeEvent();

  const res = await sendHandler(event, { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(res.error, 'Kontingent erschöpft');
  assert.equal(res.code, 'RATE_LIMIT');
  assert.equal(calls.length, 1, 'the loop must not continue after a provider error');
});

test('CHAT_SEND returns a cancelled result with the partial text when the provider reports cancellation', async () => {
  const { provider } = makeScriptedProvider([
    { cancelled: true, message: { role: 'assistant', content: 'Teilantwort' } },
  ]);
  const { sendHandler } = setupChatHandlers({ provider });
  const { event, sent } = makeFakeEvent();

  const res = await sendHandler(event, { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(res.cancelled, true);
  assert.equal(res.content, 'Teilantwort');
  const phases = sent.filter((s) => s.channel === PUSH.CHAT_PROGRESS).map((s) => s.payload.phase);
  assert.ok(phases.includes('idle'));
});

test('CHAT_ABORT cancels an in-flight CHAT_SEND for the same sender', async () => {
  const provider = {
    defaultModel: 'test-model',
    fields: {},
    streamChatRound: ({ abortSignal }) =>
      new Promise((resolve) => {
        const finish = () => resolve({ cancelled: true, message: { role: 'assistant', content: '' } });
        if (abortSignal.aborted) return finish();
        abortSignal.addEventListener('abort', finish, { once: true });
      }),
  };
  const { sendHandler, abortHandler } = setupChatHandlers({ provider });
  const { event } = makeFakeEvent(7);

  const pending = sendHandler(event, { messages: [{ role: 'user', content: 'Hi' }] });
  abortHandler({ sender: { id: 7 } });
  const res = await pending;

  assert.equal(res.cancelled, true);
});

test('CHAT_SEND omits write_file_text from tools when allowWorkspaceWrite is false', async () => {
  const { provider, calls } = makeScriptedProvider([assistantText('ok')]);
  const storage = makeStorage({ readUIPrefs: async () => ({ allowWorkspaceWrite: false }) });
  const { sendHandler } = setupChatHandlers({
    provider,
    storage,
  });
  const { event } = makeFakeEvent();

  await sendHandler(event, {
    messages: [{ role: 'user', content: 'Hallo' }],
    workspaceRoot: '/tmp/snotra-test-project',
  });

  const tools = calls[0].tools;
  assert.ok(Array.isArray(tools));
  assert.equal(tools.some((t) => t.function.name === 'write_file_text'), false);
  assert.equal(tools.some((t) => t.function.name === 'list_directory'), true);

  // Der Workspace-Kontext nennt nur die freigeschalteten Tools.
  const systemMessage = calls[0].messages[0];
  assert.equal(systemMessage.role, 'system');
  assert.match(systemMessage.content, /list_directory/);
  assert.doesNotMatch(systemMessage.content, /write_file_text/);
});

test('CHAT_SEND includes write_file_text in tools when allowWorkspaceWrite is true', async () => {
  const { provider, calls } = makeScriptedProvider([assistantText('ok')]);
  const storage = makeStorage({ readUIPrefs: async () => ({ allowWorkspaceWrite: true }) });
  const { sendHandler } = setupChatHandlers({
    provider,
    storage,
  });
  const { event } = makeFakeEvent();

  await sendHandler(event, {
    messages: [{ role: 'user', content: 'Hallo' }],
    workspaceRoot: '/tmp/snotra-test-project',
  });

  const tools = calls[0].tools;
  assert.ok(tools.some((t) => t.function.name === 'write_file_text'));

  // Mit Schreibrecht stehen die Schreib-Tools auch im Workspace-Kontext.
  const systemMessage = calls[0].messages[0];
  assert.equal(systemMessage.role, 'system');
  assert.match(systemMessage.content, /write_file_text/);
});

test('CHAT_SEND sends no system prompt without workspace and keeps baseSystemPrompt in front', async () => {
  const empty = makeScriptedProvider([assistantText('ok')]);
  const emptyHandlers = setupChatHandlers({
    provider: empty.provider,
    storage: makeStorage({ readUIPrefs: async () => ({}) }),
  });
  // Ohne geöffneten Ordner und ohne baseSystemPrompt beginnt die Konversation
  // direkt mit der User-Nachricht.
  await emptyHandlers.sendHandler(makeFakeEvent().event, {
    messages: [{ role: 'user', content: 'Hallo' }],
  });
  assert.equal(empty.calls[0].messages.some((m) => m.role === 'system'), false);

  const configured = makeScriptedProvider([assistantText('ok')]);
  const configuredHandlers = setupChatHandlers({
    provider: configured.provider,
    storage: makeStorage({ readUIPrefs: async () => ({ baseSystemPrompt: 'Sei knapp und freundlich.' }) }),
  });
  await configuredHandlers.sendHandler(makeFakeEvent().event, {
    messages: [{ role: 'user', content: 'Hallo' }],
    workspaceRoot: '/tmp/snotra-test-project',
  });
  const systemMessage = configured.calls[0].messages[0];
  assert.equal(systemMessage.role, 'system');
  assert.ok(systemMessage.content.startsWith('Sei knapp und freundlich.\n\n'));
  assert.match(systemMessage.content, /geöffneten Ordner „snotra-test-project“/);
});
