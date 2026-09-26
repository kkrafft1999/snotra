// IPC der Tool-Berechtigungen (Issue #66, Konzept §5/§8): native Bestätigung
// für Auto, dauerhafte Erlaubnis und Sperre löschen; Verwerfen offener
// Anfragen und Sitzungsfreigaben bei Änderungen; Antwort-Validierung.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { registerToolPermissionHandlers } = require('../src/main/ipc/tool-permission-handlers');
const { createToolPolicyStore } = require('../src/main/services/tool-policy-store');
const { createToolApprovalAdapter } = require('../src/main/adapters/tool-approval-adapter');
const { createSessionGrants } = require('../src/application/permissions/session-grants');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

function makeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf) => buf.toString('utf8').slice(4),
  };
}

function makeSender(id = 1) {
  const sent = [];
  return { id, sent, send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false, once() {} };
}

async function setup(t, {
  dialogResponse = 0,
  workspaceRoot = '/work/projekt',
  chatSessionSettings = null,
  locale = 'de',
  describeExecutionTools = null,
  programAllowances = null,
  openDialogResult = { canceled: true, filePaths: [] },
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-perm-ipc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const toolPolicyStore = createToolPolicyStore({ app: { getPath: () => dir }, safeStorage: makeSafeStorage(), fs, path, crypto, log: { warn() {} } });
  const approvals = createToolApprovalAdapter({ randomUUID: () => crypto.randomUUID(), PUSH, log: { warn() {} } });
  const sessionGrants = createSessionGrants();
  const dialogCalls = [];
  const openDialogCalls = [];
  const dialog = {
    async showMessageBox(_win, options) {
      dialogCalls.push(options || _win);
      return { response: typeof dialogResponse === 'function' ? dialogResponse(options) : dialogResponse };
    },
    async showOpenDialog(_win, options) {
      openDialogCalls.push(options || _win);
      return openDialogResult;
    },
  };
  const ipcMain = createMockIpcMain();
  registerToolPermissionHandlers({
    ipcMain,
    dialog,
    getMainWindow: () => ({ isDestroyed: () => false }),
    toolPolicyStore,
    approvals,
    sessionGrants,
    getActiveWorkspaceRoot: () => workspaceRoot,
    REQ,
    PUSH,
    chatSessionSettings,
    getLocale: () => locale,
    describeExecutionTools,
    programAllowances,
    platform: 'darwin',
    homeDir: '/Users/u',
  });
  // Handler direkt mit einem Event aufrufen, dessen sender das Fenster ist.
  const invoke = (channel, sender, payload) => ipcMain.handlers.get(channel)({ sender }, payload);
  return { toolPolicyStore, approvals, sessionGrants, dialogCalls, openDialogCalls, invoke };
}

test('Auto braucht die native Bestätigung; Abbruch im Dialog ändert nichts', async (t) => {
  const { invoke, dialogCalls, toolPolicyStore } = await setup(t, { dialogResponse: 1 });
  const sender = makeSender();
  const res = await invoke(REQ.TOOL_PERMISSIONS_SET_MODE, sender, 'auto');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'cancelled');
  assert.equal(dialogCalls.length, 1);
  assert.match(dialogCalls[0].message, /Auto \/ Vollzugriff aktivieren\?/);
  assert.deepEqual(dialogCalls[0].buttons, ['Auto aktivieren', 'Abbrechen']);
  assert.equal(dialogCalls[0].cancelId, 1, 'Abbrechen ist Standard');
  assert.equal((await toolPolicyStore.read()).mode, 'smart');
  assert.equal(sender.sent.length, 0);
});

test('Auto mit Bestätigung, ask-all ohne Dialog; Änderung verwirft Karten und Sitzungsfreigaben', async (t) => {
  const { invoke, dialogCalls, approvals, sessionGrants } = await setup(t, { dialogResponse: 0 });
  const sender = makeSender();
  approvals.subscribe(sender.id, sender);
  const pending = approvals.requestApproval({ sessionId: sender.id, request: { tool: 't', riskClasses: ['write'], targets: [], mode: 'smart' } });
  sessionGrants.grant({ scopeKey: 's', tool: 't', targets: [], riskClasses: ['write'] });

  const askAll = await invoke(REQ.TOOL_PERMISSIONS_SET_MODE, sender, 'ask-all');
  assert.equal(askAll.ok, true);
  assert.equal(dialogCalls.length, 0, 'ask-all lockert nichts');
  assert.equal((await pending).invalidated, true, 'offene Karte verworfen');
  assert.equal(sessionGrants.count(), 0, 'Sitzungsfreigaben gelöscht');
  assert.ok(sender.sent.some((s) => s.channel === PUSH.TOOL_PERMISSIONS_CHANGED));

  const auto = await invoke(REQ.TOOL_PERMISSIONS_SET_MODE, sender, 'auto');
  assert.equal(auto.ok, true);
  assert.equal(auto.mode, 'auto');
  assert.equal(dialogCalls.length, 1);

  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_SET_MODE, sender, 'yolo')).ok, false, 'unbekannter Modus');
  const state = await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender);
  assert.equal(state.mode, 'auto');
  assert.equal(state.workspaceRoot, '/work/projekt');
});

test('dauerhafte Allow-Regel braucht den Dialog, Deny-Regel nicht; Workspace-Regeln binden den Main-Root', async (t) => {
  const { invoke, dialogCalls, toolPolicyStore } = await setup(t, { dialogResponse: 0 });
  const sender = makeSender();

  const deny = await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'deny', tool: 'apply_patch', scope: 'workspace', root: '/evil/other' });
  assert.equal(deny.ok, true);
  assert.equal(dialogCalls.length, 0);
  let state = await toolPolicyStore.read();
  assert.deepEqual(Object.keys(state.workspaceRules), ['/work/projekt'], 'Root vom Renderer wird ignoriert');

  const allow = await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'allow', riskClass: 'read', pathPattern: 'docs/**' });
  assert.equal(allow.ok, true);
  assert.equal(dialogCalls.length, 1);
  assert.match(dialogCalls[0].message, /Dauerhafte Erlaubnis anlegen\?/);
  assert.match(dialogCalls[0].detail, /Alle Workspaces/);
  state = await toolPolicyStore.read();
  assert.equal(state.globalRules.length, 1);
  assert.equal(state.globalRules[0].effect, 'allow');

  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'allow', riskClass: 'delete' })).ok, false, 'delete nie dauerhaft');
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, null)).ok, false);
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'deny', tool: 'x', scope: 'workspace', id: 'evil-id' })).ok, true);
  state = await toolPolicyStore.read();
  assert.equal(state.rules.some((r) => r.id === 'evil-id'), false, 'IDs vergibt der Main');
});

test('Allow-Regel abgelehnt im Dialog wird nicht angelegt', async (t) => {
  const { invoke, toolPolicyStore } = await setup(t, { dialogResponse: 1 });
  const res = await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, makeSender(), { effect: 'allow', riskClass: 'write' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'cancelled');
  assert.deepEqual((await toolPolicyStore.read()).rules, []);
});

test('Sperre löschen braucht den Dialog, Erlaubnis löschen nicht', async (t) => {
  const { invoke, dialogCalls, toolPolicyStore } = await setup(t, { dialogResponse: (options) => (/Sperre löschen/.test(options.message) ? 1 : 0) });
  const sender = makeSender();
  await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'deny', tool: 'edit_file' });
  await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'allow', riskClass: 'read' });
  const state = await toolPolicyStore.read();
  const denyRule = state.rules.find((r) => r.effect === 'deny');
  const allowRule = state.rules.find((r) => r.effect === 'allow');

  const removeDeny = await invoke(REQ.TOOL_PERMISSIONS_REMOVE_RULE, sender, denyRule.id);
  assert.equal(removeDeny.ok, false, 'im Dialog abgebrochen');
  assert.ok(dialogCalls.some((d) => /Sperre löschen\?/.test(d.message)));
  assert.equal((await toolPolicyStore.read()).rules.length, 2);

  const removeAllow = await invoke(REQ.TOOL_PERMISSIONS_REMOVE_RULE, sender, allowRule.id);
  assert.equal(removeAllow.ok, true);
  assert.equal((await toolPolicyStore.read()).rules.length, 1);
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_REMOVE_RULE, sender, 'nope')).ok, false);
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_REMOVE_RULE, sender, '')).ok, false);
});

test('the native dialogs speak the interface language and name the page the rules live on (#353)', async (t) => {
  const { invoke, dialogCalls } = await setup(t, { dialogResponse: 0, locale: 'en' });
  const sender = makeSender();

  await invoke(REQ.TOOL_PERMISSIONS_SET_MODE, sender, 'auto');
  assert.equal(dialogCalls[0].message, 'Switch on Auto (full access)?');
  assert.deepEqual(dialogCalls[0].buttons, ['Switch on Auto', 'Cancel']);

  await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'allow', tool: 'edit_file', scope: 'workspace', pathPattern: 'docs/**' });
  assert.equal(dialogCalls[1].message, 'Create a permanent allowance?');
  assert.equal(
    dialogCalls[1].detail,
    'From now on, the tool edit_file may access “docs/**” without asking (workspace /work/projekt). '
      + 'The rule applies in “Smart” mode until you delete it under Settings › Permissions.',
  );

  await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'deny', riskClass: 'write', pathPattern: '*.md' });
  const deny = (await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender)).globalRules.find((r) => r.effect === 'deny');
  await invoke(REQ.TOOL_PERMISSIONS_REMOVE_RULE, sender, deny.id);
  assert.equal(dialogCalls[2].message, 'Delete block?');
  assert.equal(dialogCalls[2].detail, 'The block on the risk class write for “*.md” is removed. After that, the mode decides again.');
  assert.deepEqual(dialogCalls[2].buttons, ['Delete block', 'Cancel']);
});

test('the German allowance dialog points to Einstellungen › Berechtigungen, not to Tools (#353)', async (t) => {
  const { invoke, dialogCalls } = await setup(t, { dialogResponse: 1 });
  await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, makeSender(), { effect: 'allow', riskClass: 'read' });
  assert.match(dialogCalls[0].detail, /Modus „Intelligent“, bis du sie unter Einstellungen › Berechtigungen löschst\.$/);
});

test('sensible Pfadmuster, Reset-Reichweiten und Sitzungsfreigaben löschen', async (t) => {
  const { invoke, toolPolicyStore, sessionGrants } = await setup(t);
  const sender = makeSender();
  // Leerzeichen sind in Pfaden legitim („My Documents“), Steuerzeichen und Ausbrüche nicht.
  const patterns = await invoke(REQ.TOOL_PERMISSIONS_SET_SENSITIVE_PATHS, sender, ['personal/**', '../x', 'a\u0007b', 'My Documents/**']);
  assert.equal(patterns.ok, true);
  assert.deepEqual(patterns.sensitivePathPatterns, ['personal/**', 'My Documents/**']);
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_SET_SENSITIVE_PATHS, sender, 'personal/**')).ok, false);

  await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'deny', tool: 'a', scope: 'workspace' });
  await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'deny', tool: 'b' });
  sessionGrants.grant({ scopeKey: 's', tool: 't', targets: [], riskClasses: ['read'] });

  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_CLEAR_SESSION_GRANTS, sender)).ok, true);
  assert.equal(sessionGrants.count(), 0);
  assert.equal((await toolPolicyStore.read()).rules.length, 2, 'Regeln bleiben');

  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_RULES, sender)).ok, true);
  let state = await toolPolicyStore.read();
  assert.equal(state.rules.length, 1);
  assert.equal(state.sensitivePathPatterns.length, 2, 'Muster bleiben');

  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_RESET_ALL, sender)).ok, true);
  state = await toolPolicyStore.read();
  assert.deepEqual(state.rules, []);
  assert.deepEqual(state.sensitivePathPatterns, []);
  assert.equal(state.mode, 'smart');
});

test('Freigabe-Antworten: nur eigene offene Anfrage, nur requestId und Entscheidung', async (t) => {
  const { invoke, approvals } = await setup(t);
  const sender = makeSender(7);
  assert.equal((await invoke(REQ.TOOL_APPROVAL_SUBSCRIBE, sender)).ok, true);
  assert.equal(approvals.isAvailable(7), true);

  const pending = approvals.requestApproval({ sessionId: 7, request: { tool: 'edit_file', riskClasses: ['write'], targets: [{ path: 'a' }], mode: 'smart', sessionAllowed: false } });
  const requestId = sender.sent.find((s) => s.channel === PUSH.TOOL_APPROVAL_REQUEST).payload.requestId;
  const listed = await invoke(REQ.TOOL_APPROVAL_LIST_PENDING, sender);
  assert.equal(listed.requests.length, 1);
  assert.equal(listed.requests[0].requestId, requestId);

  assert.equal((await invoke(REQ.TOOL_APPROVAL_RESPOND, sender, { requestId, response: 'maybe' })).ok, false);
  assert.equal((await invoke(REQ.TOOL_APPROVAL_RESPOND, makeSender(8), { requestId, response: 'allow-once' })).ok, false, 'fremdes Fenster');
  assert.equal((await invoke(REQ.TOOL_APPROVAL_RESPOND, sender, { requestId, response: 'allow-once', args: { relative_path: 'evil' } })).ok, true);
  const outcome = await pending;
  assert.equal(outcome.response, 'allow-once');
  assert.equal('args' in outcome, false);
  assert.equal((await invoke(REQ.TOOL_APPROVAL_RESPOND, sender, { requestId, response: 'deny' })).ok, false, 'doppelt');
  assert.deepEqual((await invoke(REQ.TOOL_APPROVAL_LIST_PENDING, sender)).requests, []);
});

test('der gesetzte Modus wird dem laufenden Chat gemerkt (#211)', async (t) => {
  const remembered = [];
  const { invoke } = await setup(t, {
    chatSessionSettings: { rememberMode: async (mode) => remembered.push(mode) },
  });

  await invoke(REQ.TOOL_PERMISSIONS_SET_MODE, makeSender(), 'ask-all');
  assert.deepEqual(remembered, ['ask-all']);
});

test('ein abgelehnter Auto-Dialog merkt auch nichts (#211)', async (t) => {
  const remembered = [];
  const { invoke } = await setup(t, {
    dialogResponse: 1,
    chatSessionSettings: { rememberMode: async (mode) => remembered.push(mode) },
  });

  const res = await invoke(REQ.TOOL_PERMISSIONS_SET_MODE, makeSender(), 'auto');
  assert.equal(res.ok, false);
  assert.deepEqual(remembered, []);
});

test('a mode change belongs to the chat on screen: a run in the background keeps its card and approvals (#320)', async (t) => {
  const chatSessionSettings = { getCurrentChatId: () => 'chat-visible', rememberMode: async () => {} };
  const { invoke, approvals, sessionGrants } = await setup(t, { chatSessionSettings });
  const sender = makeSender();
  approvals.subscribe(sender.id, sender);
  const request = (chatId) => ({ tool: 't', riskClasses: ['write'], targets: [], mode: 'smart', chatId });
  const visible = approvals.requestApproval({ sessionId: sender.id, request: request('chat-visible') });
  void approvals.requestApproval({ sessionId: sender.id, request: request('chat-background') });
  const grant = (chatId) =>
    sessionGrants.grant({ scopeKey: chatId, tool: 'edit_file', targets: [{ path: 'a.js' }], riskClasses: ['write'], chatId });
  grant('chat-visible');
  grant('chat-background');

  const res = await invoke(REQ.TOOL_PERMISSIONS_SET_MODE, sender, 'ask-all');
  assert.equal(res.ok, true);
  assert.equal((await visible).invalidated, true, 'the visible chat changed its mode');
  assert.equal(approvals.pendingCount(), 1, 'the background chat still waits for its answer');
  assert.equal(sessionGrants.count(), 1);
  assert.ok(sender.sent.some((entry) => entry.channel === PUSH.TOOL_PERMISSIONS_CHANGED));
});

// Per-workspace sandbox opt-out (#357).
test('sandbox off needs the native confirmation; cancelling stores nothing', async (t) => {
  const { invoke, dialogCalls, toolPolicyStore } = await setup(t, { dialogResponse: 1, locale: 'en' });
  const sender = makeSender();
  const res = await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, sender, false);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'cancelled');
  assert.deepEqual(res.error, { key: 'permissions.error.sandboxNotSwitchedOff' });
  assert.equal(dialogCalls.length, 1);
  assert.equal(dialogCalls[0].message, 'Run without sandbox in this workspace?');
  assert.match(dialogCalls[0].detail, /In \/work\/projekt, shell_execute and run_python will run with your full rights/);
  assert.match(dialogCalls[0].detail, /In “Auto” mode they run without asking/);
  assert.match(dialogCalls[0].detail, /under Settings › Tools/);
  assert.deepEqual(dialogCalls[0].buttons, ['Run without sandbox', 'Cancel']);
  assert.equal(dialogCalls[0].cancelId, 1, 'Cancel is the default');
  assert.equal(await toolPolicyStore.isWorkspaceSandboxDisabled('/work/projekt'), false);
  assert.equal(sender.sent.length, 0);
});

test('sandbox off after confirmation binds main\'s root and voids open cards; on asks nothing', async (t) => {
  const { invoke, dialogCalls, toolPolicyStore, sessionGrants } = await setup(t, { dialogResponse: 0 });
  const sender = makeSender();
  sessionGrants.grant({ scopeKey: 's', tool: 'read_file_text', targets: [], riskClasses: ['read'], providerKey: 'p' });
  const off = await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, sender, false);
  assert.equal(off.ok, true);
  assert.equal(off.workspaceSandboxDisabled, true);
  assert.equal(await toolPolicyStore.isWorkspaceSandboxDisabled('/work/projekt'), true);
  assert.equal(sessionGrants.count(), 0);
  assert.deepEqual(sender.sent.map((m) => m.channel), [PUSH.TOOL_PERMISSIONS_CHANGED]);

  const state = await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender);
  assert.equal(state.workspaceSandboxDisabled, true);

  const on = await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, sender, true);
  assert.equal(on.ok, true);
  assert.equal(dialogCalls.length, 1, 'switching back on needs no dialog');
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender)).workspaceSandboxDisabled, false);
});

test('sandbox setting: no workspace, no change; anything but a boolean is refused', async (t) => {
  const { invoke, dialogCalls } = await setup(t, { workspaceRoot: null });
  const sender = makeSender();
  const res = await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, sender, false);
  assert.equal(res.ok, false);
  assert.deepEqual(res.error, { key: 'permissions.error.noWorkspace' });
  const bad = await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, sender, 'off');
  assert.deepEqual(bad.error, { key: 'permissions.error.invalidSandboxSetting' });
  assert.equal(dialogCalls.length, 0);
});

test('state reports unisolated execution: opted out, or no sandbox on this system', async (t) => {
  let described = { active: ['shell_execute'], sandbox: { status: 'isolated', isolated: true } };
  const { invoke } = await setup(t, { describeExecutionTools: async () => described });
  const sender = makeSender();

  let state = await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender);
  assert.deepEqual(state.executionIsolation, { unisolated: false, tools: ['shell_execute'], reason: '', pending: false });

  await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, sender, false);
  state = await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender);
  assert.deepEqual(state.executionIsolation, { unisolated: true, tools: ['shell_execute'], reason: 'workspace', pending: false });

  await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, sender, true);
  described = { active: ['run_python'], sandbox: { status: 'unavailable', reason: 'platform' } };
  state = await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender);
  assert.deepEqual(state.executionIsolation, { unisolated: true, tools: ['run_python'], reason: 'platform', pending: false });

  // No execution tool offered: nothing runs, nothing to warn about.
  described = { active: [], sandbox: { status: 'unavailable', reason: 'platform' } };
  state = await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender);
  assert.equal(state.executionIsolation.unisolated, false);
});

test('state marks a sandbox that is still being checked as pending, not as unisolated (#398)', async (t) => {
  let described = { active: ['shell_execute'], sandbox: { status: 'testing' } };
  const { invoke } = await setup(t, { describeExecutionTools: async () => described });
  const sender = makeSender();

  let state = await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender);
  assert.deepEqual(state.executionIsolation, { unisolated: false, tools: ['shell_execute'], reason: '', pending: true });

  described = { active: ['shell_execute'], sandbox: { status: 'unknown' } };
  state = await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender);
  assert.equal(state.executionIsolation.pending, true);

  // The user's own opt-out needs no detection: not pending, unisolated.
  await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, sender, false);
  state = await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender);
  assert.deepEqual(state.executionIsolation, { unisolated: true, tools: ['shell_execute'], reason: 'workspace', pending: false });
});

// ── Program allowances (#408) ───────────────────────────────────────────────

const TODO_PATH = '/Users/u/.ai-workplace/bin/ms-todo-cli';
const TODO_CACHE = '/Users/u/Library/Application Support/ms-todo';

/** A stand-in for main's service: what the dialog sends becomes an entry as is. */
function fakeAllowances({ folderOk = true } = {}) {
  return {
    async prepareEntry(raw) {
      if (raw.program !== 'ms-todo-cli' && raw.program !== TODO_PATH) {
        return { ok: false, error: { key: 'permissions.allowance.error.programNotFound', params: { program: raw.program } } };
      }
      return {
        ok: true,
        entry: { path: TODO_PATH, domains: [...raw.domains].sort(), writePaths: [...raw.writePaths].sort(), trustd: raw.trustd === true },
      };
    },
    async resolveProgram(text) {
      return text === 'ms-todo-cli'
        ? { ok: true, path: TODO_PATH, name: 'ms-todo-cli' }
        : { ok: false, error: { key: 'permissions.allowance.error.programNotFound', params: { program: text } } };
    },
    async validateWritePath(folder) {
      return folderOk ? { ok: true, path: folder } : { ok: false, error: { key: 'permissions.allowance.error.folderTooBroad', params: { folder } } };
    },
  };
}

const TODO_INPUT = {
  program: 'ms-todo-cli',
  domains: ['login.microsoftonline.com', 'graph.microsoft.com'],
  writePaths: [TODO_CACHE],
  trustd: true,
};

test('a new allowance needs the native confirmation, which names every right; cancelling stores nothing', async (t) => {
  const { invoke, dialogCalls, toolPolicyStore } = await setup(t, { dialogResponse: 1, locale: 'en', programAllowances: fakeAllowances() });
  const sender = makeSender();
  const res = await invoke(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, sender, TODO_INPUT);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'cancelled');
  assert.deepEqual(res.error, { key: 'permissions.allowance.error.notSaved' });
  assert.equal(dialogCalls.length, 1);
  assert.equal(dialogCalls[0].message, 'Give ms-todo-cli extra rights in the sandbox?');
  assert.match(dialogCalls[0].detail, /Whenever a command runs ~\/.ai-workplace\/bin\/ms-todo-cli on its own, in any workspace:/);
  assert.match(dialogCalls[0].detail, /• it may reach graph\.microsoft\.com, login\.microsoftonline\.com/);
  assert.match(dialogCalls[0].detail, /• it may write in ~\/Library\/Application Support\/ms-todo/);
  assert.match(dialogCalls[0].detail, /• it may check certificates through macOS\. That opens a system service outside the sandbox/);
  assert.match(dialogCalls[0].detail, /under Settings › Tools/);
  assert.deepEqual(dialogCalls[0].buttons, ['Allow', 'Cancel']);
  assert.equal(dialogCalls[0].cancelId, 1, 'Cancel is the default');
  assert.deepEqual(await toolPolicyStore.readProgramAllowances(), []);
  assert.equal(sender.sent.length, 0);
});

test('a confirmed allowance is stored, voids open cards and shows up in the state', async (t) => {
  const { invoke, dialogCalls } = await setup(t, { programAllowances: fakeAllowances() });
  const sender = makeSender();
  const res = await invoke(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, sender, TODO_INPUT);
  assert.equal(res.ok, true);
  assert.equal(dialogCalls.length, 1);
  assert.equal(sender.sent.at(-1).channel, PUSH.TOOL_PERMISSIONS_CHANGED);
  const state = await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender);
  assert.deepEqual(state.programAllowances, [{
    path: TODO_PATH,
    domains: ['graph.microsoft.com', 'login.microsoftonline.com'],
    writePaths: [TODO_CACHE],
    trustd: true,
  }]);
  assert.equal(state.platform, 'darwin');
  assert.equal(state.homeDir, '/Users/u');
});

test('an edit that only takes rights away, and removing, ask nothing', async (t) => {
  const { invoke, dialogCalls, toolPolicyStore } = await setup(t, { programAllowances: fakeAllowances() });
  const sender = makeSender();
  await invoke(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, sender, TODO_INPUT);
  assert.equal(dialogCalls.length, 1);

  const narrower = await invoke(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, sender, {
    ...TODO_INPUT, trustd: false, writePaths: [], previousPath: TODO_PATH,
  });
  assert.equal(narrower.ok, true);
  assert.equal(dialogCalls.length, 1, 'no dialog for taking rights away');

  const wider = await invoke(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, sender, { ...TODO_INPUT, previousPath: TODO_PATH });
  assert.equal(wider.ok, true);
  assert.equal(dialogCalls.length, 2, 'widening again asks again');

  const removed = await invoke(REQ.TOOL_PERMISSIONS_REMOVE_PROGRAM_ALLOWANCE, sender, TODO_PATH);
  assert.equal(removed.ok, true);
  assert.equal(dialogCalls.length, 2);
  assert.deepEqual(await toolPolicyStore.readProgramAllowances(), []);
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_REMOVE_PROGRAM_ALLOWANCE, sender, 'relative')).ok, false);
});

test('what main refuses never reaches the dialog; without the service nothing is stored', async (t) => {
  const { invoke, dialogCalls } = await setup(t, { programAllowances: fakeAllowances() });
  const sender = makeSender();
  const res = await invoke(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, sender, { ...TODO_INPUT, program: 'nope' });
  assert.equal(res.ok, false);
  assert.equal(res.error.key, 'permissions.allowance.error.programNotFound');
  assert.equal(dialogCalls.length, 0);

  const bare = await setup(t);
  const none = await bare.invoke(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, sender, TODO_INPUT);
  assert.equal(none.error.key, 'permissions.allowance.error.unavailable');
});

test('the program field is resolved by main, and a folder is picked natively and checked at once', async (t) => {
  const picked = { canceled: false, filePaths: [TODO_CACHE] };
  const { invoke, openDialogCalls } = await setup(t, { locale: 'en', programAllowances: fakeAllowances(), openDialogResult: picked });
  const sender = makeSender();
  assert.deepEqual(await invoke(REQ.TOOL_PERMISSIONS_RESOLVE_PROGRAM, sender, 'ms-todo-cli'), { ok: true, path: TODO_PATH, name: 'ms-todo-cli' });
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_RESOLVE_PROGRAM, sender, 'nope')).ok, false);

  assert.deepEqual(await invoke(REQ.TOOL_PERMISSIONS_CHOOSE_ALLOWANCE_FOLDER, sender), { ok: true, path: TODO_CACHE });
  assert.deepEqual(openDialogCalls[0].properties, ['openDirectory', 'showHiddenFiles']);
  assert.equal(openDialogCalls[0].defaultPath, '/Users/u');
  assert.equal(openDialogCalls[0].title, 'Folder the program may write in');

  const refused = await setup(t, { programAllowances: fakeAllowances({ folderOk: false }), openDialogResult: picked });
  assert.equal((await refused.invoke(REQ.TOOL_PERMISSIONS_CHOOSE_ALLOWANCE_FOLDER, sender)).error.key, 'permissions.allowance.error.folderTooBroad');
  const cancelled = await setup(t, { programAllowances: fakeAllowances() });
  assert.equal((await cancelled.invoke(REQ.TOOL_PERMISSIONS_CHOOSE_ALLOWANCE_FOLDER, sender)).code, 'cancelled');
});
