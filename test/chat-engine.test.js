const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createChatEngine, CHAT_ENGINE_EVENTS } = require('../src/application/chat/chat-engine');
const { formatToolDisplayLine } = require('../src/shared/presentation/tool-display');
const { TOOL_LINE_PHASES } = require('../src/shared/contracts/enums');
const { sleepAbortable } = require('../src/shared/runtime/abort');

function makeToolPort(execute) {
  const calls = [];
  return {
    calls,
    getTools: () => [{ type: 'function', function: { name: 'list_directory' } }],
    buildSystemPrompt: () => 'Tools: list_directory',
    buildTraceEntry(toolName, args, extra = {}) {
      const entry = { tool: toolName, args, ...extra };
      if (toolName === 'debug_wait') entry.waitMs = 500;
      return entry;
    },
    formatDisplayLine(entry, phase) {
      return formatToolDisplayLine(entry, phase);
    },
    async execute(toolName, args, context) {
      calls.push({ toolName, args, context });
      const output = execute ? await execute(toolName, args, context) : JSON.stringify({ ok: true });
      return { output, progressEvents: [] };
    },
  };
}

function makeWorkspacePaths() {
  return {
    resolveRoot(rawRoot) {
      if (typeof rawRoot !== 'string' || !rawRoot.trim()) return null;
      return path.resolve(rawRoot.trim());
    },
    resolveSelection(root, selectedPath, selectedIsDirectory) {
      if (!root || typeof selectedPath !== 'string' || !selectedPath.trim()) return null;
      const trimmed = selectedPath.trim();
      const absolutePath = path.isAbsolute(trimmed)
        ? path.resolve(trimmed)
        : path.resolve(root, trimmed);
      const relativePath = path.relative(root, absolutePath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
      return { relativePath: relativePath || '.', isDirectory: !!selectedIsDirectory };
    },
    basename: (absPath) => path.basename(absPath),
  };
}

function assistantText(content, extra = {}) {
  return { message: { role: 'assistant', content }, finishReason: 'stop', usage: null, ...extra };
}

function assistantToolCall(id, name, args) {
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
    finishReason: 'tool_calls',
    usage: null,
  };
}

function makeLlmPort(results, {
  resolveResult = { providerId: 'test', model: 'test-model' },
  validateResult = null,
  sendBundle = null,
} = {}) {
  let resultIndex = 0;
  const calls = [];
  const bundleCalls = [];
  const port = {
    calls,
    bundleCalls,
    async resolveChatTarget() {
      if (resolveResult?.error) return resolveResult;
      return typeof resolveResult === 'function' ? resolveResult() : resolveResult;
    },
    async validateTarget() {
      return validateResult;
    },
    async prepareSendBundle(target) {
      bundleCalls.push(target);
      if (sendBundle) return sendBundle;
      return { config: { apiKey: 'test' }, model: target.model || 'test-model' };
    },
    async streamRound(params) {
      calls.push(params);
      const result = typeof results === 'function'
        ? results(params, resultIndex)
        : results[Math.min(resultIndex, results.length - 1)];
      resultIndex += 1;
      return result;
    },
    formatRoundError(err) {
      return err?.message || String(err);
    },
  };
  return port;
}

function makeEngine(results, {
  llm,
  tools,
  preferences,
  workspacePaths,
  skills,
  maxToolRounds = 3,
} = {}) {
  const llmPort = llm || makeLlmPort(results);
  return {
    calls: llmPort.calls,
    tools: tools || makeToolPort(),
    engine: createChatEngine({
      llm: llmPort,
      tools: tools || makeToolPort(),
      preferences: preferences || { async read() { return {}; } },
      workspacePaths: workspacePaths || makeWorkspacePaths(),
      skills: skills || null,
      maxToolRounds,
      clock: () => 1234,
    }),
  };
}

test('engine streams contract events and returns a chat result without Electron', async () => {
  const { engine, calls } = makeEngine([
    assistantText('Hallo!', { usage: { prompt: 10, completion: 2, total: 12 } }),
  ]);
  const events = [];

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.content, 'Hallo!');
  assert.deepEqual(result.usage, { prompt: 10, completion: 2, total: 12 });
  assert.equal(calls.length, 1);
  assert.deepEqual(events.map((event) => event.type), [
    CHAT_ENGINE_EVENTS.PROGRESS,
    CHAT_ENGINE_EVENTS.PROGRESS,
  ]);
  assert.deepEqual(events.map((event) => event.payload.phase), ['waiting', 'idle']);
});

test('engine drops a leading assistant greeting so the provider sees a user-first history', async () => {
  const { engine, calls } = makeEngine([assistantText('Antwort')]);

  await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [
        { role: 'assistant', content: 'Wir sind im Ordner „x". Was möchtest du tun?' },
        { role: 'user', content: 'Liste die Dateien.' },
      ],
    },
  });

  assert.equal(calls[0].messages[0].role, 'user');
  assert.equal(calls[0].messages[0].content, 'Liste die Dateien.');
});

test('engine sends no system message without baseSystemPrompt and without workspace', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')]);

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });

  assert.equal(calls[0].messages.some((m) => m.role === 'system'), false);
});

test('engine describes the open folder and the available tools', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')]);

  await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Hi' }],
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  const system = calls[0].messages.find((m) => m.role === 'system');
  assert.ok(system, 'System-Nachricht mit Workspace-Kontext erwartet');
  assert.match(system.content, /geöffneten Ordner „snotra-project“/);
  assert.match(system.content, /Tools: list_directory/);
  assert.doesNotMatch(system.content, /ausgewählt/);
  // @-Referenzen aus der Chat-Eingabe (#52): Konvention erklären, Inhalt nicht einbetten.
  assert.match(system.content, /„@<Pfad>“/);
  assert.match(system.content, /nicht automatisch mitgeschickt/);
});

test('engine names the selected entry in the system message', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')]);

  await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Was steht da?' }],
      workspaceRoot: '/tmp/snotra-project',
      selectedPath: 'src/app.js',
      selectedIsDirectory: false,
    },
  });

  const system = calls[0].messages.find((m) => m.role === 'system');
  assert.match(system.content, /folgende Datei im Baum ausgewählt: „src\/app\.js“/);

  const { engine: dirEngine, calls: dirCalls } = makeEngine([assistantText('ok')]);
  await dirEngine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Was liegt da?' }],
      workspaceRoot: '/tmp/snotra-project',
      selectedPath: 'src',
      selectedIsDirectory: true,
    },
  });
  assert.match(
    dirCalls[0].messages.find((m) => m.role === 'system').content,
    /folgenden Ordner im Baum ausgewählt: „src“/
  );
});

test('engine keeps baseSystemPrompt in front of the workspace context', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')], {
    preferences: { async read() { return { baseSystemPrompt: 'Sei knapp.' }; } },
  });

  await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Hi' }],
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  const system = calls[0].messages.find((m) => m.role === 'system');
  assert.ok(system.content.startsWith('Sei knapp.\n\n'));
  assert.match(system.content, /geöffneten Ordner „snotra-project“/);
});

test('engine prepends baseSystemPrompt verbatim as the system message', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')], {
    preferences: { async read() { return { baseSystemPrompt: '  Sei knapp.  ' }; } },
  });

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });

  assert.equal(calls[0].messages[0].role, 'system');
  assert.equal(calls[0].messages[0].content, 'Sei knapp.');
});

test('engine validates provider configuration before streaming', async () => {
  const { engine, calls } = makeEngine([assistantText('unused')], {
    llm: makeLlmPort([assistantText('unused')], {
      resolveResult: {
        error: 'Unbekannter Provider: ghost.',
        code: 'INVALID',
      },
    }),
  });

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });

  assert.equal(result.code, 'INVALID');
  assert.match(result.error, /Unbekannter Provider: ghost/);
  assert.equal(calls.length, 0);
});

test('engine rejects a missing required API key without streaming', async () => {
  const { engine, calls } = makeEngine([assistantText('unused')], {
    llm: makeLlmPort([assistantText('unused')], {
      validateResult: {
        error: 'Kein API-Key für Test hinterlegt. Bitte in den Einstellungen speichern.',
        code: 'NO_API_KEY',
      },
    }),
  });

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });

  assert.equal(result.code, 'NO_API_KEY');
  assert.equal(calls.length, 0);
});

test('engine forwards providerOptions without provider-specific branching', async () => {
  const seen = [];
  const llm = makeLlmPort([assistantText('ok')], {
    resolveResult: {
      providerId: 'anthropic',
      model: 'claude-test',
      providerOptions: { reasoningEffort: 'high' },
    },
  });
  llm.streamRound = async (params) => {
    seen.push(params.target);
    return assistantText('ok');
  };

  const { engine } = makeEngine([], { llm });
  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });

  assert.deepEqual(seen[0].providerOptions, { reasoningEffort: 'high' });
  assert.equal(seen[0].providerId, 'anthropic');
});

test('engine reuses per-send bundle across tool rounds', async () => {
  const bundle = { config: { apiKey: 'snap' }, model: 'snap-model' };
  const llm = makeLlmPort([
    assistantToolCall('call_1', 'list_directory', { relative_path: '.' }),
    assistantText('done'),
  ], { sendBundle: bundle });

  const { engine } = makeEngine([], { llm });
  await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Hi' }],
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  assert.equal(llm.bundleCalls.length, 1);
  assert.equal(llm.calls.length, 2);
  assert.equal(llm.calls[0].sendBundle, bundle);
  assert.equal(llm.calls[1].sendBundle, bundle);
});

test('engine runs the tool loop and emits tool events through its event sink', async () => {
  const tools = makeToolPort(() => JSON.stringify({ items: ['README.md'] }));
  const { engine, calls } = makeEngine([
    assistantToolCall('call_1', 'list_directory', { relative_path: '.' }),
    assistantText('Im Ordner liegt README.md.'),
  ], { tools });
  const events = [];

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Was liegt hier?' }],
      workspaceRoot: '/tmp/snotra-project',
    },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.content, 'Im Ordner liegt README.md.');
  assert.equal(tools.calls.length, 1);
  assert.deepEqual(tools.calls[0].args, { relative_path: '.' });
  assert.equal(calls[1].messages.find((message) => message.role === 'tool').tool_call_id, 'call_1');
  const toolEvents = events.filter((event) => event.type === CHAT_ENGINE_EVENTS.TOOL_LINE);
  assert.deepEqual(toolEvents.map((event) => event.payload.phase), ['start', 'done']);
  assert.ok(toolEvents.every((event) => typeof event.payload.line === 'string' && event.payload.line.length > 0));
  assert.equal(
    toolEvents[0].payload.line,
    formatToolDisplayLine(
      { tool: 'list_directory', args: { relative_path: '.' } },
      TOOL_LINE_PHASES.START
    )
  );
});

test('engine supplies a synthetic tool error when no workspace is open', async () => {
  const tools = makeToolPort();
  const { engine, calls } = makeEngine([
    assistantToolCall('call_1', 'list_directory', { relative_path: '.' }),
    assistantText('Kein Arbeitsordner offen.'),
  ], { tools });

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Liste Dateien' }] },
  });

  assert.equal(result.content, 'Kein Arbeitsordner offen.');
  assert.equal(tools.calls.length, 0);
  assert.equal(result.toolTrace[0].noWorkspace, true);
  const toolMessage = calls[1].messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /Kein Arbeitsordner geöffnet/);
});

test('engine preserves debug_wait metadata in its tool trace', async () => {
  const { engine } = makeEngine([
    assistantToolCall('call_1', 'debug_wait', { duration_seconds: 0.1 }),
    assistantText('Fertig.'),
  ]);

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Warte' }],
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  assert.equal(result.content, 'Fertig.');
  assert.equal(result.toolTrace[0].waitMs, 500);
  assert.equal(result.toolTrace[0].line, '0,5 Sekunden gewartet');
});

test('engine stops at its configured tool-round limit', async () => {
  const { engine } = makeEngine(() =>
    assistantToolCall('call_1', 'list_directory', { relative_path: '.' })
  );

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Liste endlos' }],
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  assert.equal(result.code, 'TOOL_LIMIT', result.error);
});

test('engine emits delta and reasoning events from provider callbacks', async () => {
  const llm = makeLlmPort([]);
  llm.streamRound = async ({ callbacks }) => {
    callbacks.onTextDelta('Teil');
    callbacks.onReasoningDelta('Gedanke');
    return assistantText('Teil');
  };
  const { engine } = makeEngine([], { llm });
  const events = [];

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(events.filter((event) => event.type === CHAT_ENGINE_EVENTS.DELTA).map((event) => event.payload), [
    { text: 'Teil' },
  ]);
  assert.deepEqual(events.filter((event) => event.type === CHAT_ENGINE_EVENTS.PROGRESS).map((event) => event.payload), [
    { type: 'phase', phase: 'waiting' },
    { type: 'phase', phase: 'generating' },
    { type: 'reasoning', text: 'Gedanke' },
    { type: 'phase', phase: 'idle' },
  ]);
});

test('engine passes the write preference to its tool registry', async () => {
  const getToolsCalls = [];
  const tools = makeToolPort();
  tools.getTools = (options) => {
    getToolsCalls.push(options);
    return [{ type: 'function', function: { name: options.allowWrite ? 'write_file_text' : 'list_directory' } }];
  };
  const { engine, calls } = makeEngine([assistantText('ok')], {
    tools,
    preferences: { async read() { return { allowWorkspaceWrite: true }; } },
  });

  await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Hi' }],
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  assert.deepEqual(getToolsCalls, [{ allowWrite: true, disabledNames: [] }]);
  assert.equal(calls[0].tools[0].function.name, 'write_file_text');
});

test('engine passes disabled tools to registry and execution context', async () => {
  const getToolsCalls = [];
  const tools = makeToolPort();
  tools.getTools = (options) => {
    getToolsCalls.push(options);
    return [{ type: 'function', function: { name: 'list_directory' } }];
  };
  const { engine } = makeEngine([
    assistantToolCall('call_1', 'list_directory', { relative_path: 'src' }),
    assistantText('fertig'),
  ], {
    tools,
    preferences: {
      async read() {
        return { allowWorkspaceWrite: false, disabledTools: ['debug_wait', 'search_in_files'] };
      },
    },
  });

  await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Liste' }],
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  assert.deepEqual(getToolsCalls, [
    { allowWrite: false, disabledNames: ['debug_wait', 'search_in_files'] },
  ]);
  assert.deepEqual(tools.calls[0].context.disabledNames, ['debug_wait', 'search_in_files']);
});

test('engine preserves start display lines on tool trace when aborted during execution', async () => {
  const tools = makeToolPort(async (_toolName, _args, context) => {
    await sleepAbortable(30_000, context.abortSignal);
    return JSON.stringify({ ok: true });
  });
  const { engine } = makeEngine([
    assistantToolCall('call_1', 'list_directory', { relative_path: 'src' }),
    assistantText('unused'),
  ], { tools });

  const pending = engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Liste' }],
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  engine.abort('renderer-1');

  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.toolTrace.length, 1);
  assert.equal(result.toolTrace[0].tool, 'list_directory');
  assert.equal(result.toolTrace[0].line, 'Ordner src wird durchsucht …');
});

test('engine aborts only the targeted in-flight session', async () => {
  const llm = makeLlmPort([]);
  llm.streamRound = ({ abortSignal }) =>
    new Promise((resolve) => {
      const finish = () => resolve({ cancelled: true, message: { role: 'assistant', content: '' } });
      if (abortSignal.aborted) return finish();
      abortSignal.addEventListener('abort', finish, { once: true });
    });
  const { engine } = makeEngine([], { llm });

  const pending = engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });
  engine.abort('renderer-1');

  const result = await pending;
  assert.equal(result.cancelled, true);
});

test('engine turns provider failures into the existing error DTO', async () => {
  const { engine } = makeEngine([{ error: 'Kontingent erschöpft', code: 'RATE_LIMIT' }]);

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });

  assert.deepEqual(result, {
    error: 'Kontingent erschöpft',
    code: 'RATE_LIMIT',
    usage: null,
  });
});

test('engine emits pending tool lines while the model still streams a tool call', async () => {
  const tools = makeToolPort(() => JSON.stringify({ ok: true }));
  const rounds = [
    assistantToolCall('call_1', 'write_file_text', { relative_path: 'docs/neu.md', content: 'Hallo' }),
    assistantText('Datei geschrieben.'),
  ];
  const { engine } = makeEngine((params, index) => {
    if (index === 0) {
      // Provider meldet den gestreamten Aufruf: erst der Name, dann die Argumente stückweise.
      params.callbacks.onToolCallStart({ index: 0, name: 'write_file_text' });
      params.callbacks.onToolCallArgumentsDelta({ index: 0, delta: '{"relative_path":"docs/' });
      params.callbacks.onToolCallArgumentsDelta({ index: 0, delta: 'neu.md","content":"Hal' });
      params.callbacks.onToolCallArgumentsDelta({ index: 0, delta: 'lo"}' });
    }
    return rounds[Math.min(index, rounds.length - 1)];
  }, { tools });
  const events = [];

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Schreib docs/neu.md' }],
      workspaceRoot: '/tmp/snotra-project',
    },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.content, 'Datei geschrieben.');
  const toolEvents = events
    .filter((event) => event.type === CHAT_ENGINE_EVENTS.TOOL_LINE)
    .map((event) => [event.payload.phase, event.payload.callIndex, event.payload.line]);
  assert.deepEqual(toolEvents, [
    [TOOL_LINE_PHASES.PENDING, 0, 'Datei wird geschrieben …'],
    [TOOL_LINE_PHASES.PENDING, 0, 'Datei docs/neu.md wird geschrieben …'],
    [TOOL_LINE_PHASES.START, 0, 'Datei docs/neu.md wird geschrieben …'],
    [TOOL_LINE_PHASES.DONE, 0, 'Datei docs/neu.md geschrieben'],
  ]);
  // Vorläufige Zeilen landen nicht im Trace, der persistiert wird.
  assert.equal(result.toolTrace.length, 1);
  assert.equal(result.toolTrace[0].line, 'Datei docs/neu.md geschrieben');
  assert.equal(result.toolTrace[0].callIndex, undefined);
});

test('engine pending tool lines: complete arguments, repeated starts and parallel calls', async () => {
  const tools = makeToolPort(() => JSON.stringify({ ok: true }));
  const rounds = [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file_text', arguments: '{"relative_path":"a.js"}' } },
          { id: 'c2', type: 'function', function: { name: 'search_in_files', arguments: '{"query":"TODO"}' } },
        ],
      },
      finishReason: 'tool_calls',
      usage: null,
    },
    assistantText('Fertig.'),
  ];
  const { engine } = makeEngine((params, index) => {
    if (index === 0) {
      // Provider mit kompletten Aufrufen (Google/Ollama): Argumente direkt dabei.
      params.callbacks.onToolCallStart({ index: 0, name: 'read_file_text', args: { relative_path: 'a.js' } });
      params.callbacks.onToolCallStart({ index: 0, name: 'read_file_text', args: { relative_path: 'a.js' } });
      params.callbacks.onToolCallArgumentsDelta({ index: 0, delta: '{"relative_path":"ignoriert"}' });
      params.callbacks.onToolCallStart({ index: 7, name: 'search_in_files' });
      params.callbacks.onToolCallArgumentsDelta({ index: 7, delta: '{"query":"TODO"}' });
    }
    return rounds[Math.min(index, rounds.length - 1)];
  }, { tools });
  const events = [];

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'x' }], workspaceRoot: '/tmp/snotra-project' },
    onEvent: (event) => events.push(event),
  });

  const toolEvents = events
    .filter((event) => event.type === CHAT_ENGINE_EVENTS.TOOL_LINE)
    .map((event) => [event.payload.phase, event.payload.callIndex, event.payload.line]);
  assert.deepEqual(toolEvents, [
    [TOOL_LINE_PHASES.PENDING, 0, 'Datei a.js wird gelesen …'],
    [TOOL_LINE_PHASES.PENDING, 1, 'Dateien werden durchsucht …'],
    [TOOL_LINE_PHASES.PENDING, 1, 'Suche nach „TODO“ …'],
    [TOOL_LINE_PHASES.START, 0, 'Datei a.js wird gelesen …'],
    [TOOL_LINE_PHASES.DONE, 0, 'Datei a.js gelesen'],
    [TOOL_LINE_PHASES.START, 1, 'Suche nach „TODO“ …'],
    [TOOL_LINE_PHASES.DONE, 1, 'Nach „TODO“ gesucht'],
  ]);
});

test('engine resets pending tool calls between rounds', async () => {
  const tools = makeToolPort(() => JSON.stringify({ ok: true }));
  const rounds = [
    assistantToolCall('c1', 'list_directory', { relative_path: 'src' }),
    assistantToolCall('c2', 'list_directory', { relative_path: 'docs' }),
    assistantText('Fertig.'),
  ];
  const { engine } = makeEngine((params, index) => {
    if (index < 2) {
      params.callbacks.onToolCallStart({ index: 0, name: 'list_directory' });
      params.callbacks.onToolCallArgumentsDelta({ index: 0, delta: JSON.stringify({ relative_path: index === 0 ? 'src' : 'docs' }) });
    }
    return rounds[Math.min(index, rounds.length - 1)];
  }, { tools });
  const events = [];

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'x' }], workspaceRoot: '/tmp/snotra-project' },
    onEvent: (event) => events.push(event),
  });

  const pendingLines = events
    .filter((event) => event.type === CHAT_ENGINE_EVENTS.TOOL_LINE && event.payload.phase === TOOL_LINE_PHASES.PENDING)
    .map((event) => [event.payload.callIndex, event.payload.line]);
  // Ohne Reset würde der Aufruf der zweiten Runde als „bereits gemeldet“ verschluckt.
  assert.deepEqual(pendingLines, [
    [0, 'Projektordner wird durchsucht …'],
    [0, 'Ordner src wird durchsucht …'],
    [0, 'Projektordner wird durchsucht …'],
    [0, 'Ordner docs wird durchsucht …'],
  ]);
});

test('engine injects the bodies of active skills into the system message', async () => {
  const skillCalls = [];
  const { engine, calls } = makeEngine([assistantText('ok')], {
    preferences: { async read() { return { activeSkills: ['snotra-capabilities'] }; } },
    skills: {
      async getActiveSkills(options) {
        skillCalls.push(options);
        return [
          {
            name: 'snotra-capabilities',
            description: 'Auskunft über die App',
            source: 'system',
            path: '/app/system-skills/snotra-capabilities',
            body: 'Snotra hat keine Shell.',
          },
        ];
      },
    },
  });

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Was kannst du?' }] },
  });

  assert.deepEqual(skillCalls, [{ workspaceRoot: null, activeSkills: ['snotra-capabilities'] }]);
  const system = calls[0].messages.find((m) => m.role === 'system');
  assert.ok(system, 'Skills gelten auch ohne geöffneten Ordner');
  assert.match(system.content, /## Skill: snotra-capabilities/);
  assert.match(system.content, /Snotra hat keine Shell\./);
});

test('engine orders user prompt, skills and workspace context', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')], {
    preferences: { async read() { return { baseSystemPrompt: 'Sei knapp.' }; } },
    skills: {
      async getActiveSkills() {
        return [{ name: 'demo', description: 'd', source: 'system', path: '/x', body: 'Regel A.' }];
      },
    },
  });

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }], workspaceRoot: '/tmp/snotra-project' },
  });

  const system = calls[0].messages.find((m) => m.role === 'system');
  const promptAt = system.content.indexOf('Sei knapp.');
  const skillAt = system.content.indexOf('## Skill: demo');
  const workspaceAt = system.content.indexOf('geöffneten Ordner');
  assert.ok(promptAt === 0 && promptAt < skillAt && skillAt < workspaceAt, system.content);
});

test('engine keeps answering when the skill port fails', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')], {
    skills: {
      async getActiveSkills() {
        throw new Error('Skill-Verzeichnis kaputt');
      },
    },
  });

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });

  assert.equal(result.content, 'ok');
  assert.equal(calls[0].messages.some((m) => m.role === 'system'), false);
});

test('engine leaves the system message untouched when no skill is active', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')], {
    skills: { async getActiveSkills() { return []; } },
  });

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });

  assert.equal(calls[0].messages.some((m) => m.role === 'system'), false);
});
