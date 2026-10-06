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

function makeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
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
  encryption = true,
  describeChats = undefined,
  describeTools = undefined,
  describeWorkspaceChats = undefined,
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-perm-ipc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const toolPolicyStore = createToolPolicyStore({ app: { getPath: () => dir }, safeStorage: makeSafeStorage(encryption), fs, path, crypto, log: { warn() {} } });
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
    describeChats,
    describeTools,
    describeWorkspaceChats,
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
      + 'The rule applies in “Smart” mode until you delete it under Settings › Tools & security.',
  );

  await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'deny', riskClass: 'write', pathPattern: '*.md' });
  const deny = (await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender)).globalRules.find((r) => r.effect === 'deny');
  await invoke(REQ.TOOL_PERMISSIONS_REMOVE_RULE, sender, deny.id);
  assert.equal(dialogCalls[2].message, 'Delete block?');
  assert.equal(dialogCalls[2].detail, 'The block on the risk class write for “*.md” is removed. After that, the mode decides again.');
  assert.deepEqual(dialogCalls[2].buttons, ['Delete block', 'Cancel']);
});

test('the German allowance dialog points to Einstellungen › Tools & Sicherheit, where the rules live (#353, #449)', async (t) => {
  const { invoke, dialogCalls } = await setup(t, { dialogResponse: 1 });
  await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, makeSender(), { effect: 'allow', riskClass: 'read' });
  assert.match(dialogCalls[0].detail, /Modus „Intelligent“, bis du sie unter Einstellungen › Tools & Sicherheit löschst\.$/);
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
  assert.match(dialogCalls[0].detail, /under Settings › Tools & security/);
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
  assert.match(dialogCalls[0].detail, /under Settings › Tools & security/);
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

// Default mode per workspace (#413).
test('workspace default "auto" needs the native confirmation naming the folder; cancelling stores nothing', async (t) => {
  const { invoke, dialogCalls, toolPolicyStore } = await setup(t, { dialogResponse: 1, locale: 'en' });
  const sender = makeSender();
  const res = await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, sender, 'auto');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'cancelled');
  assert.deepEqual(res.error, { key: 'permissions.error.workspaceAutoNotSet' });
  assert.equal(dialogCalls.length, 1);
  assert.equal(dialogCalls[0].message, 'Make “Auto” the default for this workspace?');
  assert.match(dialogCalls[0].detail, /Every new chat in \/work\/projekt will run in “Auto” mode/);
  assert.match(dialogCalls[0].detail, /also after an app restart/);
  assert.match(dialogCalls[0].detail, /switched to “Smart”/);
  assert.match(dialogCalls[0].detail, /under Settings › Tools & security/);
  assert.deepEqual(dialogCalls[0].buttons, ['Make “Auto” the default', 'Cancel']);
  assert.equal(dialogCalls[0].cancelId, 1, 'Cancel is the default');
  assert.equal(await toolPolicyStore.readWorkspaceMode('/work/projekt'), 'smart');
  assert.equal(sender.sent.length, 0);
});

test('workspace default: binds main\'s root, voids no card and no approval, and leaves the chat\'s mode alone', async (t) => {
  const { invoke, dialogCalls, toolPolicyStore, sessionGrants } = await setup(t, { dialogResponse: 0 });
  const sender = makeSender();
  sessionGrants.grant({ scopeKey: 's', tool: 'read_file_text', targets: [], riskClasses: ['read'], providerKey: 'p' });

  const auto = await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, sender, 'auto');
  assert.equal(auto.ok, true);
  assert.equal(auto.workspaceMode, 'auto');
  assert.equal(dialogCalls.length, 1);
  assert.equal(await toolPolicyStore.readWorkspaceMode('/work/projekt'), 'auto');
  assert.equal(sessionGrants.count(), 1, 'a default for new chats changes nothing for this one');
  assert.deepEqual(sender.sent.map((m) => m.channel), [PUSH.TOOL_PERMISSIONS_CHANGED]);

  const state = await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender);
  assert.equal(state.workspaceMode, 'auto');
  assert.equal(state.mode, 'smart');

  // Already "auto": nothing new to confirm.
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, sender, 'auto')).ok, true);
  assert.equal(dialogCalls.length, 1);

  // Stricter or back to "smart" asks nothing.
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, sender, 'ask-all')).ok, true);
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender)).workspaceMode, 'ask-all');
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, sender, 'smart')).ok, true);
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender)).workspaceMode, 'smart');
  assert.equal(dialogCalls.length, 1);
});

test('workspace default: no workspace, no change; an unknown mode is refused', async (t) => {
  const { invoke, dialogCalls } = await setup(t, { workspaceRoot: null });
  const sender = makeSender();
  const res = await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, sender, 'auto');
  assert.deepEqual(res.error, { key: 'permissions.error.noWorkspace' });
  const bad = await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, sender, 'yolo');
  assert.deepEqual(bad.error, { key: 'permissions.error.unknownMode' });
  assert.equal(dialogCalls.length, 0);
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender)).workspaceMode, null);
});

test('workspace default: "reset workspace rules" puts it back to "smart"', async (t) => {
  const { invoke } = await setup(t, { dialogResponse: 0 });
  const sender = makeSender();
  await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, sender, 'auto');
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_RULES, sender)).ok, true);
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender)).workspaceMode, 'smart');
});

// Without encrypted storage (#419).
test('without encrypted storage "Auto" is refused before any dialog; "Always ask" works', async (t) => {
  const { invoke, dialogCalls } = await setup(t, { encryption: false, dialogResponse: 0 });
  const sender = makeSender();
  const mode = await invoke(REQ.TOOL_PERMISSIONS_SET_MODE, sender, 'auto');
  assert.deepEqual(mode.error, { key: 'permissions.error.autoNeedsEncryption' });
  const workspace = await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, sender, 'auto');
  assert.deepEqual(workspace.error, { key: 'permissions.error.autoNeedsEncryption' });
  assert.equal(dialogCalls.length, 0, 'no confirmation that leads nowhere');

  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_SET_MODE, sender, 'ask-all')).ok, true);
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, sender, 'ask-all')).ok, true);
  const state = await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender);
  assert.equal(state.integrity, 'unsigned');
  assert.equal(state.mode, 'ask-all');
  assert.equal(state.workspaceMode, 'ask-all');
});

// CR-B14-09, item 1: the dialog used to come first and the refusal after it.
test('without encrypted storage switching the sandbox off is refused before any dialog; on works', async (t) => {
  const { invoke, dialogCalls, toolPolicyStore } = await setup(t, { encryption: false, dialogResponse: 0 });
  const sender = makeSender();
  const off = await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, sender, false);
  assert.equal(off.ok, false);
  assert.deepEqual(off.error, { key: 'permissions.error.sandboxOffNeedsEncryption' });
  assert.equal(off.code, undefined, 'refused, not cancelled: the renderer shows the reason');
  assert.equal(dialogCalls.length, 0, 'no confirmation that leads nowhere');
  assert.equal(await toolPolicyStore.isWorkspaceSandboxDisabled('/work/projekt'), false);
  assert.equal(sender.sent.length, 0);

  const on = await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, sender, true);
  assert.equal(on.ok, true);
  assert.equal(dialogCalls.length, 0);
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender)).workspaceSandboxDisabled, false);
});

// ── Session approvals one by one (#447) ────────────────────────────────────

test('the state lists session approvals with display data only, grouped by chat (#447)', async (t) => {
  const chatSessionSettings = { getCurrentChatId: () => 'chat-a', rememberMode: async () => {} };
  const { invoke, sessionGrants } = await setup(t, {
    chatSessionSettings,
    describeChats: async (ids) => new Map(ids.filter((id) => id === 'chat-a').map((id) => [id, 'Release notes'])),
  });
  const sender = makeSender();
  const scope = { key: 'approval.sessionScope.targets', params: { tool: 'write_file_text', paths: 'docs/a.md', effectKeys: [] } };
  sessionGrants.grant({ scopeKey: 'secret-scope', tool: 'write_file_text', targets: [{ path: 'docs/a.md' }], riskClasses: ['write'], chatId: 'chat-a', scope });
  sessionGrants.grant({ scopeKey: 'other', tool: 'read_file_text', targets: [{ path: '.env', version: '3' }], riskClasses: ['read-sensitive'], chatId: 'chat-b', providerKey: 'openai|https://x' });

  const state = await invoke(REQ.TOOL_PERMISSIONS_GET_STATE, sender);
  assert.equal(state.sessionGrantCount, 2);
  assert.equal(state.sessionGrants.length, 2);
  const [first, second] = state.sessionGrants;
  assert.deepEqual(Object.keys(first).sort(), ['chatId', 'chatTitle', 'classes', 'current', 'grantedAt', 'id', 'scope', 'tool']);
  assert.equal(first.chatTitle, 'Release notes');
  assert.equal(first.current, true);
  assert.deepEqual(first.scope, scope);
  assert.equal(second.current, false);
  assert.equal(second.chatTitle, '', 'an untitled chat is named by the renderer');
  const serialised = JSON.stringify(state.sessionGrants);
  for (const hidden of ['secret-scope', 'openai|https://x', '.env@3']) {
    assert.equal(serialised.includes(hidden), false, `${hidden} must not leave main`);
  }
});

test('revoking one session approval drops only that one, asks nothing and voids no card (#447)', async (t) => {
  const { invoke, sessionGrants, approvals, dialogCalls } = await setup(t);
  const sender = makeSender(3);
  assert.equal((await invoke(REQ.TOOL_APPROVAL_SUBSCRIBE, sender)).ok, true);
  const keep = sessionGrants.grant({ scopeKey: 's', tool: 'edit_file', targets: [{ path: 'a' }], riskClasses: ['write'] });
  const drop = sessionGrants.grant({ scopeKey: 's', tool: 'edit_file', targets: [{ path: 'b' }], riskClasses: ['write'] });
  const pending = approvals.requestApproval({ sessionId: 3, request: { tool: 'edit_file', riskClasses: ['write'], targets: [] } });

  const result = await invoke(REQ.TOOL_PERMISSIONS_REVOKE_SESSION_GRANT, sender, drop.id);
  assert.equal(result.ok, true);
  assert.equal(result.revoked, true);
  assert.deepEqual(sessionGrants.list().map((g) => g.id), [keep.id]);
  assert.equal(sessionGrants.find({ scopeKey: 's', tool: 'edit_file', targets: [{ path: 'b' }], riskClasses: ['write'] }), null);
  assert.equal(dialogCalls.length, 0, 'revoking only tightens');
  assert.equal(approvals.pendingCount(), 1, 'the open card stays');
  assert.ok(sender.sent.some((m) => m.channel === PUSH.TOOL_PERMISSIONS_CHANGED));

  const again = await invoke(REQ.TOOL_PERMISSIONS_REVOKE_SESSION_GRANT, sender, drop.id);
  assert.deepEqual([again.ok, again.revoked], [true, false], 'an id that is gone is no error');
  for (const bad of [undefined, '', '   ', 42, { id: keep.id }, 'x'.repeat(201)]) {
    assert.equal((await invoke(REQ.TOOL_PERMISSIONS_REVOKE_SESSION_GRANT, sender, bad)).ok, false);
  }
  assert.equal(sessionGrants.count(), 1);
  approvals.invalidateAll();
  await pending;
});

// ── Settings › Security (#448) ─────────────────────────────────────────────

const SECURITY_TOOLS = [
  { name: 'read_file_text', shortDescription: 'Read a file', riskClasses: ['read'], available: true, disabled: false, mcpServer: null },
  { name: 'write_file_text', shortDescription: 'Write a file', riskClasses: ['write'], available: true, disabled: false, mayOverwrite: true, mcpServer: null },
  { name: 'shell_execute', shortDescription: 'Shell', riskClasses: ['execute'], available: true, disabled: false, mcpServer: null },
  { name: 'web_search', shortDescription: 'Search', riskClasses: ['external'], available: false, disabled: false, mcpServer: null },
];

test('the Security overview follows the workspace default, not the chat on screen (#448)', async (t) => {
  const chatSessionSettings = { getCurrentChatId: () => 'chat-a', rememberMode: async () => {} };
  const { invoke, sessionGrants } = await setup(t, {
    dialogResponse: 0,
    chatSessionSettings,
    describeTools: async () => SECURITY_TOOLS,
    describeWorkspaceChats: async (root) => {
      assert.equal(root, '/work/projekt', "main's own root, never one from the renderer");
      return [
        { id: 'chat-a', title: 'On screen', mode: null },
        { id: 'chat-b', title: 'Check dependencies', mode: 'ask-all' },
        { id: 'chat-c', title: 'Plain', mode: null },
      ];
    },
    describeExecutionTools: async () => ({ active: ['shell_execute'], sandbox: { status: 'isolated', isolated: true } }),
  });
  const sender = makeSender();
  // The chat on screen switches to Auto; the folder default stays Smart.
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_SET_MODE, sender, 'auto')).ok, true);
  sessionGrants.grant({ scopeKey: 's', tool: 'write_file_text', targets: [{ path: 'a' }], riskClasses: ['write'], chatId: 'chat-a' });
  sessionGrants.grant({ scopeKey: 's', tool: 'write_file_text', targets: [{ path: 'b' }], riskClasses: ['write'], chatId: 'other-folder' });

  const overview = await invoke(REQ.TOOL_PERMISSIONS_GET_SECURITY_OVERVIEW, sender, { root: '/evil' });
  assert.deepEqual(overview.workspace, { root: '/work/projekt', name: 'projekt' });
  assert.equal(overview.defaultMode, 'smart');
  const status = Object.fromEntries(overview.classes.map((entry) => [entry.riskClass, entry.status]));
  assert.deepEqual(status, {
    read: 'runs', 'read-sensitive': 'asks', write: 'asks', delete: 'asks', execute: 'asks', external: 'off',
  });
  assert.deepEqual(
    overview.chatsWithOtherMode.map((chat) => [chat.title, chat.mode, chat.current]),
    [['On screen', 'auto', true], ['Check dependencies', 'ask-all', false]]
  );
  const write = overview.classes.find((entry) => entry.riskClass === 'write');
  assert.deepEqual(write.sessionGrants.map((grant) => grant.chatId), ['chat-a'], 'another folder\'s approval stays off this page');
  assert.equal(overview.execution.toolsOn, true);
  assert.equal(overview.execution.sandbox.isolated, true);
});

test('the Security overview without a folder, and with failing describers (#448)', async (t) => {
  const { invoke } = await setup(t, {
    workspaceRoot: null,
    describeTools: async () => { throw new Error('registry gone'); },
    describeWorkspaceChats: async () => { throw new Error('must not be asked'); },
  });
  const overview = await invoke(REQ.TOOL_PERMISSIONS_GET_SECURITY_OVERVIEW, makeSender());
  assert.equal(overview.workspace, null);
  assert.equal(overview.defaultMode, 'smart');
  assert.ok(overview.classes.every((entry) => entry.status === 'off' && entry.offReason === 'no-tools'));
  assert.deepEqual(overview.chatsWithOtherMode, []);
});

// ── Removing protection is confirmed natively (#514) ────────────────────────

test('dropping a sensitive path pattern needs the native dialog; adding one does not (#514)', async (t) => {
  const { invoke, dialogCalls, toolPolicyStore } = await setup(t, { dialogResponse: 1, locale: 'en' });
  const sender = makeSender();
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_SET_SENSITIVE_PATHS, sender, ['personal/**', 'hr/**'])).ok, true);
  assert.equal(dialogCalls.length, 0, 'adding only tightens');

  const cancelled = await invoke(REQ.TOOL_PERMISSIONS_SET_SENSITIVE_PATHS, sender, ['hr/**']);
  assert.equal(cancelled.ok, false);
  assert.equal(dialogCalls[0].message, 'Remove sensitive path patterns?');
  assert.match(dialogCalls[0].detail, /personal\/\*\*/);
  assert.deepEqual((await toolPolicyStore.read()).sensitivePathPatterns, ['personal/**', 'hr/**']);
});

test('a reset that removes blocks names them in a native dialog; cancelling keeps everything (#514)', async (t) => {
  let answer = 1;
  const { invoke, dialogCalls, toolPolicyStore } = await setup(t, { dialogResponse: () => answer, locale: 'en' });
  const sender = makeSender();
  await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'deny', riskClass: 'read', scope: 'workspace', pathPattern: 'private/**' });
  await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'deny', tool: 'edit_file' });
  await invoke(REQ.TOOL_PERMISSIONS_SET_SENSITIVE_PATHS, sender, ['personal/**']);
  await invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, sender, 'ask-all');

  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_RULES, sender)).ok, false);
  const workspaceDialog = dialogCalls.at(-1);
  assert.equal(workspaceDialog.message, 'Reset workspace rules?');
  assert.match(workspaceDialog.detail, /\/work\/projekt/);
  assert.match(workspaceDialog.detail, /Blocks: 1/);
  assert.match(workspaceDialog.detail, /“Always ask” as their default: 1/);

  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_RESET_ALL, sender)).ok, false);
  const allDialog = dialogCalls.at(-1);
  assert.equal(allDialog.message, 'Reset all permissions?');
  assert.match(allDialog.detail, /Blocks: 2/);
  assert.match(allDialog.detail, /personal\/\*\*/);

  let state = await toolPolicyStore.read();
  assert.equal(state.rules.length, 2, 'nothing reset after cancelling');
  assert.equal(state.workspaceModes['/work/projekt'], 'ask-all');

  answer = 0;
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_RESET_ALL, sender)).ok, true);
  state = await toolPolicyStore.read();
  assert.deepEqual(state.rules, []);
  assert.deepEqual(state.sensitivePathPatterns, []);
});

test('resetting a workspace that only has allowances asks nothing; "reset all" always asks (#514)', async (t) => {
  let answer = 0;
  const { invoke, dialogCalls, toolPolicyStore } = await setup(t, { dialogResponse: () => answer, locale: 'en' });
  const sender = makeSender();
  await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'allow', riskClass: 'read', scope: 'workspace', pathPattern: 'docs/**' });
  const before = dialogCalls.length;
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_RULES, sender)).ok, true);
  assert.equal(dialogCalls.length, before, 'taking allowances away only tightens');
  assert.deepEqual((await toolPolicyStore.read()).rules, []);

  // Nothing protective to lose: still one confirmation, without a list of losses.
  await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'allow', riskClass: 'read', pathPattern: 'docs/**' });
  answer = 1;
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_RESET_ALL, sender)).ok, false);
  const dialog = dialogCalls.at(-1);
  assert.equal(dialog.message, 'Reset all permissions?');
  assert.doesNotMatch(dialog.detail, /removes protection/);
  assert.equal((await toolPolicyStore.read()).rules.length, 1, 'cancelled');
  answer = 0;
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_RESET_ALL, sender)).ok, true);
  assert.deepEqual((await toolPolicyStore.read()).rules, []);
});

// ── Rules the settings channel does not take (#517) ─────────────────────────

test('a command rule is not taken from the settings channel, and no dialog is shown (#517)', async (t) => {
  const { invoke, dialogCalls, toolPolicyStore } = await setup(t, { dialogResponse: 0 });
  const result = await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, makeSender(), {
    effect: 'allow', scope: 'workspace', tool: 'shell_execute', command: 'git status', cwd: '', networkDomains: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.key, 'permissions.error.commandRuleFromCard');
  assert.equal(dialogCalls.length, 0);
  assert.deepEqual((await toolPolicyStore.read()).rules, []);
});

test('an allow rule for a tool that can never be allowed permanently is refused before the dialog (#517)', async (t) => {
  const describeTools = async () => [
    { name: 'shell_execute', riskClasses: ['execute'] },
    { name: 'fetch_url', riskClasses: ['external'] },
    { name: 'edit_file', riskClasses: ['write'] },
  ];
  const { invoke, dialogCalls, toolPolicyStore } = await setup(t, { dialogResponse: 0, describeTools });
  const sender = makeSender();
  for (const tool of ['shell_execute', 'fetch_url']) {
    const result = await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'allow', tool });
    assert.equal(result.ok, false, tool);
    assert.equal(result.error.key, 'permissions.error.allowNotForTool');
  }
  assert.equal(dialogCalls.length, 0);
  // A deny rule for the same tool stays possible, and so does an allow rule for a writing tool.
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'deny', tool: 'shell_execute' })).ok, true);
  assert.equal((await invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, sender, { effect: 'allow', tool: 'edit_file' })).ok, true);
  assert.equal((await toolPolicyStore.read()).rules.length, 2);
});
