// Settings › Tools › Security in main (#1119): the overview of every
// workspace's sandbox, the root the renderer may name, program allowances
// per scope, hosts kept open everywhere, the default for new workspaces and
// the two resets — each loosening confirmed natively, naming its scope.

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
const { createTestConfirmations } = require('./helpers/confirmations');
const { CONFIRMATION_ACTIONS, programAllowanceSubject } = require('../src/application/permissions/user-confirmation');
const { removeTempDir } = require('./helpers/temp-dir');
const { resolvePlatform } = require('../src/main/platforms');

const OPEN = '/Users/u/garden-planner';
const OTHER = '/Users/u/invoice-tool';
const GONE = '/Users/u/old-project';
const GH_PATH = '/opt/homebrew/bin/gh';

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

/** What the dialog sends becomes an entry as is; only `gh` is found. */
const fakeAllowances = {
  async prepareEntry(raw) {
    if (raw.program !== 'gh') return { ok: false, error: { key: 'permissions.allowance.error.programNotFound', params: { program: raw.program } } };
    return { ok: true, entry: { path: GH_PATH, domains: [...(raw.domains || [])].sort(), writePaths: [], trustd: raw.trustd === true } };
  },
  async resolveProgram() {
    return { ok: true, path: GH_PATH, name: 'gh' };
  },
  async validateWritePath(folder) {
    return { ok: true, path: folder };
  },
};

async function setup(t, { dialogResponse = 0, workspaceRoot = OPEN, locale = 'en', platform = 'darwin', knownWorkspaces = [], platformCapabilities, safeStorageAvailable = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-toolsec-ipc-'));
  t.after(() => removeTempDir(dir));
  const approvals = createToolApprovalAdapter({ randomUUID: () => crypto.randomUUID(), PUSH, log: { warn() {} } });
  const sessionGrants = createSessionGrants();
  const dialogCalls = [];
  const dialog = {
    async showMessageBox(_win, options) {
      dialogCalls.push(options || _win);
      return { response: typeof dialogResponse === 'function' ? dialogResponse(options) : dialogResponse };
    },
  };
  const getMainWindow = () => ({ isDestroyed: () => false });
  const { confirmations, storeReceipts, confirmed } = createTestConfirmations({ dialog, getMainWindow });
  const toolPolicyStore = createToolPolicyStore({
    userDataPath: dir, secretStore: makeSafeStorage(safeStorageAvailable), fs, path, crypto, log: { warn() {} },
    confirmationReceipts: storeReceipts,
  });
  const ipcMain = createMockIpcMain();
  let active = workspaceRoot;
  registerToolPermissionHandlers({
    ipcMain,
    dialog,
    confirmations,
    getMainWindow,
    toolPolicyStore,
    approvals,
    sessionGrants,
    getActiveWorkspaceRoot: () => active,
    REQ,
    PUSH,
    getLocale: () => locale,
    programAllowances: fakeAllowances,
    describeWorkspaceChats: async () => [{ id: 'chat-1', title: 'Fix the build', mode: null }],
    describeChats: async () => new Map([['chat-1', 'Fix the build']]),
    listKnownWorkspaces: async () => knownWorkspaces,
    folderExists: async (root) => root !== GONE,
    platform,
    ...(platformCapabilities ? { platformCapabilities } : {}),
    homeDir: '/Users/u',
  });
  const call = (channel, sender, ...args) => ipcMain.handlers.get(channel)({ sender }, ...args);
  return { toolPolicyStore, sessionGrants, dialogCalls, call, confirmed, setActive: (root) => { active = root; } };
}

// ── The overview ────────────────────────────────────────────────────────────

test('the overview lists the open workspace first, then every one with a sandbox setting, by name', async (t) => {
  const { call, toolPolicyStore, confirmed } = await setup(t);
  await toolPolicyStore.setWorkspaceSandbox(OTHER, false, confirmed(CONFIRMATION_ACTIONS.SANDBOX_OFF, OTHER));
  await toolPolicyStore.addWorkspaceHosts(GONE, ['huggingface.co:443'], confirmed(CONFIRMATION_ACTIONS.WORKSPACE_HOSTS, GONE));
  await toolPolicyStore.setProgramAllowance({ path: GH_PATH, domains: ['api.github.com'], writePaths: [], trustd: true },
    { root: OPEN, ...confirmed(CONFIRMATION_ACTIONS.PROGRAM_ALLOWANCE, programAllowanceSubject(GH_PATH, OPEN)) });
  await toolPolicyStore.addGlobalHosts(['gitlab.example.com:22'], confirmed(CONFIRMATION_ACTIONS.GLOBAL_HOSTS, 'gitlab.example.com:22'));
  const overview = await call(REQ.TOOL_PERMISSIONS_GET_SANDBOX_OVERVIEW, makeSender());
  // The open one first, then by folder name: invoice-tool before old-project.
  assert.deepEqual(overview.workspaces.map((ws) => ws.root), [OPEN, OTHER, GONE]);
  const [open, invoice, old] = [OPEN, OTHER, GONE].map((root) => overview.workspaces.find((ws) => ws.root === root));
  assert.equal(open.open, true);
  assert.deepEqual(open.programs.map((entry) => entry.path), [GH_PATH]);
  assert.equal(invoice.sandboxOff, true);
  assert.equal(old.missing, true, 'a folder that is gone says so');
  assert.deepEqual(old.hosts, ['huggingface.co:443']);
  assert.deepEqual(overview.global, { programs: [], hosts: ['gitlab.example.com:22'] });
  assert.equal(overview.newWorkspaceSandbox, true);
  assert.equal(overview.activeRoot, OPEN);
});

test('without an open folder the overview lists only what is stored', async (t) => {
  const { call } = await setup(t, { workspaceRoot: null });
  const overview = await call(REQ.TOOL_PERMISSIONS_GET_SANDBOX_OVERVIEW, makeSender());
  assert.deepEqual(overview.workspaces, []);
  assert.equal(overview.activeRoot, null);
});

// Encrypted storage reaches the window through the platform register, resolved
// at start, and through nothing else (#1156); what main allows still follows
// safeStorage live and fails closed.
test('the window reads encrypted storage from the register only (#1156)', async (t) => {
  const withoutStorage = resolvePlatform({ platform: 'darwin', facts: { encryptionAvailable: false } });
  const { call } = await setup(t, { platformCapabilities: withoutStorage });
  for (const channel of [
    REQ.TOOL_PERMISSIONS_GET_STATE,
    REQ.TOOL_PERMISSIONS_GET_SANDBOX_OVERVIEW,
    REQ.TOOL_PERMISSIONS_GET_SECURITY_OVERVIEW,
  ]) {
    const dto = await call(channel, makeSender());
    assert.equal('encryptionAvailable' in dto, false, channel);
  }
  assert.equal((await call(REQ.TOOL_PERMISSIONS_GET_STATE, makeSender())).platformCapabilities.secureStorage, false);
  assert.equal((await call(REQ.TOOL_PERMISSIONS_GET_SANDBOX_OVERVIEW, makeSender())).platformCapabilities.secureStorage, false);
});

test('a register that promised encrypted storage does not open a guard safeStorage closes (#1156)', async (t) => {
  const withStorage = resolvePlatform({ platform: 'darwin', facts: { encryptionAvailable: true } });
  const { call, dialogCalls, toolPolicyStore } = await setup(t, { platformCapabilities: withStorage, safeStorageAvailable: false });
  const result = await call(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, makeSender(), false, OPEN);
  assert.equal(result.ok, false);
  assert.equal(result.error?.key, 'permissions.error.sandboxOffNeedsEncryption');
  assert.equal(dialogCalls.length, 0, 'no confirmation that leads nowhere');
  assert.deepEqual((await toolPolicyStore.read()).unsandboxedWorkspaces, []);
});

test('on Windows the overview says there is no sandbox, whatever the detection said', async (t) => {
  const { call } = await setup(t, { platform: 'win32' });
  const overview = await call(REQ.TOOL_PERMISSIONS_GET_SANDBOX_OVERVIEW, makeSender());
  assert.equal(overview.sandbox.reason, 'platform');
});

test('the overview lists the sandbox session allowances of the open workspace only', async (t) => {
  const { call, sessionGrants } = await setup(t);
  sessionGrants.grant({ scopeKey: 's', tool: 'shell_execute', targets: [], riskClasses: ['execute'], chatId: 'chat-1', sandbox: { kind: 'network', path: 'pypi.org:443' }, scope: { key: 'approval.scope.network', params: {} } });
  sessionGrants.grant({ scopeKey: 's', tool: 'write_file', targets: ['a'], riskClasses: ['write'], chatId: 'chat-1' });
  sessionGrants.grant({ scopeKey: 't', tool: 'shell_execute', targets: [], riskClasses: ['execute'], chatId: 'elsewhere', sandbox: { kind: 'write', path: '/tmp/x' } });
  const overview = await call(REQ.TOOL_PERMISSIONS_GET_SANDBOX_OVERVIEW, makeSender());
  assert.equal(overview.sessionGrants.length, 1);
  assert.equal(overview.sessionGrants[0].sandbox, 'network');
  assert.equal(overview.sessionGrants[0].chatTitle, 'Fix the build');
});

// ── Which root the renderer may name ───────────────────────────────────────

test('a workspace that is not open can be changed — but only one main already holds a setting for', async (t) => {
  const { call, toolPolicyStore, confirmed, dialogCalls } = await setup(t);
  await toolPolicyStore.addWorkspaceHosts(OTHER, ['huggingface.co:443'], confirmed(CONFIRMATION_ACTIONS.WORKSPACE_HOSTS, OTHER));
  const sender = makeSender();
  const off = await call(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, sender, false, OTHER);
  assert.equal(off.ok, true);
  assert.match(dialogCalls.at(-1).detail, /In \/Users\/u\/invoice-tool, shell_execute and run_python/, 'the dialog names the folder');
  assert.equal(await toolPolicyStore.isWorkspaceSandboxDisabled(OTHER), true);
  assert.equal(await toolPolicyStore.isWorkspaceSandboxDisabled(OPEN), false);

  const madeUp = await call(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, sender, false, '/etc');
  assert.equal(madeUp.ok, false);
  assert.deepEqual(madeUp.error, { key: 'permissions.error.noWorkspace' });
  assert.equal(await toolPolicyStore.isWorkspaceSandboxDisabled('/etc'), false);
  assert.equal((await call(REQ.TOOL_PERMISSIONS_REMOVE_WORKSPACE_HOST, sender, 'huggingface.co:443', '/etc')).ok, false);
  assert.equal((await call(REQ.TOOL_PERMISSIONS_REMOVE_WORKSPACE_HOST, sender, 'huggingface.co:443', OTHER)).ok, true);
});

// ── Program allowances per scope ───────────────────────────────────────────

test('a program allowance for this workspace is confirmed for exactly that folder', async (t) => {
  const { call, toolPolicyStore, dialogCalls } = await setup(t);
  const sender = makeSender();
  const res = await call(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, sender, { program: 'gh', domains: ['api.github.com'], scope: 'workspace', root: OPEN });
  assert.equal(res.ok, true);
  assert.equal(res.root, OPEN);
  assert.match(dialogCalls[0].detail, /Whenever a command runs \/opt\/homebrew\/bin\/gh on its own in workspace ~\/garden-planner:/);
  assert.deepEqual((await toolPolicyStore.readProgramAllowances(OPEN)).map((entry) => entry.path), [GH_PATH]);
  assert.deepEqual(await toolPolicyStore.readProgramAllowances(OTHER), []);
  // Moving it to every workspace widens it: asked again, naming every workspace.
  const moved = await call(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, sender, {
    program: 'gh', domains: ['api.github.com'], scope: 'global', previousPath: GH_PATH, previousScope: 'workspace', previousRoot: OPEN,
  });
  assert.equal(moved.ok, true);
  assert.equal(dialogCalls.length, 2);
  assert.match(dialogCalls[1].detail, /on its own, in any workspace:/);
  const state = await toolPolicyStore.read();
  assert.deepEqual(state.workspaceProgramAllowances, {});
  assert.deepEqual(state.programAllowances.map((entry) => entry.path), [GH_PATH]);
  // Back to one workspace only takes rights away: no dialog.
  const back = await call(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, sender, {
    program: 'gh', domains: ['api.github.com'], scope: 'workspace', root: OPEN, previousPath: GH_PATH, previousScope: 'global',
  });
  assert.equal(back.ok, true);
  assert.equal(dialogCalls.length, 2);
  // And removed from its scope.
  assert.equal((await call(REQ.TOOL_PERMISSIONS_REMOVE_PROGRAM_ALLOWANCE, sender, GH_PATH, { scope: 'workspace', root: OPEN })).ok, true);
  assert.deepEqual(await toolPolicyStore.readProgramAllowances(OPEN), []);
});

test('a caller that names no scope still means every workspace, as before #1119', async (t) => {
  const { call, toolPolicyStore } = await setup(t);
  const res = await call(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, makeSender(), { program: 'gh', domains: ['api.github.com'] });
  assert.equal(res.ok, true);
  assert.deepEqual((await toolPolicyStore.read()).programAllowances.map((entry) => entry.path), [GH_PATH]);
});

// ── Hosts ───────────────────────────────────────────────────────────────────

test('a host for every workspace: only what a card could offer, confirmed in its own dialog', async (t) => {
  const { call, toolPolicyStore, dialogCalls } = await setup(t, { dialogResponse: 1 });
  const sender = makeSender();
  const shared = await call(REQ.TOOL_PERMISSIONS_ADD_HOSTS, sender, { hosts: ['*.github.io'], scope: 'global' });
  assert.equal(shared.ok, false);
  assert.deepEqual(shared.error, { key: 'permissions.hosts.error.invalid' });
  assert.equal(dialogCalls.length, 0, 'nothing asked for a host that cannot be kept');
  const cancelled = await call(REQ.TOOL_PERMISSIONS_ADD_HOSTS, sender, { hosts: ['gitlab.example.com:22'], scope: 'global' });
  assert.equal(cancelled.code, 'cancelled');
  assert.equal(dialogCalls[0].message, 'Keep these hosts open in every workspace?');
  assert.match(dialogCalls[0].detail, /in every folder — also folders you open later — may connect to:\n\ngitlab\.example\.com:22/);
  assert.match(dialogCalls[0].detail, /under Settings › Tools › Security/);
  assert.deepEqual((await toolPolicyStore.read()).globalHosts, []);
});

test('hosts confirmed for every workspace or one workspace land in that scope; closing asks nothing', async (t) => {
  const { call, toolPolicyStore, dialogCalls } = await setup(t);
  const sender = makeSender();
  assert.equal((await call(REQ.TOOL_PERMISSIONS_ADD_HOSTS, sender, { hosts: ['gitlab.example.com:22'], scope: 'global' })).ok, true);
  assert.equal((await call(REQ.TOOL_PERMISSIONS_ADD_HOSTS, sender, { hosts: ['huggingface.co:443'], scope: 'workspace', root: OPEN })).ok, true);
  assert.match(dialogCalls[1].detail, /in workspace \/Users\/u\/garden-planner may connect to/);
  const state = await toolPolicyStore.read();
  assert.deepEqual(state.globalHosts, ['gitlab.example.com:22']);
  assert.deepEqual(state.workspaceHosts, { [OPEN]: ['huggingface.co:443'] });
  assert.equal(sender.sent.at(-1).channel, PUSH.TOOL_PERMISSIONS_CHANGED);
  assert.equal((await call(REQ.TOOL_PERMISSIONS_REMOVE_GLOBAL_HOST, sender, 'gitlab.example.com:22')).ok, true);
  assert.equal(dialogCalls.length, 2);
  assert.deepEqual((await toolPolicyStore.read()).globalHosts, []);
});

// ── New workspaces ──────────────────────────────────────────────────────────

test('new workspaces without the sandbox: asked first; the folders known by then keep their setting', async (t) => {
  const { call, toolPolicyStore, dialogCalls } = await setup(t, { knownWorkspaces: [OTHER] });
  const sender = makeSender();
  const res = await call(REQ.TOOL_PERMISSIONS_SET_NEW_WORKSPACE_SANDBOX, sender, false);
  assert.equal(res.ok, true);
  assert.equal(dialogCalls[0].message, 'Start new workspaces without sandbox?');
  assert.match(dialogCalls[0].detail, /Workspaces you already have keep their setting/);
  assert.equal((await toolPolicyStore.noteWorkspaceOpened(OTHER)).changed, false, 'a recent folder is no new one');
  assert.equal((await toolPolicyStore.noteWorkspaceOpened(OPEN)).changed, false, 'nor the open one');
  assert.equal((await toolPolicyStore.noteWorkspaceOpened('/Users/u/brand-new')).changed, true);
  // Back on asks nothing.
  assert.equal((await call(REQ.TOOL_PERMISSIONS_SET_NEW_WORKSPACE_SANDBOX, sender, true)).ok, true);
  assert.equal(dialogCalls.length, 1);
});

// ── Resets ──────────────────────────────────────────────────────────────────

test('reset sandbox for a workspace asks nothing; reset everywhere asks first', async (t) => {
  let answer = 0;
  const { call, toolPolicyStore, dialogCalls, confirmed } = await setup(t, { dialogResponse: () => answer });
  await toolPolicyStore.setWorkspaceSandbox(OTHER, false, confirmed(CONFIRMATION_ACTIONS.SANDBOX_OFF, OTHER));
  await toolPolicyStore.addGlobalHosts(['gitlab.example.com:22'], confirmed(CONFIRMATION_ACTIONS.GLOBAL_HOSTS, 'gitlab.example.com:22'));
  const sender = makeSender();
  assert.equal((await call(REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_SANDBOX, sender, OTHER)).ok, true);
  assert.equal(dialogCalls.length, 0);
  assert.equal(await toolPolicyStore.isWorkspaceSandboxDisabled(OTHER), false);
  assert.equal((await call(REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_SANDBOX, sender, '/etc')).ok, false, 'not a path main does not know');

  answer = 1;
  const cancelled = await call(REQ.TOOL_PERMISSIONS_RESET_SANDBOX_EVERYWHERE, sender);
  assert.equal(cancelled.code, 'cancelled');
  assert.equal(dialogCalls[0].message, 'Reset the sandbox everywhere?');
  assert.deepEqual((await toolPolicyStore.read()).globalHosts, ['gitlab.example.com:22']);
  answer = 0;
  assert.equal((await call(REQ.TOOL_PERMISSIONS_RESET_SANDBOX_EVERYWHERE, sender)).ok, true);
  assert.deepEqual((await toolPolicyStore.read()).globalHosts, []);
});
