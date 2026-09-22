const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createChatEngine, CHAT_ENGINE_EVENTS } = require('../src/application/chat/chat-engine');
const { formatToolDisplayLine } = require('../src/shared/presentation/tool-display');
const { TOOL_LINE_PHASES } = require('../src/shared/contracts/enums');
const { sleepAbortable } = require('../src/shared/runtime/abort');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { TOOL_RESULTS_ARE_DATA_RULE } = require('../src/shared/contracts/tool-permissions');

const WRITE_TOOLS = new Set(['write_file_text', 'edit_file', 'apply_patch']);

// Plan-Attrappe (Issue #66): Mindestklasse aus dem Tool-Namen, ein Dateiziel
// aus relative_path. Tests zu Sensitivitaet oder Recovery ueberschreiben `plan`.
function defaultPlan(toolName, args) {
  const riskClasses = [WRITE_TOOLS.has(toolName) ? 'write' : 'read'];
  const targets =
    typeof args?.relative_path === 'string' && args.relative_path
      ? [{ path: args.relative_path, kind: 'file', exists: true, version: 'v1', sensitive: false }]
      : [];
  return { tool: toolName, riskClasses, targets, planKey: JSON.stringify([toolName, args]) };
}

// Freigabe-Attrappe: antwortet fest oder per Callback; ohne UI (null) lehnt die Engine ab.
function makeApprovals(answer = 'allow-once') {
  const requests = [];
  return {
    requests,
    isAvailable: () => true,
    async requestApproval({ request }) {
      requests.push(request);
      const response = typeof answer === 'function' ? await answer(request, requests.length) : answer;
      if (response && typeof response === 'object') return response;
      return { response };
    },
  };
}

function makeToolPort(execute, { toolDefs = [{ name: 'list_directory', requiresWorkspace: true }] } = {}) {
  const calls = [];
  const planCalls = [];
  // Wie die echte Registry (Issue #96): ohne geoeffneten Ordner bleiben nur die
  // Tools ohne Ordnerbezug in Liste und Prompt. Und wie sie seit #195: die
  // Haekchen des Nutzers gelten nicht fuer die Grundausstattung (`essential`).
  const visible = ({ workspaceOpen = true, disabledNames = [] } = {}) =>
    toolDefs.filter(
      (def) =>
        (workspaceOpen !== false || def.requiresWorkspace === false) &&
        (!disabledNames.includes(def.name) || def.essential === true)
    );
  return {
    calls,
    planCalls,
    getTools: (options) =>
      visible(options).map((def) => ({ type: 'function', function: { name: def.name } })),
    buildSystemPrompt: (options) => {
      const names = visible(options).map((def) => def.name);
      return names.length > 0 ? `Tools: ${names.join(', ')}` : '';
    },
    requiresWorkspace: (name) =>
      toolDefs.find((def) => def.name === name)?.requiresWorkspace !== false,
    async plan(toolName, args, context) {
      planCalls.push({ toolName, args, context });
      return defaultPlan(toolName, args);
    },
    buildTraceEntry(toolName, args, extra = {}) {
      const entry = { tool: toolName, args, ...extra };
      // Wie der echte Adapter (#173): `load_skill` merkt sich den Skill-Namen.
      if (toolName === 'load_skill' && typeof args?.name === 'string') entry.skill = args.name;
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
      const relativePosix = relativePath.split(path.sep).join('/');
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
      return { relativePath: relativePosix || '.', isDirectory: !!selectedIsDirectory };
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
      // Wie OpenAI heute: Der Anbieter reicht Bilder weiter (Issue #93).
      return {
        config: { apiKey: 'test' },
        model: target.model || 'test-model',
        providerName: 'Test-Anbieter',
        capabilities: { images: true },
      };
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
  toolPolicy,
  approvals,
  sessionGrants,
  maxToolRounds = 3,
} = {}) {
  const llmPort = llm || makeLlmPort(results);
  const toolPort = tools || makeToolPort();
  return {
    calls: llmPort.calls,
    tools: toolPort,
    engine: createChatEngine({
      llm: llmPort,
      tools: toolPort,
      preferences: preferences || { async read() { return {}; } },
      workspacePaths: workspacePaths || makeWorkspacePaths(),
      skills: skills || null,
      toolPolicy: toolPolicy || null,
      approvals: approvals || null,
      sessionGrants,
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
  assert.deepEqual(result.usage, { prompt: 10, completion: 2, total: 12, cached: 0 });
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

// Issue #96: Eine Internetsuche braucht keinen Projektordner. Tools ohne
// Ordnerbezug werden deshalb auch ohne geoeffneten Ordner angeboten.
const WORKSPACE_FREE_TOOLS = [
  { name: 'list_directory', requiresWorkspace: true },
  { name: 'web_search', requiresWorkspace: false },
];

test('engine bietet Tools ohne Ordnerbezug auch ohne geöffneten Ordner an (#96)', async () => {
  const tools = makeToolPort(undefined, { toolDefs: WORKSPACE_FREE_TOOLS });
  const { engine, calls } = makeEngine([assistantText('ok')], { tools });

  await engine.send({ sessionId: 'renderer-1', payload: { messages: [{ role: 'user', content: 'Hi' }] } });

  assert.deepEqual(calls[0].tools.map((tool) => tool.function.name), ['web_search']);
  const system = calls[0].messages.find((m) => m.role === 'system');
  assert.ok(system, 'ohne Ordner, aber mit Tools gehört ein System-Prompt dazu');
  assert.match(system.content, /No project folder is open/);
  assert.match(system.content, /Tools: web_search/);
  // Der Pfad-Hinweis der Datei-Tools hat hier nichts zu suchen.
  assert.doesNotMatch(system.content, /geöffneten Ordner „/);
});

// Issue #182: Die Engine liest den Rueckgabewert von `buildSystemPrompt()`
// zugleich als „es gibt Tools". Waere der Konventionsblock leer, faellt ueber
// `buildNoWorkspaceSystemPrompt` der ganze Baustein weg — samt der Regel, dass
// Tool-Ergebnisse Daten sind. Deshalb hier gegen die **echte** Registry, nicht
// gegen die Attrappe.
function makeRealRegistryToolPort() {
  const stub = new Proxy({}, { get: () => () => true });
  const registry = createWorkspaceToolRegistry({
    fsService: stub,
    webSearch: stub,
    pythonRunner: stub,
    urlFetch: stub,
    shellRunner: stub,
  });
  const port = makeToolPort(undefined, { toolDefs: WORKSPACE_FREE_TOOLS });
  return { ...port, buildSystemPrompt: (options) => registry.buildSystemPrompt(options) };
}

test('ohne Projektordner bleibt die Regel „Tool-Ergebnisse sind Daten" stehen (#182)', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')], { tools: makeRealRegistryToolPort() });

  await engine.send({ sessionId: 'renderer-1', payload: { messages: [{ role: 'user', content: 'Hi' }] } });

  const system = calls[0].messages.find((m) => m.role === 'system');
  assert.ok(system, 'ohne Ordner, aber mit Tools gehört ein System-Prompt dazu');
  assert.match(system.content, /No project folder is open/);
  assert.ok(
    system.content.includes(TOOL_RESULTS_ARE_DATA_RULE),
    'die Prompt-Injection-Regel darf nicht mit der Tool-Liste weggefallen sein'
  );
});

test('mit Projektordner steht die Regel ebenfalls im System-Prompt (#182)', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')], { tools: makeRealRegistryToolPort() });

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }], workspaceRoot: '/tmp/snotra-project' },
  });

  const system = calls[0].messages.find((m) => m.role === 'system');
  assert.ok(system.content.includes(TOOL_RESULTS_ARE_DATA_RULE));
  // Der Konventionsblock steht darin, die Aufzaehlung der Tool-Namen nicht.
  assert.match(system.content, /relative to the folder root/);
  assert.doesNotMatch(system.content, /Du hast folgende Tools/);
});

test('engine lässt Datei-Tools ohne Ordner unverändert draußen (#96)', async () => {
  const tools = makeToolPort(undefined, { toolDefs: WORKSPACE_FREE_TOOLS });
  const { engine, calls } = makeEngine([
    assistantToolCall('call_1', 'list_directory', { relative_path: 'src' }),
    assistantText('fertig'),
  ], { tools });

  await engine.send({ sessionId: 'renderer-1', payload: { messages: [{ role: 'user', content: 'Liste' }] } });

  assert.equal(tools.calls.length, 0, 'ohne Ordner wird kein Datei-Tool ausgeführt');
  const toolMessage = calls[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /No workspace folder open; list_directory/);
});

test('engine führt ein Tool ohne Ordnerbezug auch ohne Ordner aus (#96)', async () => {
  const tools = makeToolPort(
    async () => JSON.stringify({ count: 0, results: [] }),
    { toolDefs: WORKSPACE_FREE_TOOLS }
  );
  const { engine } = makeEngine([
    assistantToolCall('call_1', 'web_search', { query: 'Snotra AI' }),
    assistantText('fertig'),
  ], { tools });

  await engine.send({ sessionId: 'renderer-1', payload: { messages: [{ role: 'user', content: 'Such mal' }] } });

  assert.equal(tools.calls.length, 1);
  assert.equal(tools.calls[0].toolName, 'web_search');
});

test('engine markiert nur ordnergebundene Tools als „kein Ordner geöffnet" (#96)', async () => {
  const tools = makeToolPort(
    async () => JSON.stringify({ ok: true }),
    { toolDefs: WORKSPACE_FREE_TOOLS }
  );
  const { engine } = makeEngine([
    assistantToolCall('call_1', 'web_search', { query: 'x' }),
    assistantText('fertig'),
  ], { tools });
  const events = [];

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Such mal' }] },
    onEvent: (event) => events.push(event),
  });

  const toolEvents = events.filter((event) => event.type === CHAT_ENGINE_EVENTS.TOOL_LINE);
  assert.deepEqual(toolEvents.map((event) => event.payload.phase), ['start', 'done']);
  for (const event of toolEvents) {
    assert.doesNotMatch(event.payload.line, /kein Ordner geöffnet/);
  }
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
  assert.match(system.content, /open in the app: "snotra-project"/);
  assert.match(system.content, /Tools: list_directory/);
  assert.doesNotMatch(system.content, /ausgewählt/);
  // @-Referenzen aus der Chat-Eingabe (#52): Konvention erklären, Inhalt nicht einbetten.
  assert.match(system.content, /"@<path>"/);
  assert.match(system.content, /not sent along automatically/);
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
  assert.match(system.content, /selected this file in the tree: "src\/app\.js"/);

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
    /selected this folder in the tree: "src"/
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
  assert.match(system.content, /open in the app: "snotra-project"/);
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
  assert.match(toolMessage.content, /No workspace folder open/);
});

// Der Trace traegt mehr als Name und Argumente: was `buildTraceEntry` im
// Adapter ergaenzt, muss bis in die Antwort durchkommen. Traeger ist seit dem
// Wegfall von debug_wait (#197) der Skill-Name von `load_skill`.
test('engine preserves tool-trace metadata from the adapter', async () => {
  const { engine } = makeEngine([
    assistantToolCall('call_1', 'load_skill', { name: 'traffic' }),
    assistantText('Fertig.'),
  ]);

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Lade den Skill' }],
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  assert.equal(result.content, 'Fertig.');
  assert.equal(result.toolTrace[0].skill, 'traffic');
  assert.equal(result.toolTrace[0].line, 'Skill traffic loaded');
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

test('engine zeigt Schreib-Tools unabhaengig vom alten Schreibschalter (Issue #66)', async () => {
  const getToolsCalls = [];
  const tools = makeToolPort();
  tools.getTools = (options) => {
    getToolsCalls.push(options);
    return [{ type: 'function', function: { name: 'write_file_text' } }];
  };
  const { engine, calls } = makeEngine([assistantText('ok')], {
    tools,
    // Altwert aus v1.3.1 hat keine Wirkung mehr.
    preferences: { async read() { return { allowWorkspaceWrite: false }; } },
  });

  await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Hi' }],
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  assert.deepEqual(getToolsCalls, [
    { disabledNames: [], workspaceOpen: true, skillNames: [] },
  ]);
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
        return { allowWorkspaceWrite: false, disabledTools: ['web_search', 'search_in_files'] };
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
    { disabledNames: ['web_search', 'search_in_files'], workspaceOpen: true, skillNames: [] },
  ]);
  assert.deepEqual(tools.calls[0].context.disabledNames, ['web_search', 'search_in_files']);
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
  assert.equal(result.toolTrace[0].line, 'Searching folder src …');
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

test('generateTitle asks the model once, without tools, and cleans up the answer', async () => {
  const { engine, calls } = makeEngine([
    assistantText('"Titel: Lesespalte auf A4 begrenzen."'),
  ]);

  const result = await engine.generateTitle({
    messages: [
      { role: 'assistant', content: 'Hallo!', greeting: true },
      { role: 'user', content: 'Wie begrenze ich die Lesespalte?' },
      { role: 'assistant', content: 'Mit einer max-width auf der Spalte.' },
    ],
  });

  // Anfuehrungszeichen, „Titel:“-Vorsatz und Schlusspunkt sind weg.
  assert.deepEqual(result, { title: 'Lesespalte auf A4 begrenzen' });
  assert.equal(calls.length, 1);
  // Ein einziger Aufruf ohne Tools, nur System-Prompt plus erster Austausch.
  assert.deepEqual(calls[0].tools, []);
  assert.equal(calls[0].messages.length, 2);
  assert.equal(calls[0].messages[0].role, 'system');
  assert.match(calls[0].messages[1].content, /Wie begrenze ich die Lesespalte\?/);
  assert.match(calls[0].messages[1].content, /Mit einer max-width auf der Spalte\./);
  // Der Gruss der Assistentin zaehlt nicht als erste Antwort.
  assert.equal(calls[0].messages[1].content.includes('Hallo!'), false);
});

test('generateTitle works before the first answer and reports failures instead of throwing', async () => {
  const onlyQuestion = makeEngine([assistantText('Offene Frage zum Composer')]);
  const withoutAnswer = await onlyQuestion.engine.generateTitle({
    messages: [{ role: 'user', content: 'Was fehlt noch am Composer?' }],
  });
  assert.deepEqual(withoutAnswer, { title: 'Offene Frage zum Composer' });
  assert.equal(onlyQuestion.calls[0].messages[1].content.includes('Antwort:'), false);

  // Ohne Nutzerfrage gibt es nichts zu benennen — und keinen Modellaufruf.
  const empty = makeEngine([assistantText('egal')]);
  const noQuestion = await empty.engine.generateTitle({ messages: [] });
  assert.equal(noQuestion.title, undefined);
  assert.ok(noQuestion.error);
  assert.equal(empty.calls.length, 0);

  // Provider-Fehler und leere Antworten werden gemeldet, nicht geworfen.
  const failing = makeEngine([{ error: 'Kontingent erschöpft', code: 'RATE_LIMIT' }]);
  const failed = await failing.engine.generateTitle({
    messages: [{ role: 'user', content: 'Frage' }],
  });
  assert.equal(failed.title, undefined);
  assert.equal(failed.error, 'Kontingent erschöpft');

  const blank = makeEngine([assistantText('   ')]);
  const blankResult = await blank.engine.generateTitle({
    messages: [{ role: 'user', content: 'Frage' }],
  });
  assert.equal(blankResult.title, undefined);
  assert.ok(blankResult.error);
});

test('engine turns provider failures into the existing error DTO', async () => {
  const { engine } = makeEngine([{ error: 'Kontingent erschöpft', code: 'RATE_LIMIT' }]);

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });

  const { contextBreakdown, ...dto } = result;
  assert.deepEqual(dto, {
    error: 'Kontingent erschöpft',
    code: 'RATE_LIMIT',
    usage: null,
    contextUsage: null,
  });
  // Auch die gescheiterte Anfrage sagt, woraus sie bestand (Issue #174) —
  // ohne Usage des Anbieters bleibt es bei der Schaetzung.
  assert.equal(contextBreakdown.scaled, false);
  assert.ok(contextBreakdown.parts.length > 0);
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
  }, { tools, approvals: makeApprovals('allow-once') });
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
    [TOOL_LINE_PHASES.PENDING, 0, 'Writing file …'],
    [TOOL_LINE_PHASES.PENDING, 0, 'Writing file docs/neu.md …'],
    [TOOL_LINE_PHASES.START, 0, 'Writing file docs/neu.md …'],
    [TOOL_LINE_PHASES.DONE, 0, 'File docs/neu.md written'],
  ]);
  // Vorläufige Zeilen landen nicht im Trace, der persistiert wird.
  assert.equal(result.toolTrace.length, 1);
  assert.equal(result.toolTrace[0].line, 'File docs/neu.md written');
  assert.equal(result.toolTrace[0].callIndex, undefined);
});

test('engine reports usage as sum of rounds and contextUsage as the last round', async () => {
  const tools = makeToolPort(() => JSON.stringify({ ok: true }));
  const { engine } = makeEngine([
    { ...assistantToolCall('c1', 'read_file_text', { relative_path: 'a.js' }), usage: { prompt: 100, completion: 10, total: 110 } },
    { ...assistantToolCall('c2', 'read_file_text', { relative_path: 'b.js' }), usage: { prompt: 150, completion: 12, total: 162 } },
    assistantText('Fertig.', { usage: { prompt: 210, completion: 20, total: 230 } }),
  ], { tools });

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'x' }], workspaceRoot: '/tmp/snotra-project' },
    onEvent: () => {},
  });

  assert.equal(result.content, 'Fertig.');
  // usage bleibt der Verbrauch des ganzen Zugs (alle drei Runden summiert) …
  assert.deepEqual(result.usage, { prompt: 460, completion: 42, total: 502, cached: 0 });
  // … contextUsage ist nur die letzte Runde: ihr prompt ist das zuletzt
  // gesendete Kontextfenster, nicht die Summe.
  assert.deepEqual(result.contextUsage, { prompt: 210, completion: 20, total: 230, cached: 0 });
});

test('engine keeps the last complete round as contextUsage when the final round has no usage', async () => {
  const tools = makeToolPort(() => JSON.stringify({ ok: true }));
  const { engine } = makeEngine([
    { ...assistantToolCall('c1', 'read_file_text', { relative_path: 'a.js' }), usage: { prompt: 100, completion: 10, total: 110 } },
    assistantText('Fertig.'), // usage: null (Provider ohne Usage-Angabe)
  ], { tools });

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'x' }], workspaceRoot: '/tmp/snotra-project' },
    onEvent: () => {},
  });

  assert.deepEqual(result.contextUsage, { prompt: 100, completion: 10, total: 110, cached: 0 });
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
    [TOOL_LINE_PHASES.PENDING, 0, 'Reading file a.js …'],
    [TOOL_LINE_PHASES.PENDING, 1, 'Searching files …'],
    [TOOL_LINE_PHASES.PENDING, 1, 'Searching for “TODO” …'],
    [TOOL_LINE_PHASES.START, 0, 'Reading file a.js …'],
    [TOOL_LINE_PHASES.DONE, 0, 'File a.js read'],
    [TOOL_LINE_PHASES.START, 1, 'Searching for “TODO” …'],
    [TOOL_LINE_PHASES.DONE, 1, 'Searched for “TODO”'],
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
    [0, 'Searching the project folder …'],
    [0, 'Searching folder src …'],
    [0, 'Searching the project folder …'],
    [0, 'Searching folder docs …'],
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

  assert.deepEqual(skillCalls, [
    { workspaceRoot: null, activeSkills: ['snotra-capabilities'], invokedSkills: [] },
  ]);
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
  const workspaceAt = system.content.indexOf('You are working in the folder currently open in the app');
  assert.ok(promptAt === 0 && promptAt < skillAt && skillAt < workspaceAt, system.content);
});

test('engine reicht die Verzeichnisse eingeschalteter Skills an die Tools weiter', async () => {
  const tools = makeToolPort();
  const { engine } = makeEngine([assistantToolCall('call-1', 'read_file_text', { relative_path: 'skill:demo/x.md' }), assistantText('fertig')], {
    tools,
    skills: {
      async getActiveSkills() {
        return [
          { name: 'demo', description: 'd', source: 'system', path: '/skills/demo', body: 'Regel A.' },
          // Ohne Verzeichnis darf kein Eintrag entstehen.
          { name: 'ohne-pfad', description: 'd', source: 'system', path: '', body: 'Regel B.' },
        ];
      },
    },
  });

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }], workspaceRoot: '/tmp/snotra-project' },
  });

  assert.equal(tools.calls.length, 1);
  assert.deepEqual(tools.calls[0].context.skillRoots, [{ name: 'demo', dir: '/skills/demo' }]);
});

test('engine erklärt Skill-Pfade nur, wenn ein Ordner offen ist', async () => {
  const skills = {
    async getActiveSkills() {
      return [{ name: 'demo', description: 'd', source: 'system', path: '/skills/demo', body: 'Regel A.' }];
    },
  };

  const withFolder = makeEngine([assistantText('ok')], { skills });
  await withFolder.engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }], workspaceRoot: '/tmp/snotra-project' },
  });
  const withFolderSystem = withFolder.calls[0].messages.find((m) => m.role === 'system').content;
  assert.match(withFolderSystem, /skill:demo\/references\/guide\.md/);

  const withoutFolder = makeEngine([assistantText('ok')], { skills });
  await withoutFolder.engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });
  const withoutFolderSystem = withoutFolder.calls[0].messages.find((m) => m.role === 'system').content;
  assert.match(withoutFolderSystem, /## Skill: demo/);
  assert.doesNotMatch(withoutFolderSystem, /skill:demo\//);
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

// Skills auf Abruf (Issue #173): Im Prompt steht nur noch die Kurzliste, den
// Body holt das Modell mit `load_skill`. Der Attrappen-ToolPort oben kennt
// dieses Tool nicht — deshalb reichen die Tests es ausdrücklich herein, wo es
// um das neue Verhalten geht, und lassen es weg, wo der Rückfall zählt.
const LOAD_SKILL_DEFS = [
  { name: 'list_directory', requiresWorkspace: true, essential: true },
  { name: 'load_skill', requiresWorkspace: false, essential: true },
];

function makeSkillPort(skills) {
  return { async getActiveSkills() { return skills; } };
}

test('engine nennt eingeschaltete Skills nur mit Beschreibung und lädt sie auf Abruf (#173)', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')], {
    tools: makeToolPort(undefined, { toolDefs: LOAD_SKILL_DEFS }),
    skills: makeSkillPort([
      {
        name: 'traffic',
        description: 'Traffic-Report für snotra-ai.dev',
        source: 'system',
        path: '/skills/traffic',
        body: 'Rufe gcloud auf und baue den HTML-Report.',
      },
    ]),
  });

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }], workspaceRoot: '/tmp/snotra-project' },
  });

  const system = calls[0].messages.find((m) => m.role === 'system');
  assert.match(system.content, /- traffic: Traffic-Report für snotra-ai\.dev/);
  assert.match(system.content, /load_skill/);
  // Der Body ist der ganze Punkt der Übung: Er darf nicht mehr im Prompt stehen.
  assert.equal(system.content.includes('Rufe gcloud auf'), false);
  assert.equal(system.content.includes('## Skill: traffic'), false);
});

test('engine schreibt per „/name" aufgerufene Skills weiterhin sofort aus (#173)', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')], {
    tools: makeToolPort(undefined, { toolDefs: LOAD_SKILL_DEFS }),
    skills: makeSkillPort([
      {
        name: 'gerufen',
        description: 'Kurzbeschreibung',
        source: 'system',
        path: '/skills/gerufen',
        body: 'Sofort gültige Regel.',
        invoked: true,
      },
      {
        name: 'nur-gelistet',
        description: 'Andere Kurzbeschreibung',
        source: 'system',
        path: '/skills/nur-gelistet',
        body: 'Regel auf Abruf.',
      },
    ]),
  });

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: '/gerufen Los' }] },
  });

  const system = calls[0].messages.find((m) => m.role === 'system');
  assert.match(system.content, /## Skill: gerufen/);
  assert.match(system.content, /Sofort gültige Regel\./);
  // Der nicht gerufene Skill steht daneben nur in der Kurzliste.
  assert.match(system.content, /- nur-gelistet: Andere Kurzbeschreibung/);
  assert.equal(system.content.includes('Regel auf Abruf.'), false);
});

// Der Fehler hinter #195: Wer alle Tools abwaehlte, um Tokens zu sparen, nahm
// `load_skill` mit — und bekam dafür jede Skill-Anleitung in voller Länge in
// jede Anfrage. Aus ein paar hundert gesparten Token wurden mehrere tausend
// zusätzliche. Seit #195 ist `load_skill` Grundausstattung; abgewaehlt bleibt
// es trotzdem verfügbar, und die Skills bleiben auf Abruf.
test('alle Tools abgewählt lässt die Skills auf Abruf, statt sie auszuschreiben (#195)', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')], {
    tools: makeToolPort(undefined, { toolDefs: LOAD_SKILL_DEFS }),
    preferences: {
      async read() {
        return { disabledTools: LOAD_SKILL_DEFS.map((def) => def.name) };
      },
    },
    skills: makeSkillPort([
      { name: 'demo', description: 'd', source: 'system', path: '/skills/demo', body: 'Regel A.' },
    ]),
  });

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });

  const system = calls[0].messages.find((m) => m.role === 'system');
  assert.match(system.content, /- demo: d/);
  assert.match(system.content, /load_skill/);
  assert.equal(system.content.includes('Regel A.'), false);
  assert.equal(system.content.includes('## Skill: demo'), false);
  // Und das Tool geht auch wirklich mit hinaus — sonst wäre die Kurzliste ein
  // Versprechen ohne Einlösung.
  assert.equal(
    calls[0].tools.some((tool) => tool.function.name === 'load_skill'),
    true
  );
});

test('engine fällt auf den vollen Body zurück, wenn es kein load_skill gibt (#173)', async () => {
  const { engine, calls } = makeEngine([assistantText('ok')], {
    // Ein Tool-Port ohne `load_skill`: seit #195 der einzige Weg hierher —
    // etwa ein Skill ohne eigenes Verzeichnis, den das enum nicht trägt.
    tools: makeToolPort(undefined, { toolDefs: [{ name: 'list_directory', requiresWorkspace: true }] }),
    skills: makeSkillPort([
      { name: 'demo', description: 'd', source: 'system', path: '/skills/demo', body: 'Regel A.' },
    ]),
  });

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });

  const system = calls[0].messages.find((m) => m.role === 'system');
  // Ohne Weg zur Anleitung wäre die Kurzliste ein stilles Versprechen.
  assert.match(system.content, /## Skill: demo/);
  assert.match(system.content, /Regel A\./);
  assert.equal(system.content.includes('load_skill'), false);
});

test('engine bietet load_skill nur an, wenn ein Skill eingeschaltet ist (#173)', async () => {
  const getToolsCalls = [];
  const tools = makeToolPort(undefined, { toolDefs: LOAD_SKILL_DEFS });
  const inner = tools.getTools;
  tools.getTools = (options) => {
    getToolsCalls.push(options);
    return inner(options);
  };

  const { engine } = makeEngine([assistantText('ok')], {
    tools,
    skills: makeSkillPort([
      { name: 'demo', description: 'd', source: 'system', path: '/skills/demo', body: 'Regel A.' },
    ]),
  });
  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });
  assert.deepEqual(getToolsCalls.at(-1).skillNames, ['demo']);

  const { engine: leer } = makeEngine([assistantText('ok')], {
    tools,
    skills: makeSkillPort([]),
  });
  await leer.send({
    sessionId: 'renderer-2',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });
  assert.deepEqual(getToolsCalls.at(-1).skillNames, []);
});

// Bild-Anhaenge (Issue #84): Der Payload aus dem Renderer ist ungeprueft, also
// normalisiert die Engine selbst — gueltige Bilder erreichen den Provider,
// Muell nicht.
test('engine reicht normalisierte Bild-Anhaenge an den Provider weiter', async () => {
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const { engine, calls } = makeEngine([assistantText('Sehe ich.')]);

  await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [
        {
          role: 'user',
          content: 'Was ist das?',
          attachments: [
            { kind: 'image', mediaType: 'image/PNG', dataBase64: `data:image/png;base64,${PNG_1PX}` },
            { kind: 'image', mediaType: 'application/pdf', dataBase64: PNG_1PX },
          ],
        },
      ],
    },
    onEvent: () => {},
  });

  const sent = calls[0].messages.find((m) => m.role === 'user');
  assert.equal(sent.content, 'Was ist das?');
  assert.equal(sent.attachments.length, 1);
  assert.equal(sent.attachments[0].mediaType, 'image/png');
  assert.equal(sent.attachments[0].dataBase64, PNG_1PX);
});

// Issue #93: Der Composer laesst Bilder gar nicht erst zu, wenn der Anbieter
// sie nicht weiterreicht. Hier greift der Fall, dass nach dem Anhaengen auf ein
// anderes Modell umgeschaltet wurde — dann lieber eine Meldung als ein Bild,
// das unterwegs verschwindet.
test('engine lehnt Bild-Anhaenge ab, wenn der Anbieter keine Bilder kann', async () => {
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const llm = makeLlmPort([assistantText('unerreichbar')], {
    sendBundle: {
      config: { apiKey: 'test' },
      model: 'text-only',
      providerName: 'MLX-LM (lokal)',
      capabilities: { images: false },
    },
  });
  const { engine, calls } = makeEngine(null, { llm });

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [
        {
          role: 'user',
          content: 'Was ist das?',
          attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: PNG_1PX }],
        },
      ],
    },
    onEvent: () => {},
  });

  assert.match(result.error, /MLX-LM \(lokal\)/);
  assert.equal(result.code, 'INVALID');
  assert.equal(calls.length, 0, 'ohne Bild-Faehigkeit darf kein Request rausgehen');
});

test('engine laesst aeltere Bilder im Verlauf einen Textanbieter nicht blockieren', async () => {
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const llm = makeLlmPort([assistantText('Weiter geht es.')], {
    sendBundle: {
      config: { apiKey: 'test' },
      model: 'text-only',
      providerName: 'MLX-LM (lokal)',
      capabilities: { images: false },
    },
  });
  const { engine, calls } = makeEngine(null, { llm });

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [
        {
          role: 'user',
          content: 'Was ist das?',
          attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: PNG_1PX }],
        },
        { role: 'assistant', content: 'Ein Diagramm.' },
        { role: 'user', content: 'Und was steht da?' },
      ],
    },
    onEvent: () => {},
  });

  assert.equal(result.content, 'Weiter geht es.');
  assert.equal(calls.length, 1);
});

test('engine haengt Nachrichten ohne Bild kein leeres attachments-Feld an', async () => {
  const { engine, calls } = makeEngine([assistantText('Ok')]);

  await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
    onEvent: () => {},
  });

  const sent = calls[0].messages.find((m) => m.role === 'user');
  assert.equal('attachments' in sent, false);
});

test('engine schlüsselt den Prompt nach Skills, Tools und Verlauf auf (#174)', async () => {
  const { engine } = makeEngine(
    [assistantText('ok', { usage: { prompt: 4000, completion: 20, total: 4020 } })],
    {
      tools: makeToolPort(undefined, {
        toolDefs: [
          { name: 'list_directory', requiresWorkspace: true },
          { name: 'mcp__atlassian__jira_get_issue', requiresWorkspace: false },
          { name: 'mcp__atlassian__jira_search', requiresWorkspace: false },
        ],
      }),
      skills: makeSkillPort([
        {
          name: 'grosser-skill',
          description: 'Kurz',
          source: 'system',
          path: '/skills/grosser-skill',
          body: 'A'.repeat(6000),
          invoked: true,
        },
        {
          name: 'kleiner-skill',
          description: 'Auch kurz',
          source: 'system',
          path: '/skills/kleiner-skill',
          body: 'B'.repeat(200),
          invoked: true,
        },
      ]),
      preferences: { async read() { return { baseSystemPrompt: 'Sei knapp.' }; } },
    }
  );

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Hi' }],
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  const breakdown = result.contextBreakdown;
  assert.ok(breakdown, 'Ergebnis traegt eine Aufschlüsselung');
  assert.equal(breakdown.scaled, true);
  assert.equal(breakdown.promptTokens, 4000);
  assert.equal(
    breakdown.parts.reduce((sum, row) => sum + row.tokens, 0),
    4000,
    'die Zeilen gehen exakt auf die echte Zahl auf'
  );

  const byId = new Map(breakdown.parts.map((row) => [row.id, row]));
  // Jeder eingeschaltete Skill bekommt eine eigene Zeile — das ist der Kern
  // des Wunsches, nicht eine Sammelzeile „Skills".
  assert.ok(byId.has('skill:grosser-skill'));
  assert.ok(byId.has('skill:kleiner-skill'));
  assert.equal(byId.get('skill:grosser-skill').skillName, 'grosser-skill');
  assert.ok(
    byId.get('skill:grosser-skill').tokens > byId.get('skill:kleiner-skill').tokens * 5,
    'der grosse Skill kostet sichtbar mehr'
  );
  // Tools getrennt nach eingebaut und je MCP-Server.
  assert.ok(byId.has('tools:builtin'));
  assert.equal(byId.get('tools:mcp:atlassian').count, 2);
  assert.equal(byId.get('system:base').group, 'system');
  assert.equal(byId.get('history:messages').group, 'history');
});

test('engine schaetzt die Aufschlüsselung gegen den Tokenizer des Anbieters (#178)', async () => {
  // Gleiche Bausteine, zwei Anbieter: nur das Gewicht der Tool-Zeile darf sich
  // unterscheiden, die Gesamtzahl nicht.
  async function toolShareFor(providerId) {
    const { engine } = makeEngine(null, {
      llm: makeLlmPort([assistantText('ok', { usage: { prompt: 4000, completion: 20, total: 4020 } })], {
        resolveResult: { providerId, model: 'm' },
      }),
      tools: makeToolPort(undefined, {
        toolDefs: [
          { name: 'list_directory', requiresWorkspace: true, description: 'X'.repeat(4000) },
        ],
      }),
    });
    const result = await engine.send({
      sessionId: 'renderer-1',
      payload: {
        messages: [{ role: 'user', content: 'Y'.repeat(4000) }],
        workspaceRoot: '/tmp/snotra-project',
      },
    });
    assert.equal(result.contextBreakdown.total, 4000);
    return result.contextBreakdown.parts.find((row) => row.id === 'tools:builtin').share;
  }

  const lokal = await toolShareFor('mlx-lm');
  const openai = await toolShareFor('openai');
  assert.ok(
    lokal > openai * 1.4,
    `Tool-Anteil lokal ${lokal} muss deutlich ueber OpenAI ${openai} liegen`
  );
});

test('engine lenkt alle Runden eines Chats auf denselben Prompt-Cache (#179)', async () => {
  const { engine, calls } = makeEngine([
    assistantToolCall('c1', 'read_file_text', { relative_path: 'a.js' }),
    assistantText('Fertig.', {
      usage: { prompt: 10000, completion: 20, total: 10020, cached: 9000 },
    }),
  ], {
    tools: makeToolPort(() => '{}', { toolDefs: [{ name: 'read_file_text', requiresWorkspace: true }] }),
  });

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: {
      chatId: 'chat-42',
      messages: [{ role: 'user', content: 'Lies a.js' }],
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  assert.deepEqual(calls.map((call) => call.cacheKey), ['chat-42', 'chat-42']);
  // Der Cache-Anteil der letzten Runde erreicht die Anzeige.
  assert.equal(result.contextUsage.cached, 9000);
});

test('engine zaehlt Tool-Ergebnisse der letzten Runde in den Verlauf (#174)', async () => {
  const bigOutput = JSON.stringify({ text: 'C'.repeat(5000) });
  const { engine } = makeEngine(
    [
      assistantToolCall('c1', 'read_file_text', { relative_path: 'a.js' }),
      assistantText('Fertig.', { usage: { prompt: 3000, completion: 10, total: 3010 } }),
    ],
    { tools: makeToolPort(() => bigOutput, { toolDefs: [{ name: 'read_file_text', requiresWorkspace: true }] }) }
  );

  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: {
      messages: [{ role: 'user', content: 'Lies a.js' }],
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  const row = result.contextBreakdown.parts.find((p) => p.id === 'history:tool-results');
  assert.ok(row, 'Tool-Ergebnisse stehen als eigene Zeile im Verlauf');
  assert.equal(row.count, 1);
  assert.ok(row.share > 0.5, `Das grosse Ergebnis dominiert den Prompt, war aber ${row.share}`);
});
