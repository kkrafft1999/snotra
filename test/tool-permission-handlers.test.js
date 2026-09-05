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

async function setup(t, { dialogResponse = 0, workspaceRoot = '/work/projekt' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-perm-ipc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const toolPolicyStore = createToolPolicyStore({ app: { getPath: () => dir }, safeStorage: makeSafeStorage(), fs, path, crypto, log: { warn() {} } });
  const approvals = createToolApprovalAdapter({ randomUUID: () => crypto.randomUUID(), PUSH, log: { warn() {} } });
  const sessionGrants = createSessionGrants();
  const dialogCalls = [];
  const dialog = {
    async showMessageBox(_win, options) {
      dialogCalls.push(options || _win);
      return { response: typeof dialogResponse === 'function' ? dialogResponse(options) : dialogResponse };
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
  });
  // Handler direkt mit einem Event aufrufen, dessen sender das Fenster ist.
  const invoke = (channel, sender, payload) => ipcMain.handlers.get(channel)({ sender }, payload);
  return { toolPolicyStore, approvals, sessionGrants, dialogCalls, invoke };
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
