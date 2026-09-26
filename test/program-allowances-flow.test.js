// Program allowances through the layers (#408): the planner binds the
// allowance to the plan and the card, the handler runs the allowed file with
// the allowance's rights, planSpawn hands them to the sandbox, and the card
// and the model say what applied. Entry format, matching and folder checks
// are in program-allowances.test.js; storage and the native confirmation in
// tool-policy-store.test.js and tool-permission-handlers.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const nodePath = require('path');
const { pathToFileURL } = require('url');

const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createToolCallPlanner } = require('../src/main/tools/tool-call-planner');
const { planSpawn } = require('../src/main/services/sandboxed-spawn');
const { createToolApprovalRequestDto } = require('../src/shared/contracts/tool-permissions');

const loadRenderer = (file) =>
  import(pathToFileURL(nodePath.join(__dirname, '..', 'src', 'renderer', 'utils', file)).href);

const WORKSPACE = nodePath.resolve('/tmp/projekt');
const TOOL = '/Users/u/.ai-workplace/bin/ms-todo-cli';
const CACHE = '/Users/u/Library/Application Support/ms-todo';
const ENTRY = { path: TOOL, domains: ['graph.microsoft.com', 'login.microsoftonline.com'], writePaths: [CACHE], trustd: true };
const GRANTED = { path: TOOL, program: 'ms-todo-cli', domains: ENTRY.domains, writePaths: [CACHE], trustd: true };

function makeFsServiceStub() {
  return {
    async resolveToolPath(workspaceRoot, relativePath) {
      const absPath = nodePath.resolve(workspaceRoot, typeof relativePath === 'string' ? relativePath : '');
      return { absPath, root: workspaceRoot, prefix: '' };
    },
    async resolveExistingRealPath(p) { return p; },
  };
}

function makeRegistry(run) {
  const calls = [];
  const registry = createWorkspaceToolRegistry({
    fsService: makeFsServiceStub(),
    shellRunner: {
      isAvailable: () => true,
      run: (request) => {
        calls.push(request);
        return run ? run(request) : {
          stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: false, truncated: false, durationMs: 1, shell: 'zsh',
        };
      },
    },
  });
  return { registry, calls };
}

/**
 * A planner whose matcher answers like main's service would: the allowance
 * for `ms-todo-cli …` on its own, a skip for anything else naming it.
 */
function makePlanner({ stored = () => [ENTRY], sandbox = { isolated: true } } = {}) {
  const requests = [];
  const planner = createToolCallPlanner({
    fsService: makeFsServiceStub(),
    fs,
    path: nodePath,
    describeShell: () => ({ label: 'zsh', login: true }),
    describeSandbox: async () => sandbox,
    isSandboxDisabled: async () => false,
    matchProgramAllowance: async (request) => {
      requests.push(request);
      const entry = stored().find((candidate) => candidate.path === TOOL);
      if (!entry || !request.command.includes('ms-todo-cli')) return null;
      if (/[|;&]/.test(request.command)) return { skipped: { program: 'ms-todo-cli', reason: 'compound' } };
      return {
        allowance: { ...GRANTED, domains: entry.domains, writePaths: entry.writePaths, trustd: entry.trustd },
        command: `${TOOL}${request.command.slice('ms-todo-cli'.length)}`,
        entry,
      };
    },
    readProgramAllowances: async () => stored(),
  });
  return { planner, requests };
}

const shellDefinition = () => makeRegistry().registry.getDefinition('shell_execute');

// ── Planner ────────────────────────────────────────────────────────────────

test('planner: the allowance goes into the plan, its key and the card, with its domains first', async () => {
  const { planner, requests } = makePlanner();
  const plan = await planner.plan(shellDefinition(), {
    command: 'ms-todo-cli lists', network_domains: ['example.com'],
  }, { workspaceRoot: WORKSPACE });

  assert.deepEqual(requests, [{ command: 'ms-todo-cli lists', cwd: WORKSPACE }]);
  assert.equal(plan.sandbox.allowance.command, `${TOOL} lists`);
  assert.equal(plan.sandbox.allowance.program, 'ms-todo-cli');
  assert.equal(typeof plan.sandbox.allowance.entryKey, 'string');
  assert.deepEqual(plan.preview.isolation, {
    isolated: true,
    domains: ['graph.microsoft.com', 'login.microsoftonline.com', 'example.com'],
    allowance: { program: 'ms-todo-cli', path: TOOL, writePaths: [CACHE], trustd: true },
  });

  // Same call without the allowance: a different key, so an approval cannot carry over.
  const { planner: bare } = makePlanner({ stored: () => [] });
  const without = await bare.plan(shellDefinition(), { command: 'ms-todo-cli lists', network_domains: ['example.com'] }, { workspaceRoot: WORKSPACE });
  assert.notEqual(without.planKey, plan.planKey);
  assert.equal(without.sandbox.allowance, undefined);
});

test('planner: a command that does more than the program gets no allowance, and the card says why', async () => {
  const { planner } = makePlanner();
  const plan = await planner.plan(shellDefinition(), { command: 'ms-todo-cli lists | head' }, { workspaceRoot: WORKSPACE });
  assert.equal(plan.sandbox.allowance, undefined);
  assert.deepEqual(plan.sandbox.allowanceSkipped, { program: 'ms-todo-cli', reason: 'compound' });
  assert.deepEqual(plan.preview.isolation, {
    isolated: true, domains: [], allowanceSkipped: { program: 'ms-todo-cli', reason: 'compound' },
  });
});

test('planner: no allowance without a sandbox to widen, for Python, or when the check fails', async () => {
  const { planner } = makePlanner({ sandbox: { isolated: false, reason: 'dependencies', missing: ['socat'] } });
  const plan = await planner.plan(shellDefinition(), { command: 'ms-todo-cli lists' }, { workspaceRoot: WORKSPACE });
  assert.equal(plan.preview.isolation.isolated, false);
  assert.equal('allowance' in plan.preview.isolation, false);

  const broken = createToolCallPlanner({
    fsService: makeFsServiceStub(), fs, path: nodePath,
    describeSandbox: async () => ({ isolated: true }),
    matchProgramAllowance: async () => { throw new Error('boom'); },
  });
  const safe = await broken.plan(shellDefinition(), { command: 'ms-todo-cli lists' }, { workspaceRoot: WORKSPACE });
  assert.equal(safe.sandbox.allowance, undefined);

  const python = makeRegistry().registry.getDefinition('run_python');
  const { planner: p, requests } = makePlanner();
  await p.plan(python, { code: 'print(1)' }, { workspaceRoot: WORKSPACE });
  assert.equal(requests.length, 0);
});

test('planner: verifyTargets catches an allowance changed or removed between plan and run', async () => {
  let stored = [ENTRY];
  const { planner } = makePlanner({ stored: () => stored });
  const plan = await planner.plan(shellDefinition(), { command: 'ms-todo-cli lists' }, { workspaceRoot: WORKSPACE });
  assert.deepEqual(await planner.verifyTargets(plan), { ok: true });

  stored = [{ ...ENTRY, writePaths: [CACHE, '/Users/u/other'] }];
  const changed = await planner.verifyTargets(plan);
  assert.equal(changed.ok, false);
  assert.match(changed.error, /program allowance for this command changed/);

  stored = [];
  assert.equal((await planner.verifyTargets(plan)).ok, false);
});

// ── Handler ────────────────────────────────────────────────────────────────

test('handler: an approved allowance runs the allowed file with its domains, folders and trustd', async () => {
  const { registry, calls } = makeRegistry();
  const plan = { sandbox: { disabled: false, root: WORKSPACE, allowance: { ...GRANTED, command: `${TOOL} lists` } } };
  await registry.execute('shell_execute', { command: 'ms-todo-cli lists', network_domains: ['example.com'] }, {
    approved: true, workspaceRoot: WORKSPACE, plan,
  });
  assert.equal(calls[0].command, `${TOOL} lists`);
  assert.deepEqual(calls[0].networkDomains, ['graph.microsoft.com', 'login.microsoftonline.com', 'example.com']);
  assert.deepEqual(calls[0].programAllowance, { writePaths: [CACHE], trustd: true });

  // Without a plan there is no allowance, whatever the arguments say.
  await registry.execute('shell_execute', { command: 'ms-todo-cli lists' }, { approved: true, workspaceRoot: WORKSPACE });
  assert.equal(calls[1].command, 'ms-todo-cli lists');
  assert.equal(calls[1].programAllowance, null);
});

test('handler: the model learns which extra rights the run had, or why the allowance did not apply', async () => {
  const isolated = {
    stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: false, truncated: false, durationMs: 1, shell: 'zsh',
    isolation: { isolated: true, domains: ENTRY.domains, writePaths: [CACHE], trustd: true },
  };
  const { registry } = makeRegistry(() => isolated);
  const granted = { sandbox: { disabled: false, root: WORKSPACE, allowance: { ...GRANTED, command: `${TOOL} lists` } } };
  const out = JSON.parse(await registry.execute('shell_execute', { command: 'ms-todo-cli lists' }, {
    approved: true, workspaceRoot: WORKSPACE, plan: granted,
  }));
  assert.deepEqual(out.sandbox.program_allowance, { program: 'ms-todo-cli', write_paths: [CACHE], macos_certificate_check: true });

  const skipped = { sandbox: { disabled: false, root: WORKSPACE, allowanceSkipped: { program: 'ms-todo-cli', reason: 'compound' } } };
  const out2 = JSON.parse(await registry.execute('shell_execute', { command: 'ms-todo-cli lists | head' }, {
    approved: true, workspaceRoot: WORKSPACE, plan: skipped,
  }));
  assert.match(out2.sandbox.program_allowance_not_applied, /allowance for ms-todo-cli did not apply: the command does more than run the program/);
  assert.match(out2.sandbox.program_allowance_not_applied, /Run the program on its own/);
});

// ── Spawn ──────────────────────────────────────────────────────────────────

test('planSpawn: the allowance\'s folders and trustd reach the sandbox and come back in the isolation', async () => {
  const requests = [];
  const sandbox = {
    describe: () => ({ isolated: true }),
    async prepare(request) {
      requests.push(request);
      return {
        command: '/bin/sh', args: ['-c', request.command], env: {}, domains: request.allowedDomains,
        writePaths: request.extraWritePaths, trustd: request.weakerNetworkIsolation,
        annotate: (s) => s, release: () => {},
      };
    },
  };
  const target = await planSpawn({
    sandbox, argv: ['/bin/zsh', '-c', `${TOOL} lists`], runTmp: '/tmp/x',
    domains: ENTRY.domains, allowance: { writePaths: [CACHE], trustd: true },
  });
  assert.deepEqual(requests[0].extraWritePaths, [CACHE]);
  assert.equal(requests[0].weakerNetworkIsolation, true);
  assert.deepEqual(target.isolation, { isolated: true, domains: ENTRY.domains, writePaths: [CACHE], trustd: true });

  const plain = await planSpawn({ sandbox, argv: ['/bin/zsh', '-c', 'ls'], runTmp: '/tmp/x', domains: [] });
  assert.deepEqual(requests[1].extraWritePaths, []);
  assert.equal(requests[1].weakerNetworkIsolation, false);
  assert.deepEqual(plain.isolation, { isolated: true, domains: [] });
});

// ── Card ───────────────────────────────────────────────────────────────────

function cardDto(isolation) {
  return createToolApprovalRequestDto({
    requestId: 'r1',
    tool: 'shell_execute',
    riskClasses: ['execute'],
    targets: [],
    mode: 'smart',
    preview: { kind: 'text', text: 'ms-todo-cli lists', shellLabel: 'zsh', isolation },
  });
}

test('card: the contract carries the allowance or the reason, nothing else', () => {
  const dto = cardDto({
    isolated: true, domains: ENTRY.domains,
    allowance: { program: 'ms-todo-cli', path: TOOL, writePaths: [CACHE], trustd: true, extra: 'x' },
    allowanceSkipped: { program: 'ms-todo-cli', reason: 'compound' },
  });
  assert.deepEqual(dto.preview.isolation, {
    isolated: true, domains: ENTRY.domains,
    allowance: { program: 'ms-todo-cli', path: TOOL, writePaths: [CACHE], trustd: true },
  });
  const odd = cardDto({ isolated: true, domains: [], allowanceSkipped: { program: 'x', reason: 'because' } });
  assert.deepEqual(odd.preview.isolation, { isolated: true, domains: [] });
});

test('card: names the allowance with ~ paths, or why it stays off (en/de)', async () => {
  const { setLocale } = await import(pathToFileURL(nodePath.join(__dirname, '..', 'src', 'renderer', 'i18n.js')).href);
  const { buildApprovalCardView } = await loadRenderer('tool-approval-view.js');
  const granted = cardDto({
    isolated: true, domains: ENTRY.domains,
    allowance: { program: 'ms-todo-cli', path: TOOL, writePaths: [CACHE], trustd: true },
  });
  const skipped = cardDto({ isolated: true, domains: [], allowanceSkipped: { program: 'ms-todo-cli', reason: 'otherFile' } });
  try {
    setLocale('en');
    const view = buildApprovalCardView(granted, { homeDir: '/Users/u' });
    assert.deepEqual(view.isolation.allowance, {
      kind: 'applied',
      prefix: 'Program allowance for ms-todo-cli:',
      text: 'also writes in ~/Library/Application Support/ms-todo and checks certificates through macOS.',
      settingsLabel: 'Program allowances',
    });
    assert.equal(
      buildApprovalCardView(skipped).isolation.allowance.text,
      'The allowance for ms-todo-cli does not apply: the command starts a different file of that name.',
    );
    setLocale('de');
    assert.equal(
      buildApprovalCardView(granted, { homeDir: '/Users/u' }).isolation.allowance.text,
      'schreibt auch in ~/Library/Application Support/ms-todo und prüft Zertifikate über macOS.',
    );
    assert.equal(buildApprovalCardView(granted).isolation.allowance.prefix, 'Freigabe für ms-todo-cli:');
    const domainsOnly = cardDto({ isolated: true, domains: ['api.github.com'], allowance: { program: 'gh', path: '/opt/gh', writePaths: [], trustd: false } });
    assert.equal(buildApprovalCardView(domainsOnly).isolation.allowance.text, 'ihre Domains stehen unter Netzwerk.');
  } finally {
    setLocale('en');
  }
});

test('settings: a row lists only the rights the program has, trustd with its tag', async () => {
  const { setLocale } = await import(pathToFileURL(nodePath.join(__dirname, '..', 'src', 'renderer', 'i18n.js')).href);
  const { describeAllowanceRow, tildePath } = await loadRenderer('program-allowance-view.js');
  setLocale('en');
  const row = describeAllowanceRow(ENTRY, { homeDir: '/Users/u' });
  assert.equal(row.name, 'ms-todo-cli');
  assert.equal(row.pathLabel, '~/.ai-workplace/bin/ms-todo-cli');
  assert.deepEqual(row.facts, [
    { label: 'Network', values: ENTRY.domains, mono: true },
    { label: 'Also writes in', values: ['~/Library/Application Support/ms-todo'], mono: true },
    { label: 'Certificates', values: ['through macOS'], mono: false, tag: 'weaker isolation' },
  ]);
  assert.deepEqual(describeAllowanceRow({ path: '/opt/gh', domains: ['api.github.com'], writePaths: [], trustd: false }).facts.length, 1);
  assert.equal(tildePath('/Users/uwe/x', '/Users/u'), '/Users/uwe/x', 'a neighbour\'s folder is not ~');
  assert.equal(tildePath('/Users/u', '/Users/u'), '~');
});
