// Scopes of the sandbox grants (#1119): program allowances for one workspace
// or for every workspace, hosts kept open everywhere, the default for new
// workspaces — and the migration of the allowances stored before, which were
// all global.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createToolPolicyStore, POLICY_FILENAME, POLICY_KEY_FILENAME, MAX_GLOBAL_HOSTS } = require('../src/main/services/tool-policy-store');
const { CONFIRMATION_ACTIONS, createConfirmationReceipts, programAllowanceSubject, globalHostsSubject } = require('../src/application/permissions/user-confirmation');
const { combineProgramAllowances } = require('../src/shared/contracts/program-allowances');
const { removeTempDir } = require('./helpers/temp-dir');

const CONFIRM_ALL = { redeem: () => true };
const WS = '/home/u/garden-planner';
const OTHER = '/home/u/invoice-tool';
const GH = { path: '/opt/bin/gh', domains: ['api.github.com'], writePaths: [], trustd: true };
const TODO = { path: '/home/u/bin/ms-todo-cli', domains: ['graph.microsoft.com'], writePaths: ['/home/u/.cache/todo'], trustd: false };

function makeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('bad cipher');
      return s.slice(4);
    },
  };
}

async function makeStore(t, { receipts = CONFIRM_ALL, available = true, dir: given = null } = {}) {
  const dir = given || await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-scopes-'));
  if (!given) t.after(() => removeTempDir(dir));
  const store = createToolPolicyStore({
    confirmationReceipts: receipts,
    app: { getPath: () => dir },
    safeStorage: makeSafeStorage(available),
    fs,
    path,
    crypto,
    log: { warn() {} },
    now: () => 1000,
  });
  return { dir, store };
}

/** Rewrites the stored payload and signs it with the store's own key, as an older version would have. */
async function writeSignedPayload(dir, payload) {
  const raw = await fs.readFile(path.join(dir, POLICY_KEY_FILENAME), 'utf8');
  const key = Buffer.from(Buffer.from(raw.trim(), 'base64').toString('utf8').slice(4), 'hex');
  const serialized = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', key).update(serialized).digest('hex');
  await fs.writeFile(path.join(dir, POLICY_FILENAME), JSON.stringify({ version: 1, payload, signature }), 'utf8');
}

// ── Migration ───────────────────────────────────────────────────────────────

test('migration: allowances stored before #1119 apply in every workspace, and the file stays valid', async (t) => {
  const { dir, store } = await makeStore(t);
  await store.read();
  // What 1.25 wrote: no per-workspace allowances, no global hosts, no default for new workspaces.
  await writeSignedPayload(dir, {
    revision: 4,
    mode: 'smart',
    globalRules: [],
    workspaceRules: {},
    sensitivePathPatterns: [],
    unsandboxedWorkspaces: [],
    programAllowances: [GH, TODO],
    workspaceModes: {},
    workspaceHosts: { [WS]: ['huggingface.co:443'] },
    autoChats: [],
    legacyWriteMigrated: false,
    updatedAt: 900,
  });
  const state = await store.read();
  assert.equal(state.integrity, 'ok', 'the old signature still holds');
  assert.deepEqual(state.programAllowances.map((entry) => entry.path), [GH.path, TODO.path]);
  assert.deepEqual(state.workspaceProgramAllowances, {});
  assert.deepEqual(state.globalHosts, []);
  assert.equal(state.newWorkspaceSandboxOff, false);
  // Nothing that worked stops working: every folder still gets them …
  assert.deepEqual((await store.readProgramAllowances(WS)).map((entry) => entry.path), [GH.path, TODO.path]);
  assert.deepEqual((await store.readProgramAllowances(OTHER)).map((entry) => entry.path), [GH.path, TODO.path]);
  // … and hosts kept open stay with their workspace.
  assert.deepEqual(state.workspaceHosts, { [WS]: ['huggingface.co:443'] });

  // The next change writes the new fields and keeps the old allowances global.
  const next = await store.setProgramAllowance({ ...GH, path: '/usr/bin/terraform' }, { root: WS });
  assert.equal(next.ok, true);
  assert.equal(next.integrity, 'ok');
  assert.deepEqual(next.programAllowances.map((entry) => entry.path), [GH.path, TODO.path]);
  assert.deepEqual(Object.keys(next.workspaceProgramAllowances), [WS]);
});

// ── Program allowances per workspace ───────────────────────────────────────

test('program allowances: one for a workspace applies there only, a global one everywhere', async (t) => {
  const { store } = await makeStore(t);
  await store.setProgramAllowance(GH, { root: WS });
  await store.setProgramAllowance(TODO);
  assert.deepEqual((await store.readProgramAllowances(WS)).map((entry) => entry.path), [TODO.path, GH.path]);
  assert.deepEqual((await store.readProgramAllowances(OTHER)).map((entry) => entry.path), [TODO.path]);
  assert.deepEqual((await store.readProgramAllowances()).map((entry) => entry.path), [TODO.path], 'without a folder only the global ones');
  // Removing it from the workspace leaves the global list alone.
  const removed = await store.removeProgramAllowance(GH.path, { root: WS });
  assert.deepEqual(removed.workspaceProgramAllowances, {});
  assert.deepEqual(removed.programAllowances.map((entry) => entry.path), [TODO.path]);
});

test('program allowances: a global and a workspace allowance for the same program add up there', async (t) => {
  const { store } = await makeStore(t);
  await store.setProgramAllowance({ path: GH.path, domains: ['api.github.com'], writePaths: [], trustd: false });
  await store.setProgramAllowance({ path: GH.path, domains: ['uploads.github.com'], writePaths: ['/home/u/.config/gh'], trustd: true }, { root: WS });
  const [here] = await store.readProgramAllowances(WS);
  assert.deepEqual(here, {
    path: GH.path,
    domains: ['api.github.com', 'uploads.github.com'],
    writePaths: ['/home/u/.config/gh'],
    trustd: true,
  });
  const [elsewhere] = await store.readProgramAllowances(OTHER);
  assert.deepEqual(elsewhere.domains, ['api.github.com']);
  assert.equal(elsewhere.trustd, false);
});

test('program allowances: a pair that would add up to more than one allowance is refused, not cut', async (t) => {
  const { store } = await makeStore(t);
  const many = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}.example.com`);
  await store.setProgramAllowance({ path: GH.path, domains: many('a', 15), writePaths: [], trustd: false });
  const refused = await store.setProgramAllowance({ path: GH.path, domains: many('b', 6), writePaths: [], trustd: false }, { root: WS });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.key, 'permissions.allowance.error.combinedTooLarge');
  // Domains both name count once.
  const fits = await store.setProgramAllowance({ path: GH.path, domains: [...many('a', 15), ...many('b', 5)], writePaths: [], trustd: false }, { root: WS });
  assert.equal(fits.ok, true);
  assert.equal((await store.readProgramAllowances(WS))[0].domains.length, 20);
  // The other way round as well: a global edit is checked against every workspace.
  const wider = await store.setProgramAllowance({ path: GH.path, domains: many('c', 10), writePaths: [], trustd: false });
  assert.equal(wider.ok, false);
  assert.deepEqual(combineProgramAllowances([], [{ ...GH }]).map((entry) => entry.path), [GH.path]);
});

test('program allowances: moving one between scopes — narrowing from every workspace, widening to it', async (t) => {
  const { dir } = await makeStore(t);
  let now = 0;
  const receipts = createConfirmationReceipts({ now: () => now });
  const { store } = await makeStore(t, { receipts, dir });
  // Global first, confirmed for the global scope.
  const forAll = receipts.issue({ action: CONFIRMATION_ACTIONS.PROGRAM_ALLOWANCE, subject: programAllowanceSubject(GH.path, null) });
  assert.equal((await store.setProgramAllowance(GH, { confirmation: forAll })).ok, true);
  // To one workspace: only takes rights away, so no receipt.
  const narrowed = await store.setProgramAllowance(GH, { root: WS, replacePath: GH.path, replaceRoot: null });
  assert.equal(narrowed.ok, true);
  assert.deepEqual(narrowed.programAllowances, []);
  assert.deepEqual(narrowed.workspaceProgramAllowances[WS].map((entry) => entry.path), [GH.path]);
  // Back to every workspace widens: a receipt for the workspace does not do.
  const wrong = receipts.issue({ action: CONFIRMATION_ACTIONS.PROGRAM_ALLOWANCE, subject: programAllowanceSubject(GH.path, WS) });
  const refused = await store.setProgramAllowance(GH, { root: null, replacePath: GH.path, replaceRoot: WS, confirmation: wrong });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.key, 'permissions.error.notConfirmed');
  const right = receipts.issue({ action: CONFIRMATION_ACTIONS.PROGRAM_ALLOWANCE, subject: programAllowanceSubject(GH.path, null) });
  const widened = await store.setProgramAllowance(GH, { root: null, replacePath: GH.path, replaceRoot: WS, confirmation: right });
  assert.equal(widened.ok, true);
  assert.deepEqual(widened.workspaceProgramAllowances, {});
  assert.deepEqual(widened.programAllowances.map((entry) => entry.path), [GH.path]);
  now += 1;
});

test('program allowances: a confirmation for one workspace is no confirmation for another', async (t) => {
  const receipts = createConfirmationReceipts();
  const { store } = await makeStore(t, { receipts });
  const forWs = receipts.issue({ action: CONFIRMATION_ACTIONS.PROGRAM_ALLOWANCE, subject: programAllowanceSubject(GH.path, WS) });
  const refused = await store.setProgramAllowance(GH, { root: OTHER, confirmation: forWs });
  assert.equal(refused.ok, false);
  const again = receipts.issue({ action: CONFIRMATION_ACTIONS.PROGRAM_ALLOWANCE, subject: programAllowanceSubject(GH.path, WS) });
  assert.equal((await store.setProgramAllowance(GH, { root: WS, confirmation: again })).ok, true);
});

test('program allowances: a failed signature drops those of every workspace as well', async (t) => {
  const { dir, store } = await makeStore(t);
  await store.setProgramAllowance(GH, { root: WS });
  const filePath = path.join(dir, POLICY_FILENAME);
  const file = JSON.parse(await fs.readFile(filePath, 'utf8'));
  file.payload.workspaceProgramAllowances[OTHER] = [TODO];
  await fs.writeFile(filePath, JSON.stringify(file), 'utf8');
  const state = await store.read();
  assert.equal(state.integrity, 'invalid');
  assert.deepEqual(state.workspaceProgramAllowances, {});
  assert.deepEqual(await store.readProgramAllowances(WS), []);
});

test('program allowances: resetting the workspace rules removes the workspace\'s own, not the global ones', async (t) => {
  const { store } = await makeStore(t);
  await store.setProgramAllowance(GH, { root: WS });
  await store.setProgramAllowance(TODO);
  const reset = await store.resetWorkspaceRules(WS);
  assert.deepEqual(reset.workspaceProgramAllowances, {});
  assert.deepEqual(reset.programAllowances.map((entry) => entry.path), [TODO.path]);
});

// ── Hosts open everywhere ───────────────────────────────────────────────────

test('global hosts: kept in the form a card offers, each once, confirmed for exactly these hosts', async (t) => {
  const receipts = createConfirmationReceipts();
  const { store } = await makeStore(t, { receipts });
  const hosts = ['gitlab.example.com:22', '*.pytorch.org'];
  const wrong = receipts.issue({ action: CONFIRMATION_ACTIONS.GLOBAL_HOSTS, subject: globalHostsSubject(['gitlab.example.com:22']) });
  assert.equal((await store.addGlobalHosts(hosts, { confirmation: wrong })).ok, false);
  const right = receipts.issue({ action: CONFIRMATION_ACTIONS.GLOBAL_HOSTS, subject: globalHostsSubject(hosts) });
  const added = await store.addGlobalHosts(hosts, { confirmation: right });
  assert.equal(added.ok, true);
  assert.deepEqual(added.globalHosts, hosts);
  const removed = await store.removeGlobalHost('*.pytorch.org');
  assert.deepEqual(removed.globalHosts, ['gitlab.example.com:22']);
});

test('global hosts: no shared domain, no free text, at most a fixed number', async (t) => {
  const { store } = await makeStore(t);
  assert.equal((await store.addGlobalHosts(['*.github.io'])).ok, false, 'a shared domain only host by host');
  assert.equal((await store.addGlobalHosts(['https://example.com/x'])).ok, false);
  const many = Array.from({ length: MAX_GLOBAL_HOSTS }, (_, i) => `h${i}.example.com:443`);
  assert.equal((await store.addGlobalHosts(many)).ok, true);
  const over = await store.addGlobalHosts(['one-more.example.com:443']);
  assert.equal(over.ok, false);
  assert.equal(over.error.key, 'permissions.globalHosts.error.tooMany');
});

test('global hosts: a failed signature drops them; resetting everything does too', async (t) => {
  const { dir, store } = await makeStore(t);
  await store.addGlobalHosts(['gitlab.example.com:22']);
  const filePath = path.join(dir, POLICY_FILENAME);
  const file = JSON.parse(await fs.readFile(filePath, 'utf8'));
  file.payload.globalHosts.push('evil.example.com:443');
  await fs.writeFile(filePath, JSON.stringify(file), 'utf8');
  assert.deepEqual((await store.read()).globalHosts, []);

  const { store: fresh } = await makeStore(t);
  await fresh.addGlobalHosts(['gitlab.example.com:22']);
  assert.deepEqual((await fresh.resetWorkspaceRules(WS)).globalHosts, ['gitlab.example.com:22']);
  assert.deepEqual((await fresh.resetAll()).globalHosts, []);
});

test('global hosts: without safeStorage none can be kept', async (t) => {
  const { store } = await makeStore(t, { available: false });
  const refused = await store.addGlobalHosts(['gitlab.example.com:22']);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.key, 'permissions.workspaceHosts.error.needsEncryption');
});

// ── New workspaces ──────────────────────────────────────────────────────────

test('new workspaces: the sandbox starts on, and opening a folder writes nothing', async (t) => {
  const { store } = await makeStore(t);
  const before = (await store.read()).policyVersion;
  const noted = await store.noteWorkspaceOpened(WS);
  assert.equal(noted.changed, false);
  assert.equal((await store.read()).policyVersion, before);
  assert.equal(await store.isWorkspaceSandboxDisabled(WS), false);
});

test('new workspaces: with the default off, a folder seen for the first time starts without the sandbox', async (t) => {
  const { store } = await makeStore(t);
  const off = await store.setNewWorkspaceSandbox(false, { knownRoots: [OTHER] });
  assert.equal(off.ok, true);
  assert.equal(off.newWorkspaceSandboxOff, true);
  // A folder that was there before keeps its setting …
  assert.equal((await store.noteWorkspaceOpened(OTHER)).changed, false);
  assert.equal(await store.isWorkspaceSandboxDisabled(OTHER), false);
  // … a new one starts without the sandbox, written out so it shows in the settings.
  assert.equal((await store.noteWorkspaceOpened(WS)).changed, true);
  assert.equal(await store.isWorkspaceSandboxDisabled(WS), true);
  // Switched back on by hand, it stays on the next time it is opened.
  await store.setWorkspaceSandbox(WS, true);
  assert.equal((await store.noteWorkspaceOpened(WS)).changed, false);
  assert.equal(await store.isWorkspaceSandboxDisabled(WS), false);
});

test('new workspaces: the default back on keeps what folders started with', async (t) => {
  const { store } = await makeStore(t);
  await store.setNewWorkspaceSandbox(false);
  await store.noteWorkspaceOpened(WS);
  const on = await store.setNewWorkspaceSandbox(true);
  assert.equal(on.newWorkspaceSandboxOff, false);
  assert.equal(await store.isWorkspaceSandboxDisabled(WS), true, 'existing workspaces keep their setting');
  assert.equal((await store.noteWorkspaceOpened(OTHER)).changed, false);
  assert.equal(await store.isWorkspaceSandboxDisabled(OTHER), false);
});

test('new workspaces: off needs a receipt and safeStorage; a failed signature turns it back on', async (t) => {
  const receipts = createConfirmationReceipts();
  const { store } = await makeStore(t, { receipts });
  const refused = await store.setNewWorkspaceSandbox(false);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.key, 'permissions.error.notConfirmed');
  const receipt = receipts.issue({ action: CONFIRMATION_ACTIONS.NEW_WORKSPACE_SANDBOX_OFF, subject: '' });
  assert.equal((await store.setNewWorkspaceSandbox(false, { confirmation: receipt })).ok, true);

  const { store: locked } = await makeStore(t, { available: false });
  assert.equal((await locked.setNewWorkspaceSandbox(false)).ok, false);

  const { dir, store: tampered } = await makeStore(t);
  await tampered.setNewWorkspaceSandbox(false);
  const filePath = path.join(dir, POLICY_FILENAME);
  const file = JSON.parse(await fs.readFile(filePath, 'utf8'));
  file.payload.knownWorkspaces = ['/somewhere/else'];
  await fs.writeFile(filePath, JSON.stringify(file), 'utf8');
  assert.equal((await tampered.read()).newWorkspaceSandboxOff, false);
  assert.equal((await tampered.noteWorkspaceOpened(WS)).changed, false, 'a broken file starts nothing without the sandbox');
});

// ── Resets ──────────────────────────────────────────────────────────────────

test('reset sandbox for a workspace: on again, its programs and hosts gone, the global ones stay', async (t) => {
  const { store } = await makeStore(t);
  await store.setWorkspaceSandbox(WS, false);
  await store.setProgramAllowance(GH, { root: WS });
  await store.setProgramAllowance(TODO);
  await store.addWorkspaceHosts(WS, ['huggingface.co:443']);
  await store.addGlobalHosts(['gitlab.example.com:22']);
  await store.setWorkspaceMode(WS, 'ask-all');
  const reset = await store.resetWorkspaceSandbox(WS);
  assert.equal(reset.ok, true);
  assert.deepEqual(reset.unsandboxedWorkspaces, []);
  assert.deepEqual(reset.workspaceProgramAllowances, {});
  assert.deepEqual(reset.workspaceHosts, {});
  assert.deepEqual(reset.programAllowances.map((entry) => entry.path), [TODO.path]);
  assert.deepEqual(reset.globalHosts, ['gitlab.example.com:22']);
  assert.equal(reset.workspaceModes[WS], 'ask-all', 'the default mode is not the sandbox\'s');
});

test('reset the sandbox everywhere: every workspace on, every allowance gone, the default on', async (t) => {
  const { store } = await makeStore(t);
  await store.setWorkspaceSandbox(WS, false);
  await store.setProgramAllowance(GH, { root: OTHER });
  await store.setProgramAllowance(TODO);
  await store.addWorkspaceHosts(WS, ['huggingface.co:443']);
  await store.addGlobalHosts(['gitlab.example.com:22']);
  await store.setNewWorkspaceSandbox(false);
  await store.setMode('ask-all');
  const reset = await store.resetSandboxEverywhere();
  assert.equal(reset.ok, true);
  assert.deepEqual(reset.unsandboxedWorkspaces, []);
  assert.deepEqual(reset.programAllowances, []);
  assert.deepEqual(reset.workspaceProgramAllowances, {});
  assert.deepEqual(reset.workspaceHosts, {});
  assert.deepEqual(reset.globalHosts, []);
  assert.equal(reset.newWorkspaceSandboxOff, false);
  assert.equal(reset.mode, 'ask-all', 'the rest of the rules is not the sandbox\'s');
});
