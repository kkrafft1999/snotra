'use strict';

// The user-confirmation port (#980, AR-05): loosening a protection is reachable
// only through a confirmation with a person at the machine. The receipts, the
// desktop adapter, the refusing implementation for every other front end, and
// the policy store that refuses each loosening without a receipt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  CONFIRMATION_ACTIONS: A,
  RECEIPT_TTL_MS,
  permissionRuleSubject,
  removedPatternsSubject,
  createConfirmationReceipts,
  createRefusingConfirmation,
} = require('../src/application/permissions/user-confirmation');
const { createNativeConfirmationAdapter } = require('../src/main/adapters/native-confirmation-adapter');
const { createToolPolicyStore } = require('../src/main/services/tool-policy-store');
const { registerToolPermissionHandlers } = require('../src/main/ipc/tool-permission-handlers');
const { registerFsHandlers } = require('../src/main/ipc/fs-handlers');
const { registerSkillMoveHandlers } = require('../src/main/ipc/skill-move-handlers');
const { createToolApprovalAdapter } = require('../src/main/adapters/tool-approval-adapter');
const { createSessionGrants } = require('../src/application/permissions/session-grants');
const { normalizePermissionRule } = require('../src/shared/contracts/tool-permissions');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');
const { removeTempDir } = require('./helpers/temp-dir');

const ROOT = '/work/projekt';
const SANDBOXED_TOOL = { path: '/usr/local/bin/tool', domains: ['example.com'], writePaths: [], trustd: false };

function makeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf) => buf.toString('utf8').slice(4),
  };
}

async function makeStore(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-confirm-'));
  t.after(() => removeTempDir(dir));
  return createToolPolicyStore({
    app: { getPath: () => dir }, safeStorage: makeSafeStorage(), fs, path, crypto, log: { warn() {} }, ...options,
  });
}

/** A store wired as in the composition root, and receipts as the desktop hands them out. */
async function wiredStore(t) {
  const receipts = createConfirmationReceipts();
  const store = await makeStore(t, { confirmationReceipts: { redeem: receipts.redeem } });
  const confirmed = (action, subject = '') => ({ confirmation: receipts.issue({ action, subject }) });
  return { store, receipts, confirmed };
}

function allowRule(overrides = {}) {
  return { effect: 'allow', scope: 'workspace', root: ROOT, riskClass: 'write', pathPattern: '**', ...overrides };
}

function ruleSubject(raw) {
  return permissionRuleSubject(normalizePermissionRule({ ...raw, id: 'x' }));
}

// --- Receipts -----------------------------------------------------------------

test('a receipt is good once, for its action and subject only', () => {
  const receipts = createConfirmationReceipts();
  const one = receipts.issue({ action: A.SANDBOX_OFF, subject: ROOT });
  assert.equal(receipts.redeem(one, A.SANDBOX_OFF, ROOT), true);
  assert.equal(receipts.redeem(one, A.SANDBOX_OFF, ROOT), false, 'spent');

  const wrongAction = receipts.issue({ action: A.SANDBOX_OFF, subject: ROOT });
  assert.equal(receipts.redeem(wrongAction, A.MODE_AUTO, ROOT), false);
  assert.equal(receipts.redeem(wrongAction, A.SANDBOX_OFF, ROOT), false, 'a failed attempt spends it too');

  const wrongSubject = receipts.issue({ action: A.SANDBOX_OFF, subject: ROOT });
  assert.equal(receipts.redeem(wrongSubject, A.SANDBOX_OFF, '/elsewhere'), false);
});

test('a receipt cannot be forged, copied or carried to another registry', () => {
  const receipts = createConfirmationReceipts();
  const real = receipts.issue({ action: A.RESET_ALL });
  assert.equal(receipts.redeem({}, A.RESET_ALL), false);
  assert.equal(receipts.redeem(JSON.parse(JSON.stringify(real)), A.RESET_ALL), false, 'a copy over a wire is another object');
  assert.equal(receipts.redeem(structuredClone(real), A.RESET_ALL), false);
  assert.equal(receipts.redeem('receipt', A.RESET_ALL), false);
  assert.equal(receipts.redeem(null, A.RESET_ALL), false);
  assert.equal(createConfirmationReceipts().redeem(real, A.RESET_ALL), false, 'another registry knows nothing of it');
  assert.equal(receipts.redeem(real, A.RESET_ALL), true);
});

test('a receipt expires', () => {
  let now = 0;
  const receipts = createConfirmationReceipts({ now: () => now });
  const late = receipts.issue({ action: A.MODE_AUTO });
  now = RECEIPT_TTL_MS + 1;
  assert.equal(receipts.redeem(late, A.MODE_AUTO), false);
});

// --- The adapters -------------------------------------------------------------

test('a front end without a person at the machine confirms nothing', async () => {
  const port = createRefusingConfirmation();
  assert.equal(port.presence, 'none');
  assert.equal(port.canConfirm(), false);
  assert.deepEqual(await port.confirm({ action: A.MODE_AUTO, prompt: { message: 'x', buttons: ['Yes', 'No'] } }),
    { confirmed: false, reason: 'no-presence' });
});

test('the desktop adapter: native dialog over the window, cancel always the default', async () => {
  const receipts = createConfirmationReceipts();
  const calls = [];
  const win = { isDestroyed: () => false };
  let response = 0;
  const port = createNativeConfirmationAdapter({
    dialog: { showMessageBox: async (...args) => { calls.push(args); return { response }; } },
    getMainWindow: () => win,
    receipts: { issue: receipts.issue },
  });
  assert.equal(port.presence, 'desktop');
  assert.equal(port.canConfirm(), true);

  // A prompt that asks for Enter to confirm still gets cancel as the default (#59).
  const yes = await port.confirm({ action: A.SANDBOX_OFF, subject: ROOT, prompt: { message: 'm', buttons: ['Off', 'Cancel'], defaultId: 0, cancelId: 0 } });
  assert.equal(calls[0][0], win, 'modal over the app window');
  assert.equal(calls[0][1].defaultId, 1);
  assert.equal(calls[0][1].cancelId, 1);
  assert.equal(yes.confirmed, true);
  assert.equal(receipts.redeem(yes.receipt, A.SANDBOX_OFF, ROOT), true, 'the receipt is bound to what was asked');

  response = 1;
  assert.deepEqual(await port.confirm({ action: A.SANDBOX_OFF, subject: ROOT, prompt: { message: 'm', buttons: ['Off', 'Cancel'] } }),
    { confirmed: false, reason: 'declined' });
});

test('the desktop adapter without a dialog fails safe', async () => {
  const port = createNativeConfirmationAdapter({ dialog: null });
  assert.equal(port.canConfirm(), false);
  assert.deepEqual(await port.confirm({ action: A.MODE_AUTO, prompt: { message: 'm', buttons: ['Yes', 'No'] } }),
    { confirmed: false, reason: 'no-presence' });
});

test('a receipt from an adapter not wired to the store loosens nothing', async (t) => {
  const { store } = await wiredStore(t);
  const stray = createNativeConfirmationAdapter({ dialog: { showMessageBox: async () => ({ response: 0 }) } });
  const outcome = await stray.confirm({ action: A.SANDBOX_OFF, subject: ROOT, prompt: { message: 'm', buttons: ['Off', 'Cancel'] } });
  assert.equal(outcome.confirmed, true);
  const result = await store.setWorkspaceSandbox(ROOT, false, { confirmation: outcome.receipt });
  assert.equal(result.ok, false);
  assert.equal(result.error.key, 'permissions.error.notConfirmed');
});

// --- The policy store ---------------------------------------------------------

/** Every loosening the store knows, each with the receipt it needs. */
const LOOSENINGS = [
  { name: 'setMode auto', action: A.MODE_AUTO, subject: 'chat-1', run: (s, o) => s.setMode('auto', { chatId: 'chat-1', ...o }), check: (st) => st.mode === 'auto' },
  { name: 'addRule allow', action: A.ALLOW_RULE, subject: ruleSubject(allowRule()), run: (s, o) => s.addRule(allowRule(), o), check: (st) => st.rules.length > 0 },
  { name: 'setWorkspaceSandbox off', action: A.SANDBOX_OFF, subject: ROOT, run: (s, o) => s.setWorkspaceSandbox(ROOT, false, o), check: (st) => st.unsandboxedWorkspaces.includes(ROOT) },
  { name: 'setWorkspaceMode auto', action: A.WORKSPACE_AUTO, subject: ROOT, run: (s, o) => s.setWorkspaceMode(ROOT, 'auto', o), check: (st) => st.workspaceModes[ROOT] === 'auto' },
  { name: 'setProgramAllowance', action: A.PROGRAM_ALLOWANCE, subject: SANDBOXED_TOOL.path, run: (s, o) => s.setProgramAllowance(SANDBOXED_TOOL, o), check: (st) => st.programAllowances.length > 0 },
  { name: 'addWorkspaceHosts', action: A.WORKSPACE_HOSTS, subject: ROOT, run: (s, o) => s.addWorkspaceHosts(ROOT, ['example.com:443'], o), check: (st) => !!st.workspaceHosts[ROOT] },
];

for (const loosening of LOOSENINGS) {
  test(`store: ${loosening.name} is refused without a receipt, with a wrong one, and done with the right one`, async (t) => {
    const { store, confirmed } = await wiredStore(t);
    const without = await loosening.run(store, {});
    assert.equal(without.ok, false);
    assert.equal(without.error.key, 'permissions.error.notConfirmed');
    const wrong = await loosening.run(store, confirmed(A.RESET_ALL, loosening.subject));
    assert.equal(wrong.ok, false, 'a receipt for another action');
    const elsewhere = await loosening.run(store, confirmed(loosening.action, `${loosening.subject}-other`));
    assert.equal(elsewhere.ok, false, 'a receipt for another subject');
    assert.equal(loosening.check(await store.read()), false, 'nothing was stored');
    const right = await loosening.run(store, confirmed(loosening.action, loosening.subject));
    assert.equal(right.ok, true, right.error?.key);
    assert.equal(loosening.check(await store.read()), true);
  });
}

test('store: a store wired to nothing refuses every loosening', async (t) => {
  const store = await makeStore(t);
  const receipt = { confirmation: createConfirmationReceipts().issue({ action: A.MODE_AUTO }) };
  for (const loosening of LOOSENINGS) {
    const result = await loosening.run(store, receipt);
    assert.equal(result.ok, false, loosening.name);
  }
});

test('store: taking a protection away needs a receipt — blocks, patterns, resets', async (t) => {
  const { store, confirmed } = await wiredStore(t);
  // Tightening needs none.
  assert.equal((await store.addRule(allowRule({ effect: 'deny', pathPattern: 'secret/**' }))).ok, true);
  assert.equal((await store.setSensitivePathPatterns(['*.pem', '*.key'])).ok, true);
  assert.equal((await store.setWorkspaceMode(ROOT, 'ask-all')).ok, true);
  const block = (await store.read()).rules[0];

  assert.equal((await store.removeRule(block.id)).ok, false);
  assert.equal((await store.removeRule(block.id, confirmed(A.REMOVE_BLOCK, 'other-id'))).ok, false);
  assert.equal((await store.setSensitivePathPatterns(['*.pem'])).ok, false);
  assert.equal((await store.resetWorkspaceRules(ROOT)).ok, false);
  assert.equal((await store.resetAll()).ok, false);
  const kept = await store.read();
  assert.equal(kept.rules.length, 1);
  assert.deepEqual(kept.sensitivePathPatterns, ['*.pem', '*.key']);
  assert.equal(kept.workspaceModes[ROOT], 'ask-all');

  assert.equal((await store.setSensitivePathPatterns(['*.pem'], confirmed(A.REMOVE_SENSITIVE_PATTERNS, removedPatternsSubject(['*.key'])))).ok, true);
  assert.equal((await store.removeRule(block.id, confirmed(A.REMOVE_BLOCK, block.id))).ok, true);
  assert.equal((await store.resetWorkspaceRules(ROOT, confirmed(A.RESET_WORKSPACE, ROOT))).ok, true);
  assert.equal((await store.resetAll(confirmed(A.RESET_ALL))).ok, true);
});

test('store: what only tightens needs no receipt', async (t) => {
  const { store, confirmed } = await wiredStore(t);
  await store.setMode('auto', { chatId: 'c', ...confirmed(A.MODE_AUTO, 'c') });
  await store.setWorkspaceSandbox(ROOT, false, confirmed(A.SANDBOX_OFF, ROOT));
  await store.addWorkspaceHosts(ROOT, ['example.com:443'], confirmed(A.WORKSPACE_HOSTS, ROOT));
  await store.setProgramAllowance(SANDBOXED_TOOL, confirmed(A.PROGRAM_ALLOWANCE, SANDBOXED_TOOL.path));
  await store.addRule(allowRule(), confirmed(A.ALLOW_RULE, ruleSubject(allowRule())));
  const allow = (await store.read()).rules[0];

  assert.equal((await store.setMode('smart')).ok, true);
  assert.equal((await store.setMode('ask-all')).ok, true);
  assert.equal((await store.setWorkspaceSandbox(ROOT, true)).ok, true);
  assert.equal((await store.removeWorkspaceHost(ROOT, 'example.com:443')).ok, true);
  assert.equal((await store.setProgramAllowance({ ...SANDBOXED_TOOL, domains: [] })).ok, true, 'narrowing');
  assert.equal((await store.removeProgramAllowance(SANDBOXED_TOOL.path)).ok, true);
  assert.equal((await store.removeRule(allow.id)).ok, true, 'an allow rule goes freely');
  assert.equal((await store.resetWorkspaceRules(ROOT)).ok, true, 'nothing protective goes with it');
});

// --- Restoring a chat's mode --------------------------------------------------

test('restore: "Auto" comes back only for a chat that had it confirmed', async (t) => {
  const { store, confirmed } = await wiredStore(t);
  const refused = await store.restoreMode('auto', { chatId: 'forged', workspaceRoot: ROOT });
  assert.equal(refused.ok, false, 'a history file saying "auto" is no confirmation');
  assert.equal((await store.read()).mode, 'smart');

  await store.setMode('auto', { chatId: 'chat-a', ...confirmed(A.MODE_AUTO, 'chat-a') });
  await store.restoreMode('smart', { chatId: 'chat-b' });
  assert.equal((await store.restoreMode('auto', { chatId: 'chat-a' })).ok, true);
  assert.equal((await store.read()).mode, 'auto');

  // The user takes it back for the chat: it is forgotten.
  await store.setMode('smart', { chatId: 'chat-a' });
  assert.equal((await store.restoreMode('auto', { chatId: 'chat-a' })).ok, false);
});

test('restore: a workspace whose default is "Auto" gives it to its chats, which keep it', async (t) => {
  const { store, confirmed } = await wiredStore(t);
  await store.setWorkspaceMode(ROOT, 'auto', confirmed(A.WORKSPACE_AUTO, ROOT));
  assert.equal((await store.restoreMode('auto', { chatId: 'new-chat', workspaceRoot: ROOT })).ok, true);
  assert.equal((await store.restoreMode('auto', { chatId: 'other', workspaceRoot: '/elsewhere' })).ok, false);
  await store.setWorkspaceMode(ROOT, 'smart');
  assert.equal((await store.restoreMode('auto', { chatId: 'new-chat', workspaceRoot: ROOT })).ok, true,
    'the chat got "Auto" from a confirmed default and keeps it');
});

test('restore: a failed signature and a full reset forget every confirmed chat', async (t) => {
  const { store, confirmed } = await wiredStore(t);
  await store.setMode('auto', { chatId: 'chat-a', ...confirmed(A.MODE_AUTO, 'chat-a') });
  await store.resetAll(confirmed(A.RESET_ALL));
  assert.equal((await store.restoreMode('auto', { chatId: 'chat-a' })).ok, false);

  await store.setMode('auto', { chatId: 'chat-b', ...confirmed(A.MODE_AUTO, 'chat-b') });
  const file = store.getPolicyPath();
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.payload.autoChats.push('injected');
  await fs.writeFile(file, JSON.stringify(raw));
  assert.equal((await store.read()).integrity, 'invalid');
  assert.equal((await store.restoreMode('auto', { chatId: 'injected' })).ok, false);
  assert.equal((await store.restoreMode('auto', { chatId: 'chat-b' })).ok, false, 'fail-safe drops them all');
});

// --- A front end that is not the desktop -------------------------------------

function makeSender() {
  const sent = [];
  return { id: 1, sent, send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false, once() {} };
}

test('handlers wired to a front end without presence loosen nothing, and ask nobody', async (t) => {
  const { store, confirmed } = await wiredStore(t);
  // Something to take away, so that removing it would loosen.
  await store.addRule(allowRule({ effect: 'deny', pathPattern: 'secret/**' }));
  await store.setSensitivePathPatterns(['*.pem']);
  const block = (await store.read()).rules[0];
  const before = JSON.stringify(await store.read());

  const shown = [];
  const ipcMain = createMockIpcMain();
  registerToolPermissionHandlers({
    ipcMain,
    // A dialog is there, but the port in use is not the desktop's.
    dialog: { showMessageBox: async (options) => { shown.push(options); return { response: 0 }; } },
    confirmations: createRefusingConfirmation(),
    toolPolicyStore: store,
    approvals: createToolApprovalAdapter({ randomUUID: () => crypto.randomUUID(), PUSH, log: { warn() {} } }),
    sessionGrants: createSessionGrants(),
    getActiveWorkspaceRoot: () => ROOT,
    programAllowances: { prepareEntry: async () => ({ ok: true, entry: SANDBOXED_TOOL }) },
    REQ,
    PUSH,
  });
  const invoke = (channel, payload) => ipcMain.handlers.get(channel)({ sender: makeSender() }, payload);

  const attempts = [
    [REQ.TOOL_PERMISSIONS_SET_MODE, 'auto'],
    [REQ.TOOL_PERMISSIONS_ADD_RULE, { effect: 'allow', scope: 'workspace', riskClass: 'write', pathPattern: '**' }],
    [REQ.TOOL_PERMISSIONS_REMOVE_RULE, block.id],
    [REQ.TOOL_PERMISSIONS_SET_SENSITIVE_PATHS, []],
    [REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, false],
    [REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, 'auto'],
    [REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, { program: 'tool' }],
    [REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_RULES, undefined],
    [REQ.TOOL_PERMISSIONS_RESET_ALL, undefined],
  ];
  for (const [channel, payload] of attempts) {
    const result = await invoke(channel, payload);
    assert.equal(result.ok, false, channel);
  }
  assert.deepEqual(shown, [], 'no dialog was shown for a front end that cannot answer it');
  assert.equal(JSON.stringify(await store.read()), before, 'the policy is unchanged');
  // The same store still loosens for the desktop.
  assert.equal((await store.removeRule(block.id, confirmed(A.REMOVE_BLOCK, block.id))).ok, true);
});

test('import and "make global" ask nobody and do nothing without a person at the machine', async () => {
  const ipcMain = createMockIpcMain();
  let imported = false;
  registerFsHandlers({
    ipcMain,
    REQ,
    filesystem: {
      inspectImport: async () => ({ dirs: 1, files: 3, bytes: 10, destDir: ROOT }),
      importItems: async () => { imported = true; return { ok: true }; },
    },
    dialog: { showMessageBox: async () => assert.fail('no dialog') },
    confirmations: createRefusingConfirmation(),
    getLocale: () => 'en',
  });
  const result = await ipcMain.invoke(REQ.FS_IMPORT_ITEMS, ['/outside/folder'], ROOT);
  assert.ok(result.error);
  assert.equal(imported, false);

  let moved = false;
  registerSkillMoveHandlers({
    ipcMain,
    REQ,
    skillsService: { makeGlobal: async () => { moved = true; return { ok: true }; } },
    uiPrefsStore: {},
    getActiveWorkspaceRoot: () => ROOT,
    dialog: { showMessageBox: async () => assert.fail('no dialog') },
    confirmations: createRefusingConfirmation(),
    getLocale: () => 'en',
  });
  const skill = await ipcMain.invoke(REQ.SKILLS_MAKE_GLOBAL, 'my-skill');
  assert.ok(skill.error);
  assert.equal(moved, false);
});
