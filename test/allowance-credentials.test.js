// Credentials on a program allowance (#1262): a variable such as GH_TOKEN
// whose value is kept encrypted next to the allowances, handed only to a
// sandboxed run that matches — the program, and the workspace when the
// allowance is one workspace's — and masked in everything that run prints.
// The real run (`gh api user` in the macOS sandbox) is looked at by
// e2e/manual-allowance-credentials.mjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');

const {
  CREDENTIAL_NAME_PROBLEMS,
  CREDENTIAL_VALUE_PROBLEMS,
  credentialNameProblem,
  credentialValueProblem,
  suggestedCredentialName,
  lockedConfigDirVariable,
  normalizeProgramAllowance,
  combineProgramAllowances,
  combinationTooLarge,
  grantsSomething,
  isNarrowing,
} = require('../src/shared/contracts/program-allowances');
const { normalizePolicyPayload, failSafePayload } = require('../src/application/permissions/tool-policy-rules');
const { createToolPolicyStore, POLICY_FILENAME } = require('../src/main/services/tool-policy-store');
const { createShellRunnerService, PROBE_MARKER } = require('../src/main/services/shell-runner-service');
const { createProgramAllowances } = require('../src/main/services/program-allowances-service');
const { createOwnSecrets } = require('../src/main/services/own-secrets');
const { createWorkspaceToolRegistry } = require('../src/application/tools/workspace-tool-registry');
const { programAllowanceDialog } = require('../src/main/services/tool-permission-dialogs');
const { createTranslator } = require('../src/shared/i18n');
const { removeTempDir } = require('./helpers/temp-dir');

const CONFIRM_ALL = { redeem: () => true };
const GH = '/opt/bin/gh';
const WS = '/home/u/garden-planner';
const OTHER = '/home/u/invoice-tool';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const ID_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const ID_B = '22222222-bbbb-4bbb-8bbb-222222222222';

function makeSafeStorage({ available = true, unreadable = () => false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('enc:') || unreadable(s.slice(4))) throw new Error('bad cipher');
      return s.slice(4);
    },
  };
}

async function makeStore(t, { secretStore = makeSafeStorage(), dir: given = null } = {}) {
  const dir = given || await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-credentials-'));
  if (!given) t.after(() => removeTempDir(dir));
  const store = createToolPolicyStore({
    confirmationReceipts: CONFIRM_ALL,
    userDataPath: dir,
    secretStore,
    fs,
    path,
    crypto,
    log: { warn() {} },
    now: () => 1000,
  });
  return { dir, store };
}

const gh = (credentials = [], extra = {}) => ({ path: GH, domains: ['api.github.com'], writePaths: [], trustd: true, credentials, ...extra });

// ── Contract ────────────────────────────────────────────────────────────────

test('a variable name is a POSIX name the shell and the sandbox do not set', () => {
  assert.equal(credentialNameProblem('GH_TOKEN'), null);
  assert.equal(credentialNameProblem('_private_token2'), null);
  assert.equal(credentialNameProblem(''), CREDENTIAL_NAME_PROBLEMS.EMPTY);
  assert.equal(credentialNameProblem('   '), CREDENTIAL_NAME_PROBLEMS.EMPTY);
  for (const bad of ['1GH', 'GH-TOKEN', 'GH TOKEN', 'GH=TOKEN', 'ÄTOKEN', 'X'.repeat(65)]) {
    assert.equal(credentialNameProblem(bad), CREDENTIAL_NAME_PROBLEMS.INVALID, bad);
  }
  for (const reserved of ['PATH', 'path', 'HOME', 'HTTPS_PROXY', 'https_proxy', 'BASH_ENV', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'SNOTRA_SSH_RELAY', 'SSH_AUTH_SOCK']) {
    assert.equal(credentialNameProblem(reserved), CREDENTIAL_NAME_PROBLEMS.RESERVED, reserved);
  }
});

test('a value is long enough to be masked and fits in one environment variable', () => {
  assert.equal(credentialValueProblem(TOKEN), null);
  assert.equal(credentialValueProblem(`  ${TOKEN}\n`), null, 'what a paste brings along around it does not count');
  assert.equal(credentialValueProblem(''), CREDENTIAL_VALUE_PROBLEMS.EMPTY);
  assert.equal(credentialValueProblem('short'), CREDENTIAL_VALUE_PROBLEMS.SHORT);
  assert.equal(credentialValueProblem('x'.repeat(4097)), CREDENTIAL_VALUE_PROBLEMS.LONG);
  assert.equal(credentialValueProblem('abcdefgh\nijklmnop'), CREDENTIAL_VALUE_PROBLEMS.INVALID);
});

test('the dialog proposes the variable the program reads, or <PROGRAM>_TOKEN', () => {
  assert.equal(suggestedCredentialName('gh'), 'GH_TOKEN');
  assert.equal(suggestedCredentialName('/opt/homebrew/bin/glab'), 'GITLAB_TOKEN');
  assert.equal(suggestedCredentialName('/usr/local/bin/my-cli'), 'MY_CLI_TOKEN');
  assert.equal(suggestedCredentialName(''), '');
  assert.equal(lockedConfigDirVariable('/opt/homebrew/bin/gh'), 'GH_CONFIG_DIR');
  assert.equal(lockedConfigDirVariable('/opt/homebrew/bin/glab'), 'GLAB_CONFIG_DIR');
  assert.equal(lockedConfigDirVariable('/usr/bin/curl'), '');
});

test('an entry keeps name and id of each credential, each once, sorted — never a value', () => {
  const entry = normalizeProgramAllowance(gh([
    { name: 'Z_TOKEN', id: ID_B },
    { name: ' GH_TOKEN ', id: ID_A, value: TOKEN },
    { name: 'GH_TOKEN', id: '33333333-cccc' },
    { name: 'PATH', id: '44444444-dddd' },
    { name: 'OK_TOKEN', id: 'no' },
    { name: 'OTHER', id: ID_A },
  ]));
  assert.deepEqual(entry.credentials, [{ name: 'GH_TOKEN', id: ID_A }, { name: 'Z_TOKEN', id: ID_B }]);
  assert.equal(JSON.stringify(entry).includes(TOKEN), false);
  assert.deepEqual(normalizeProgramAllowance({ path: GH }).credentials, []);
  assert.equal(grantsSomething(normalizeProgramAllowance({ path: GH, credentials: [{ name: 'GH_TOKEN', id: ID_A }] })), true);
});

test('global and workspace credentials add up; the workspace wins on the same variable', () => {
  const global = gh([{ name: 'GH_TOKEN', id: ID_A }, { name: 'GH_HOST_TOKEN', id: '55555555-eeee' }]);
  const own = gh([{ name: 'GH_TOKEN', id: ID_B }]);
  const [combined] = combineProgramAllowances([global], [own]);
  assert.deepEqual(combined.credentials, [{ name: 'GH_HOST_TOKEN', id: '55555555-eeee' }, { name: 'GH_TOKEN', id: ID_B }]);

  const five = (prefix) => Array.from({ length: 3 }, (_, i) => ({ name: `${prefix}${i}`, id: `${prefix.toLowerCase()}0000000-${i}` }));
  assert.equal(combinationTooLarge(normalizeProgramAllowance(gh(five('A'))), normalizeProgramAllowance(gh(five('B')))), true);
  assert.equal(combinationTooLarge(normalizeProgramAllowance(gh(five('A'))), normalizeProgramAllowance(gh(five('A')))), false);
});

test('only dropping a credential narrows; a new or renamed one, or a new value, widens', () => {
  const before = normalizeProgramAllowance(gh([{ name: 'GH_TOKEN', id: ID_A }, { name: 'X_TOKEN', id: ID_B }]));
  assert.equal(isNarrowing(before, normalizeProgramAllowance(gh([{ name: 'GH_TOKEN', id: ID_A }]))), true);
  assert.equal(isNarrowing(before, normalizeProgramAllowance(gh([{ name: 'GH_TOKEN', id: '66666666-ffff' }]))), false, 'a new value');
  assert.equal(isNarrowing(before, normalizeProgramAllowance(gh([{ name: 'GITHUB_TOKEN', id: ID_A }]))), false, 'renamed');
});

test('the policy keeps a secret only while an allowance names it, and a credential only with its secret', () => {
  const payload = normalizePolicyPayload({
    programAllowances: [gh([{ name: 'GH_TOKEN', id: ID_A }, { name: 'LOST_TOKEN', id: ID_B }])],
    workspaceProgramAllowances: { [WS]: [gh([{ name: 'GH_TOKEN', id: '77777777-0000' }])] },
    allowanceSecrets: { [ID_A]: 'ZW5jOmFiYw==', '77777777-0000': 'ZW5jOmRlZg==', orphan: 'ZW5jOmdoaQ==', [ID_B]: 'not base64!' },
  });
  assert.deepEqual(Object.keys(payload.allowanceSecrets).sort(), [ID_A, '77777777-0000']);
  assert.deepEqual(payload.programAllowances[0].credentials, [{ name: 'GH_TOKEN', id: ID_A }]);
  assert.deepEqual(failSafePayload(payload).allowanceSecrets, {});
});

// ── Store ───────────────────────────────────────────────────────────────────

test('store: a new value is stored encrypted, out of every snapshot, and handed only to runs that match', async (t) => {
  const { dir, store } = await makeStore(t);
  const saved = await store.setProgramAllowance(gh([{ name: 'GH_TOKEN', id: ID_A }]), { root: WS, secrets: { [ID_A]: `  ${TOKEN} ` } });
  assert.equal(saved.ok, true, JSON.stringify(saved.error));
  const file = await fs.readFile(path.join(dir, POLICY_FILENAME), 'utf8');
  assert.equal(file.includes(TOKEN), false, 'never in clear on disk');
  assert.equal(JSON.stringify(await store.read()).includes('allowanceSecrets'), false, 'no snapshot carries the secrets');
  assert.deepEqual(saved.workspaceProgramAllowances[WS][0].credentials, [{ name: 'GH_TOKEN', id: ID_A }]);

  const approved = [{ name: 'GH_TOKEN', id: ID_A }];
  assert.deepEqual(await store.readAllowanceCredentials(GH, { root: WS, approved }), { env: { GH_TOKEN: TOKEN }, unavailable: [] });
  // Another workspace, no workspace, another program, a plan that names another id: nothing.
  assert.deepEqual((await store.readAllowanceCredentials(GH, { root: OTHER, approved })).env, {});
  assert.deepEqual((await store.readAllowanceCredentials(GH, { root: null, approved })).env, {});
  assert.deepEqual((await store.readAllowanceCredentials('/usr/bin/curl', { root: WS, approved })).env, {});
  assert.deepEqual((await store.readAllowanceCredentials(GH, { root: WS, approved: [{ name: 'GH_TOKEN', id: ID_B }] })).env, {});
  assert.deepEqual((await store.readAllowanceCredentials(GH, { root: WS })).env, {}, 'no plan, no token');
  assert.deepEqual(await store.readAllowanceSecretValues(), [TOKEN]);
});

test('store: a global credential reaches every workspace', async (t) => {
  const { store } = await makeStore(t);
  await store.setProgramAllowance(gh([{ name: 'GH_TOKEN', id: ID_A }]), { secrets: { [ID_A]: TOKEN } });
  const approved = [{ name: 'GH_TOKEN', id: ID_A }];
  assert.deepEqual((await store.readAllowanceCredentials(GH, { root: WS, approved })).env, { GH_TOKEN: TOKEN });
  assert.deepEqual((await store.readAllowanceCredentials(GH, { root: OTHER, approved })).env, { GH_TOKEN: TOKEN });
});

test('store: an edit keeps the stored value by id, a replaced one gets a new id, a foreign id is refused', async (t) => {
  const { store } = await makeStore(t);
  await store.setProgramAllowance(gh([{ name: 'GH_TOKEN', id: ID_A }]), { secrets: { [ID_A]: TOKEN } });
  // Renamed, value kept.
  const renamed = await store.setProgramAllowance(gh([{ name: 'GITHUB_TOKEN', id: ID_A }]), { replacePath: GH });
  assert.equal(renamed.ok, true);
  assert.deepEqual((await store.readAllowanceCredentials(GH, { approved: [{ name: 'GITHUB_TOKEN', id: ID_A }] })).env, { GITHUB_TOKEN: TOKEN });
  // Replaced: the old value is gone with its id.
  await store.setProgramAllowance(gh([{ name: 'GITHUB_TOKEN', id: ID_B }]), { replacePath: GH, secrets: { [ID_B]: 'ghp_second_token_value' } });
  assert.deepEqual(await store.readAllowanceSecretValues(), ['ghp_second_token_value']);
  // Another allowance cannot borrow that value by naming its id.
  const curl = { path: '/usr/bin/curl', domains: ['example.com'], writePaths: [], trustd: false, credentials: [{ name: 'GH_TOKEN', id: ID_B }] };
  const refused = await store.setProgramAllowance(curl);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.key, 'permissions.allowance.error.invalid');
  // A value too short to mask is refused here as well.
  const short = await store.setProgramAllowance(gh([{ name: 'GH_TOKEN', id: ID_A }]), { replacePath: GH, secrets: { [ID_A]: 'short' } });
  assert.equal(short.ok, false);
});

test('store: removing the allowance, or the credential, removes the secret', async (t) => {
  const { dir, store } = await makeStore(t);
  await store.setProgramAllowance(gh([{ name: 'GH_TOKEN', id: ID_A }]), { root: WS, secrets: { [ID_A]: TOKEN } });
  await store.setProgramAllowance(gh([]), { root: WS });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, POLICY_FILENAME), 'utf8')).payload.allowanceSecrets, {});

  await store.setProgramAllowance(gh([{ name: 'GH_TOKEN', id: ID_B }]), { root: WS, secrets: { [ID_B]: TOKEN } });
  await store.removeProgramAllowance(GH, { root: WS });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, POLICY_FILENAME), 'utf8')).payload.allowanceSecrets, {});
  assert.deepEqual(await store.readAllowanceSecretValues(), []);
});

test('store: a value that no longer decrypts is named as unavailable, not handed out', async (t) => {
  const { dir, store } = await makeStore(t);
  await store.setProgramAllowance(gh([{ name: 'GH_TOKEN', id: ID_A }]), { secrets: { [ID_A]: TOKEN } });
  // The signing key still opens (another keychain would fail the signature
  // and so drop the allowance as a whole); only the token's ciphertext does not.
  const { store: elsewhere } = await makeStore(t, { dir, secretStore: makeSafeStorage({ unreadable: (plain) => plain === TOKEN }) });
  assert.deepEqual(await elsewhere.readAllowanceCredentials(GH, { approved: [{ name: 'GH_TOKEN', id: ID_A }] }), { env: {}, unavailable: ['GH_TOKEN'] });
  assert.deepEqual(await elsewhere.readAllowanceSecretValues(), []);
});

test('store: without encrypted storage no credential is stored', async (t) => {
  const { store } = await makeStore(t, { secretStore: makeSafeStorage({ available: false }) });
  const refused = await store.setProgramAllowance(gh([{ name: 'GH_TOKEN', id: ID_A }]), { secrets: { [ID_A]: TOKEN } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.key, 'permissions.allowance.error.needsEncryption');
});

// ── What the dialog sends ───────────────────────────────────────────────────

test('prepareEntry: a typed value gets a new id and goes to the store apart from the entry', async () => {
  let n = 0;
  const service = createProgramAllowances({
    fs: { ...fs, constants: { X_OK: 1 }, realpath: async (p) => p, stat: async () => ({ isFile: () => true, isDirectory: () => false }), access: async () => {} },
    // POSIX paths on every runner: a program allowance only exists where there is a sandbox.
    path: path.posix,
    os: { homedir: () => '/home/u' },
    platform: 'darwin',
    readUserPath: async () => '/opt/bin',
    randomId: () => `aaaaaaaa-0000-4000-8000-00000000000${(n += 1)}`,
  });
  const base = { program: 'gh', domains: ['api.github.com'], writePaths: [], trustd: true };
  const fresh = await service.prepareEntry({ ...base, credentials: [{ name: 'GH_TOKEN', value: ` ${TOKEN} ` }, { name: 'KEPT_TOKEN', id: ID_A }] });
  assert.equal(fresh.ok, true, JSON.stringify(fresh.error));
  assert.deepEqual(fresh.entry.credentials, [{ name: 'GH_TOKEN', id: 'aaaaaaaa-0000-4000-8000-000000000001' }, { name: 'KEPT_TOKEN', id: ID_A }]);
  assert.deepEqual(fresh.secrets, { 'aaaaaaaa-0000-4000-8000-000000000001': TOKEN });
  assert.equal(JSON.stringify(fresh.entry).includes(TOKEN), false);

  const error = async (credentials) => (await service.prepareEntry({ ...base, credentials })).error;
  assert.equal((await error([{ name: '', value: TOKEN }])).key, 'permissions.allowance.error.credentialNameEmpty');
  assert.equal((await error([{ name: '9X', value: TOKEN }])).key, 'permissions.allowance.error.credentialNameInvalid');
  assert.equal((await error([{ name: 'PATH', value: TOKEN }])).key, 'permissions.allowance.error.credentialNameReserved');
  assert.equal((await error([{ name: 'A_TOKEN', value: TOKEN }, { name: 'A_TOKEN', value: TOKEN }])).key, 'permissions.allowance.error.credentialNameTwice');
  assert.equal((await error([{ name: 'A_TOKEN' }])).key, 'permissions.allowance.error.credentialValueEmpty');
  assert.equal((await error([{ name: 'A_TOKEN', value: 'short' }])).key, 'permissions.allowance.error.credentialValueShort');
  assert.equal((await error(Array.from({ length: 6 }, (_, i) => ({ name: `T${i}`, value: TOKEN })))).key, 'permissions.allowance.error.tooManyCredentials');
  // A credential alone is an allowance: the token is what the program needs.
  assert.equal((await service.prepareEntry({ program: 'gh', domains: [], writePaths: [], credentials: [{ name: 'GH_TOKEN', value: TOKEN }] })).ok, true);
});

test('the native dialog names the variable, never the value', () => {
  const entry = normalizeProgramAllowance(gh([{ name: 'GH_TOKEN', id: ID_A }]));
  const en = programAllowanceDialog(entry, createTranslator('en'), '/home/u', WS).detail;
  assert.match(en, /it gets your token in GH_TOKEN\. Whatever the program starts can read it\./);
  assert.match(programAllowanceDialog(entry, createTranslator('de'), '/home/u', WS).detail, /bekommt es deinen Token in GH_TOKEN/);
});

// ── The run ─────────────────────────────────────────────────────────────────

function fakeChild({ stdout = '', stderr = '' } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => {};
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', 0);
  });
  return child;
}

/** A shell runner whose sandbox isolates (or not) and whose child prints what `print` returns for its env. */
async function makeRunner(t, { isolated = true, print = () => ({}), read = null } = {}) {
  const runs = [];
  const sandbox = {
    prepare: async ({ command }) => (isolated
      ? { command: '/bin/sh', args: ['-c', command], env: { HTTPS_PROXY: 'http://127.0.0.1:1', GH_TOKEN_SHADOW: 'x' }, domains: ['api.github.com'], annotate: (s) => s, release() {} }
      : null),
    describe: () => ({ reason: 'dependencies', missing: ['socat'] }),
  };
  const reads = [];
  const service = createShellRunnerService({
    spawn: (command, args, options) => {
      if (args[0] === '-ilc' || args.includes('-ilc')) return fakeChild({ stdout: `${PROBE_MARKER}\n` });
      runs.push(options.env);
      return fakeChild(print(options.env));
    },
    os,
    fs,
    path,
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin', HOME: '/home/u' },
    sandbox,
    readAllowanceCredentials: read || (async (programPath, options) => {
      reads.push({ programPath, ...options });
      return { env: { GH_TOKEN: TOKEN }, unavailable: [] };
    }),
  });
  await service.detect();
  t.after(() => service.disposeSync());
  return { service, runs, reads };
}

const allowance = (credentials = [{ name: 'GH_TOKEN', id: ID_A }]) => ({ writePaths: [], trustd: true, path: GH, root: WS, credentials });

test('runner: an isolated run of the allowed program gets the token, an empty gh config, and the sandbox still wins', async (t) => {
  const { service, runs, reads } = await makeRunner(t);
  const result = await service.run({ command: `${GH} api user`, workspaceRoot: WS, programAllowance: allowance() });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(reads, [{ programPath: GH, root: WS, approved: [{ name: 'GH_TOKEN', id: ID_A }] }]);
  assert.equal(runs[0].GH_TOKEN, TOKEN);
  assert.equal(runs[0].HTTPS_PROXY, 'http://127.0.0.1:1');
  assert.match(runs[0].GH_CONFIG_DIR, /snotra-sh-.*[/\\]config[/\\]gh$/, 'gh reads an empty config of its own, not the locked ~/.config/gh');
  assert.deepEqual(result.credentials, { set: ['GH_TOKEN'], unavailable: [] });
});

test('runner: what the run prints carries the token masked — verbatim and encoded', async (t) => {
  const { service } = await makeRunner(t, {
    print: (env) => ({
      stdout: `token: ${env.GH_TOKEN}\nb64: ${Buffer.from(env.GH_TOKEN).toString('base64')}\n`,
      stderr: `hex ${Buffer.from(env.GH_TOKEN).toString('hex')}`,
    }),
  });
  const result = await service.run({ command: `${GH} auth token`, workspaceRoot: WS, programAllowance: allowance() });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(result.stdout.includes(Buffer.from(TOKEN).toString('base64').slice(0, 20)), false);
  assert.equal(result.stderr.includes(Buffer.from(TOKEN).toString('hex')), false);
  assert.match(result.stdout, /token: ••••••••/);
});

test('runner: no allowance credentials, no isolation, or none approved — no token', async (t) => {
  const plain = await makeRunner(t);
  await plain.service.run({ command: 'env', workspaceRoot: WS });
  await plain.service.run({ command: `${GH} api user`, workspaceRoot: WS, programAllowance: allowance([]) });
  assert.deepEqual(plain.reads, []);
  assert.equal(plain.runs.some((env) => 'GH_TOKEN' in env || 'GH_CONFIG_DIR' in env), false);

  const open = await makeRunner(t, { isolated: false });
  await open.service.run({ command: `${GH} api user`, workspaceRoot: WS, programAllowance: allowance() });
  assert.deepEqual(open.reads, [], 'outside the sandbox the domains would not hold the token to them');
  assert.equal('GH_TOKEN' in open.runs[0], false);
});

test('runner: a value that cannot be read is named, and the run goes without it', async (t) => {
  const { service, runs } = await makeRunner(t, { read: async () => ({ env: {}, unavailable: ['GH_TOKEN'] }) });
  const result = await service.run({ command: `${GH} api user`, workspaceRoot: WS, programAllowance: allowance() });
  assert.deepEqual(result.credentials, { set: [], unavailable: ['GH_TOKEN'] });
  assert.equal('GH_TOKEN' in runs[0], false);
  assert.equal('GH_CONFIG_DIR' in runs[0], false);
});

// ── Registry, own secrets, interface ───────────────────────────────────────

test('registry: the run gets the plan\'s credentials by name and id; the model learns which variables were set', async () => {
  const calls = [];
  const registry = createWorkspaceToolRegistry({
    fsService: { resolveToolPath: async (root) => ({ absPath: root }) },
    shellRunner: {
      isAvailable: () => true,
      describe: () => ({ found: true, label: 'zsh' }),
      run: async (request) => {
        calls.push(request);
        return {
          stdout: 'octocat', stderr: '', exitCode: 0, timedOut: false, aborted: false, truncated: false, durationMs: 1, shell: 'zsh',
          isolation: { isolated: true, domains: ['api.github.com'], trustd: true },
          credentials: { set: ['GH_TOKEN'], unavailable: [] },
        };
      },
    },
  });
  const plan = { sandbox: { disabled: false, root: WS, allowance: { path: GH, program: 'gh', domains: ['api.github.com'], writePaths: [], trustd: true, credentials: [{ name: 'GH_TOKEN', id: ID_A }], command: `${GH} api user` } } };
  const out = JSON.parse(await registry.execute('shell_execute', { command: 'gh api user' }, { approved: true, workspaceRoot: WS, plan }));
  assert.deepEqual(calls[0].programAllowance, { writePaths: [], trustd: true, path: GH, root: WS, credentials: [{ name: 'GH_TOKEN', id: ID_A }] });
  assert.deepEqual(out.sandbox.program_allowance.environment_variables, ['GH_TOKEN']);
  assert.match(out.sandbox.program_allowance.credential_note, /masked/);
});

test('own secrets: an allowance\'s token is withheld from every other tool result', async () => {
  const own = createOwnSecrets({
    llmConfigStore: { readLLMConfig: async () => ({ providers: {}, presets: [] }) },
    providerSecrets: { getEffectiveProviderConfig: async () => null },
    mcpSecrets: { getMcpSecretValues: async () => [] },
    webSearchStore: { getWebSearchApiKey: async () => null },
    allowanceSecrets: { getAllowanceSecretValues: async () => [TOKEN] },
  });
  const secrets = await own.readOwnSecrets();
  assert.equal(secrets.includes(TOKEN), true);
  assert.equal(secrets.includes(Buffer.from(TOKEN).toString('hex')), true);
});

test('interface: the settings row and the card name the variable (en/de)', async () => {
  const load = (file) => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', file)).href);
  const { setLocale } = await load('i18n.js');
  const { describeAllowanceRow, describeAllowanceOnCard } = await load('utils/program-allowance-view.js');
  try {
    setLocale('en');
    const row = describeAllowanceRow(gh([{ name: 'GH_TOKEN', id: ID_A }]));
    assert.deepEqual(row.facts.at(-1), { label: 'Credentials', values: ['GH_TOKEN'], mono: true, tag: 'encrypted' });
    const isolation = { isolated: true, domains: ['api.github.com'], allowance: { program: 'gh', path: GH, writePaths: [], trustd: false, credentials: ['GH_TOKEN'] } };
    assert.equal(describeAllowanceOnCard(isolation).text, 'its domains are listed under Network. It gets GH_TOKEN from the allowance.');
    setLocale('de');
    assert.equal(describeAllowanceOnCard(isolation).text, 'ihre Domains stehen unter Netzwerk. Es bekommt GH_TOKEN aus der Freigabe.');
    assert.deepEqual(describeAllowanceRow(gh([{ name: 'GH_TOKEN', id: ID_A }])).facts.at(-1).label, 'Zugangsdaten');
  } finally {
    setLocale('en');
  }
});
