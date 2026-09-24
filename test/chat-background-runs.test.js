const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createChatEngine } = require('../src/application/chat/chat-engine');
const { createSessionGrants } = require('../src/application/permissions/session-grants');
const { createToolApprovalAdapter } = require('../src/main/adapters/tool-approval-adapter');
const { createChatSessionSettings, CHAT_ACTIVATION } = require('../src/main/services/chat-session-settings');
const { createChatApplication } = require('../src/main/composition/create-chat-application');
const { formatToolDisplayLine } = require('../src/shared/presentation/tool-display');

/**
 * Runs per chat (#320). A run belongs to the chat it was started in: another
 * chat taking the screen neither stops it nor lends it its permission mode,
 * and what the user granted it stays with it.
 */

const ROOT = path.resolve('/tmp/snotra-background-runs');

function assistantText(content) {
  return { message: { role: 'assistant', content }, finishReason: 'stop', usage: null };
}

function assistantToolCall(id, name, args) {
  return {
    message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    finishReason: 'tool_calls',
    usage: null,
  };
}

/** A provider whose rounds wait until the test lets them go (or the run is aborted). */
function makeHeldLlm() {
  const held = [];
  return {
    held,
    async resolveChatTarget() { return { providerId: 'test', model: 'm' }; },
    async validateTarget() { return null; },
    async prepareSendBundle(target) { return { config: {}, model: target.model }; },
    streamRound({ abortSignal }) {
      return new Promise((resolve) => {
        const cancel = () => resolve({ cancelled: true, message: { role: 'assistant', content: '' } });
        if (abortSignal.aborted) return cancel();
        abortSignal.addEventListener('abort', cancel, { once: true });
        held.push((content) => resolve(assistantText(content)));
      });
    },
    formatRoundError: (err) => err?.message || String(err),
  };
}

function makeScriptedLlm(results) {
  let index = 0;
  return {
    async resolveChatTarget() { return { providerId: 'test', model: 'm' }; },
    async validateTarget() { return null; },
    async prepareSendBundle(target) { return { config: {}, model: target.model }; },
    async streamRound() {
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return result;
    },
    formatRoundError: (err) => err?.message || String(err),
  };
}

function makeToolPort() {
  const calls = [];
  return {
    calls,
    getTools: () => [{ type: 'function', function: { name: 'edit_file' } }],
    buildSystemPrompt: () => 'Tools: edit_file',
    async plan(toolName, args) {
      const targets = [{ path: args.relative_path, kind: 'file', exists: true, version: 'v1', sensitive: false }];
      return { tool: toolName, riskClasses: ['write'], targets, planKey: JSON.stringify([toolName, args]) };
    },
    buildTraceEntry: (toolName, args, extra = {}) => ({ tool: toolName, args, ...extra }),
    formatDisplayLine: (entry, phase) => formatToolDisplayLine(entry, phase),
    async execute(toolName, args, context) {
      calls.push({ toolName, args, context });
      return { output: JSON.stringify({ ok: true }), progressEvents: [] };
    },
  };
}

function makeWorkspacePaths() {
  return {
    resolveRoot: (raw) => (typeof raw === 'string' && raw.trim() ? path.resolve(raw.trim()) : null),
    resolveSelection: () => null,
    basename: (p) => path.basename(p),
  };
}

function makeEngine({ llm, tools = makeToolPort(), toolPolicy = null, approvals = null, sessionGrants, onRunSettled } = {}) {
  return createChatEngine({
    llm,
    tools,
    preferences: { async read() { return {}; } },
    workspacePaths: makeWorkspacePaths(),
    toolPolicy,
    approvals,
    sessionGrants: sessionGrants || createSessionGrants(),
    maxToolRounds: 4,
    onRunSettled,
  });
}

function send(engine, chatId, { sessionId = 'renderer-1', content = 'go' } = {}) {
  return engine.send({
    sessionId,
    payload: { messages: [{ role: 'user', content }], workspaceRoot: ROOT, chatId },
  });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// --- Engine ------------------------------------------------------------------

test('two chats of one window run side by side; stop only stops its own chat', async () => {
  const llm = makeHeldLlm();
  const settled = [];
  const engine = makeEngine({ llm, onRunSettled: (run) => settled.push(run.chatId) });

  const runA = send(engine, 'chat-a');
  const runB = send(engine, 'chat-b');
  await flush();
  assert.deepEqual([...engine.runningChatIds()].sort(), ['chat-a', 'chat-b']);

  engine.abort('renderer-1', 'chat-a');
  const resultA = await runA;
  assert.equal(resultA.cancelled, true, 'the chat that was stopped');

  llm.held[1]('answer for B');
  const resultB = await runB;
  assert.equal(resultB.cancelled, undefined, 'the other chat was not touched');
  assert.equal(resultB.content, 'answer for B');
  assert.deepEqual(settled, ['chat-a', 'chat-b']);
  assert.equal(engine.runningChatIds().size, 0);
});

test('a new turn in the same chat replaces its run; another window keeps its own', async () => {
  const llm = makeHeldLlm();
  const engine = makeEngine({ llm });

  const first = send(engine, 'chat-a');
  const otherWindow = send(engine, 'chat-a', { sessionId: 'renderer-2' });
  await flush();
  const second = send(engine, 'chat-a');

  assert.equal((await first).cancelled, true);
  await flush();
  llm.held[1]('other window');
  llm.held[2]('second turn');
  assert.equal((await otherWindow).content, 'other window');
  assert.equal((await second).content, 'second turn');
});

test('without a chat, abort stops every run of the window — what closing it means', async () => {
  const llm = makeHeldLlm();
  const engine = makeEngine({ llm });
  const runA = send(engine, 'chat-a');
  const runB = send(engine, 'chat-b');
  await flush();
  engine.abort('renderer-1');
  assert.equal((await runA).cancelled, true);
  assert.equal((await runB).cancelled, true);
});

test('a run reads the permission mode of its own chat', async () => {
  const reads = [];
  const toolPolicy = {
    async read({ chatId } = {}) {
      reads.push(chatId);
      // The chat on screen is in "auto"; the run belongs to a chat in "smart".
      return { mode: chatId === 'chat-a' ? 'smart' : 'auto', rules: [], sensitivePathPatterns: [], policyVersion: '1:ok', rulesVersion: 'r1' };
    },
  };
  const requests = [];
  const approvals = {
    isAvailable: () => true,
    async requestApproval({ request }) {
      requests.push(request);
      return { response: 'allow-once' };
    },
  };
  const tools = makeToolPort();
  const engine = makeEngine({
    llm: makeScriptedLlm([assistantToolCall('c1', 'edit_file', { relative_path: 'a.js' }), assistantText('done')]),
    tools,
    toolPolicy,
    approvals,
  });

  const result = await send(engine, 'chat-a');
  assert.equal(result.content, 'done');
  assert.deepEqual(reads, ['chat-a']);
  assert.equal(requests.length, 1, '"smart" asks before a write, "auto" would not have');
  assert.equal(requests[0].chatId, 'chat-a');
  assert.equal(requests[0].mode, 'smart');
});

test('session approvals are bound to the rules, not to every write of the policy file', async () => {
  let policyVersion = 1;
  const toolPolicy = {
    async read() {
      // Another chat coming on screen writes the file again: the revision moves.
      policyVersion += 1;
      return { mode: 'smart', rules: [], sensitivePathPatterns: [], policyVersion: `${policyVersion}:ok`, rulesVersion: 'same-rules' };
    },
  };
  const requests = [];
  const approvals = {
    isAvailable: () => true,
    async requestApproval({ request }) {
      requests.push(request);
      return { response: 'allow-session' };
    },
  };
  const grants = createSessionGrants();
  const engine = makeEngine({
    llm: makeScriptedLlm([
      assistantToolCall('c1', 'edit_file', { relative_path: 'a.js' }),
      assistantToolCall('c2', 'edit_file', { relative_path: 'a.js' }),
      assistantText('done'),
    ]),
    toolPolicy,
    approvals,
    sessionGrants: grants,
  });

  await send(engine, 'chat-a');
  assert.equal(requests.length, 1, 'the second edit of the same file runs on the session approval');
});

// --- Session approvals -------------------------------------------------------

test('session approvals can be dropped per chat', () => {
  const grants = createSessionGrants();
  const grant = (chatId, scopeKey) =>
    grants.grant({ scopeKey, tool: 'edit_file', targets: [{ path: 'a.js' }], riskClasses: ['write'], chatId });
  grant('chat-a', 'scope-a');
  grant('chat-b', 'scope-b');
  grant('chat-c', 'scope-c');

  grants.clearChat('chat-b');
  assert.equal(grants.count(), 2);
  assert.equal(grants.find({ scopeKey: 'scope-b', tool: 'edit_file', targets: [{ path: 'a.js' }], riskClasses: ['write'] }), null);

  grants.retainChats(new Set(['chat-c']));
  assert.equal(grants.count(), 1);
  assert.ok(grants.find({ scopeKey: 'scope-c', tool: 'edit_file', targets: [{ path: 'a.js' }], riskClasses: ['write'] }));
});

// --- Approval cards ----------------------------------------------------------

function makeApprovalAdapter() {
  let counter = 0;
  const sent = [];
  const adapter = createToolApprovalAdapter({
    randomUUID: () => `req-${++counter}`,
    PUSH: { TOOL_APPROVAL_REQUEST: 'request', TOOL_APPROVAL_RESOLVED: 'resolved' },
    log: { warn() {} },
  });
  adapter.subscribe('renderer-1', { send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false });
  return { adapter, sent };
}

const cardRequest = (chatId) => ({
  tool: 'edit_file',
  riskClasses: ['write'],
  targets: [{ path: 'a.js', kind: 'file', exists: true, sensitive: false }],
  mode: 'smart',
  sessionAllowed: true,
  planKey: `plan-${chatId}`,
  policyVersion: '1:ok',
  chatId,
});

test('a card names its chat, so the renderer can hold it until that chat is open', () => {
  const { adapter, sent } = makeApprovalAdapter();
  void adapter.requestApproval({ sessionId: 'renderer-1', request: cardRequest('chat-a') });
  assert.equal(sent[0].channel, 'request');
  assert.equal(sent[0].payload.chatId, 'chat-a');
});

test('open cards can be discarded per chat and outside a set of chats', async () => {
  const { adapter } = makeApprovalAdapter();
  const a = adapter.requestApproval({ sessionId: 'renderer-1', request: cardRequest('chat-a') });
  const b = adapter.requestApproval({ sessionId: 'renderer-1', request: cardRequest('chat-b') });
  const c = adapter.requestApproval({ sessionId: 'renderer-1', request: cardRequest('chat-c') });

  adapter.invalidateChat('chat-b');
  assert.equal((await b).invalidated, true);
  assert.equal(adapter.pendingCount(), 2);

  // Chat A is on screen, chat C has left it and is idle.
  adapter.invalidateExceptChats(new Set(['chat-a']));
  assert.equal((await c).invalidated, true);
  assert.equal(adapter.pendingCount(), 1, 'the card of the chat on screen stays open');

  adapter.respond('renderer-1', { requestId: 'req-1', response: 'allow-once' });
  assert.equal((await a).response, 'allow-once');
});

// --- Mode per chat -----------------------------------------------------------

function makeSettings({ sessions = [] } = {}) {
  const store = { version: 2, activeByWorkspace: {}, sessions: [...sessions] };
  let activeMode = 'smart';
  const changed = [];
  const activated = [];
  const settings = createChatSessionSettings({
    chatHistoryStore: {
      withChatHistoryLock: (fn) => fn(),
      readChatHistoryStore: async () => store,
      writeChatHistoryStore: async (next) => { store.sessions = next.sessions; },
    },
    applyPreset: async () => {},
    getDefaultPresetId: async () => 'preset-a',
    applyMode: async (mode) => { activeMode = mode; },
    getActiveMode: async () => activeMode,
    onChatModeChanged: (chatId) => changed.push(chatId),
    onActivated: (chatId) => activated.push(chatId),
    log: { warn() {} },
  });
  return { settings, changed, activated, getActiveMode: () => activeMode };
}

test('a chat leaving the screen keeps its mode for its run; the chat on screen reads the store', async () => {
  const { settings, getActiveMode } = makeSettings({
    sessions: [
      { id: 'chat-a', messages: [{ role: 'user', content: 'x' }], toolPermissionMode: 'smart' },
      { id: 'chat-b', messages: [{ role: 'user', content: 'y' }], toolPermissionMode: 'auto' },
    ],
  });

  await settings.activate('chat-a');
  assert.equal(settings.modeFor('chat-a'), null, 'on screen: the store applies');

  await settings.activate('chat-b', { activation: CHAT_ACTIVATION.EXPLICIT });
  assert.equal(getActiveMode(), 'auto', 'the store mirrors the chat on screen');
  assert.equal(settings.modeFor('chat-a'), 'smart', 'chat A keeps "smart" in the background');
  assert.equal(settings.modeFor('chat-b'), null);

  await settings.activate('chat-a');
  assert.equal(settings.modeFor('chat-b'), 'auto');
  assert.equal(settings.modeFor('chat-a'), null);

  settings.forgetBackgroundModes();
  assert.equal(settings.modeFor('chat-b'), null, 'after "reset all" every chat follows the store again');
});

test('switching chats voids nothing by itself; a chat whose own mode changes loses its approvals', async () => {
  const { settings, changed, activated } = makeSettings({
    sessions: [
      { id: 'chat-a', messages: [{ role: 'user', content: 'x' }], toolPermissionMode: 'auto' },
      { id: 'chat-b', messages: [{ role: 'user', content: 'y' }], toolPermissionMode: 'smart' },
    ],
  });

  await settings.activate('chat-a', { activation: CHAT_ACTIVATION.EXPLICIT });
  await settings.activate('chat-b');
  assert.deepEqual(changed, [], 'neither chat changed its own mode');
  assert.deepEqual(activated, ['chat-a', 'chat-b']);

  // Chat A comes back without the user asking (folder switch): "auto" drops to "smart".
  await settings.activate('chat-a', { activation: CHAT_ACTIVATION.AUTO });
  assert.deepEqual(changed, ['chat-a']);
});

// --- Policy port -------------------------------------------------------------

function makePolicyStore(state) {
  return { async read() { return { ...state.current }; } };
}

function buildChatApp({ state, resolveChatMode }) {
  return createChatApplication({
    llmConfigStore: { async readLLMConfig() { return {}; } },
    providerRuntime: {},
    providerSecrets: {},
    uiPrefsStore: { async readUIPrefs() { return {}; } },
    toolRegistry: { getTools: () => [], buildSystemPrompt: () => '' },
    skillsService: null,
    path,
    maxToolRounds: 3,
    toolPolicyStore: makePolicyStore(state),
    resolveChatMode,
  });
}

test('the policy port answers with the mode of the run\'s chat, and falls back on a broken signature', async () => {
  const state = {
    current: { mode: 'smart', rules: [], sensitivePathPatterns: [], policyVersion: '3:ok', integrity: 'ok' },
  };
  const { toolPolicy } = buildChatApp({ state, resolveChatMode: (chatId) => (chatId === 'chat-bg' ? 'auto' : null) });

  assert.equal((await toolPolicy.read({ chatId: 'chat-bg' })).mode, 'auto');
  assert.equal((await toolPolicy.read({ chatId: 'chat-visible' })).mode, 'smart');
  assert.equal((await toolPolicy.read()).mode, 'smart');

  state.current = { ...state.current, mode: 'smart', integrity: 'invalid' };
  assert.equal((await toolPolicy.read({ chatId: 'chat-bg' })).mode, 'smart',
    'a failed signature puts every chat back to the fail-safe');
});

test('the rules version ignores the mode but follows rules, sensitive paths and integrity', async () => {
  const state = {
    current: { mode: 'smart', rules: [], sensitivePathPatterns: ['.env'], policyVersion: '3:ok', integrity: 'ok' },
  };
  const { toolPolicy } = buildChatApp({ state, resolveChatMode: () => null });
  const before = (await toolPolicy.read()).rulesVersion;

  state.current = { ...state.current, mode: 'auto', policyVersion: '4:ok' };
  assert.equal((await toolPolicy.read()).rulesVersion, before, 'a mode write alone');

  state.current = { ...state.current, sensitivePathPatterns: ['.env', '*.pem'], policyVersion: '5:ok' };
  const afterPatterns = (await toolPolicy.read()).rulesVersion;
  assert.notEqual(afterPatterns, before);

  state.current = { ...state.current, integrity: 'invalid' };
  assert.notEqual((await toolPolicy.read()).rulesVersion, afterPatterns);
});
