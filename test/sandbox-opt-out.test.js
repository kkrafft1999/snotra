// Per-workspace opt-out of the sandbox (#357): the planner decides and binds
// it to the plan, the handler hands it to the runner, the runner skips the
// sandbox, and card, settings and the mode pill say so. Storage and the
// native confirmation are in tool-policy-store.test.js and
// tool-permission-handlers.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs').promises;
const os = require('os');
const nodePath = require('path');
const { pathToFileURL } = require('url');

const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createToolCallPlanner } = require('../src/main/tools/tool-call-planner');
const { planSpawn } = require('../src/main/services/sandboxed-spawn');
const { createShellRunnerService } = require('../src/main/services/shell-runner-service');
const { createPythonRunnerService } = require('../src/main/services/python-runner-service');

const loadRenderer = (file) =>
  import(pathToFileURL(nodePath.join(__dirname, '..', 'src', 'renderer', 'utils', file)).href);

const WORKSPACE = nodePath.resolve('/tmp/projekt');
const posixOnly = { skip: process.platform === 'win32' ? 'the sandbox is macOS/Linux only' : false };

function makeFsServiceStub() {
  return {
    async resolveToolPath(workspaceRoot, relativePath) {
      const absPath = nodePath.resolve(workspaceRoot, typeof relativePath === 'string' ? relativePath : '');
      const rel = nodePath.relative(workspaceRoot, absPath);
      if (rel.startsWith('..') || nodePath.isAbsolute(rel)) return { error: 'outside' };
      return { absPath, root: workspaceRoot, prefix: '' };
    },
    async resolveExistingRealPath(p) { return p; },
  };
}

function makeRegistry(run) {
  const calls = [];
  const runner = (request) => {
    calls.push(request);
    return run ? run(request) : {
      stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: false, truncated: false, durationMs: 1, shell: 'zsh',
    };
  };
  const registry = createWorkspaceToolRegistry({
    fsService: makeFsServiceStub(),
    shellRunner: { isAvailable: () => true, run: runner },
    pythonRunner: { isAvailable: () => true, run: runner },
  });
  return { registry, calls };
}

function makePlanner({ disabled = () => false, sandbox = { isolated: true } } = {}) {
  const asked = [];
  const planner = createToolCallPlanner({
    fsService: makeFsServiceStub(),
    fs,
    path: nodePath,
    describeShell: () => ({ label: 'zsh', login: true }),
    describeSandbox: async () => { asked.push('sandbox'); return sandbox; },
    isSandboxDisabled: async (root) => disabled(root),
  });
  return { planner, asked };
}

// ── Planner ────────────────────────────────────────────────────────────────

test('planner: switched off for the workspace — the card says why, without asking the sandbox', async () => {
  const { registry } = makeRegistry();
  const { planner, asked } = makePlanner({ disabled: (root) => root === WORKSPACE });
  for (const tool of ['shell_execute', 'run_python']) {
    const args = tool === 'shell_execute' ? { command: 'gh pr list' } : { code: 'print(1)' };
    const plan = await planner.plan(registry.getDefinition(tool), args, { workspaceRoot: WORKSPACE });
    assert.deepEqual(plan.sandbox, { disabled: true, root: WORKSPACE });
    assert.deepEqual(plan.preview.isolation, { isolated: false, reason: 'workspace', missing: [] });
  }
  assert.deepEqual(asked, [], 'the user’s choice needs no detection');
});

test('planner: the switch is part of the plan key; other workspaces and tools are untouched', async () => {
  const { registry } = makeRegistry();
  let off = false;
  const { planner } = makePlanner({ disabled: () => off });
  const shell = registry.getDefinition('shell_execute');
  const on = await planner.plan(shell, { command: 'ls' }, { workspaceRoot: WORKSPACE });
  assert.deepEqual(on.sandbox, { disabled: false, root: WORKSPACE });
  assert.deepEqual(on.preview.isolation, { isolated: true, domains: [] });
  off = true;
  const switched = await planner.plan(shell, { command: 'ls' }, { workspaceRoot: WORKSPACE });
  assert.notEqual(switched.planKey, on.planKey, 'flipping the switch after the card voids the approval');

  // Only the execution tools have a sandbox.
  const read = await planner.plan(registry.getDefinition('list_directory'), {}, { workspaceRoot: WORKSPACE });
  assert.equal('sandbox' in read, false);
});

test('planner: a store that cannot be read keeps the sandbox on', async () => {
  const { registry } = makeRegistry();
  const { planner } = makePlanner({ disabled: () => { throw new Error('unreadable'); } });
  const plan = await planner.plan(registry.getDefinition('shell_execute'), { command: 'ls' }, { workspaceRoot: WORKSPACE });
  assert.equal(plan.sandbox.disabled, false);
  assert.equal(plan.preview.isolation.isolated, true);
});

test('planner: verifyTargets catches a switch flipped between plan and run (Auto has no card)', async () => {
  const { registry } = makeRegistry();
  let off = false;
  const { planner } = makePlanner({ disabled: () => off });
  const plan = await planner.plan(registry.getDefinition('shell_execute'), { command: 'ls' }, { workspaceRoot: WORKSPACE });
  assert.deepEqual(await planner.verifyTargets(plan), { ok: true });
  off = true;
  const check = await planner.verifyTargets(plan);
  assert.equal(check.ok, false);
  assert.match(check.error, /sandbox setting of this workspace changed/);
});

// ── Handler ────────────────────────────────────────────────────────────────

test('handler: only an approved plan with the switch off runs without sandbox', async () => {
  const { registry, calls } = makeRegistry();
  const off = { sandbox: { disabled: true, root: WORKSPACE } };
  await registry.execute('shell_execute', { command: 'ls' }, { approved: true, workspaceRoot: WORKSPACE, plan: off });
  await registry.execute('run_python', { code: 'print(1)' }, { approved: true, workspaceRoot: WORKSPACE, plan: off });
  await registry.execute('shell_execute', { command: 'ls' }, { approved: true, workspaceRoot: WORKSPACE });
  assert.deepEqual(calls.map((c) => c.sandboxDisabled), [true, true, false]);
});

test('handler: the model learns the run was not isolated, and why', async () => {
  const { registry } = makeRegistry(() => ({
    stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: false, truncated: false, durationMs: 1, shell: 'zsh',
    isolation: { isolated: false, reason: 'workspace', missing: [] },
  }));
  const out = JSON.parse(await registry.execute('shell_execute', { command: 'ls' }, { approved: true, workspaceRoot: WORKSPACE }));
  assert.deepEqual(out.sandbox, { isolated: false, reason: 'The user switched the sandbox off for this workspace.' });
});

// ── Spawn and runners ──────────────────────────────────────────────────────

test('planSpawn: disabled never asks the sandbox and names the reason', async () => {
  let prepared = 0;
  const sandbox = { prepare: async () => { prepared += 1; return null; }, describe: () => ({ isolated: true }) };
  const target = await planSpawn({ sandbox, disabled: true, argv: ['/bin/sh', '-c', 'ls'], runTmp: '/tmp/x' });
  assert.equal(prepared, 0);
  assert.equal(target.command, '/bin/sh');
  assert.deepEqual(target.args, ['-c', 'ls']);
  assert.deepEqual(target.isolation, { isolated: false, reason: 'workspace', missing: [] });
  assert.deepEqual(target.env, {});
});

function countingSandbox() {
  const calls = { prepare: 0 };
  return {
    calls,
    describe: () => ({ isolated: true, reason: '', missing: [] }),
    async prepare(request) {
      calls.prepare += 1;
      return {
        command: '/bin/sh', args: ['-c', request.command], env: { SNOTRA_SANDBOX_MARK: 'inside' },
        domains: [], annotate: (s) => s, release: () => {},
      };
    },
  };
}

test('shell runner: switched off, the command runs plainly and says so', posixOnly, async (t) => {
  const sandbox = countingSandbox();
  const shell = createShellRunnerService({ spawn: childProcess.spawn, os, fs, path: nodePath, sandbox });
  await shell.detect();
  if (!shell.isAvailable()) return t.skip('no shell');
  const result = await shell.run({
    command: 'echo "${SNOTRA_SANDBOX_MARK:-plain}"', cwd: os.tmpdir(), workspaceRoot: os.tmpdir(), sandboxDisabled: true,
  });
  assert.equal(result.stdout.trim(), 'plain');
  assert.equal(sandbox.calls.prepare, 0);
  assert.deepEqual(result.isolation, { isolated: false, reason: 'workspace', missing: [] });
});

test('python runner: switched off, the script runs plainly and says so', posixOnly, async (t) => {
  const sandbox = countingSandbox();
  const python = createPythonRunnerService({ spawn: childProcess.spawn, fs, path: nodePath, os, sandbox });
  await python.detect();
  if (!python.isAvailable()) return t.skip('no Python 3');
  const result = await python.run({
    code: 'import os; print(os.environ.get("SNOTRA_SANDBOX_MARK", "plain"))', workspaceRoot: os.tmpdir(), sandboxDisabled: true,
  });
  assert.equal(result.stdout.trim(), 'plain');
  assert.equal(sandbox.calls.prepare, 0);
  assert.deepEqual(result.isolation, { isolated: false, reason: 'workspace', missing: [] });
});

// ── Card ───────────────────────────────────────────────────────────────────

function cardDto(tool, isolation, mode = 'smart') {
  const preview = tool === 'shell_execute'
    ? { kind: 'shell', text: 'gh pr list', truncated: false, masked: false, shell: 'zsh', cwd: WORKSPACE }
    : { kind: 'code', text: 'print(1)', truncated: false, masked: false };
  return {
    contractVersion: 1, requestId: 'req-ws', tool, riskClasses: ['execute'], targets: [], mode, sessionAllowed: false,
    preview: { ...preview, isolation },
  };
}

test('card: red pill, the reason "switched off for this workspace" and the way back (en/de)', async () => {
  const { buildApprovalCardView } = await loadRenderer('tool-approval-view.js');
  const { setLocale } = await import(pathToFileURL(nodePath.join(__dirname, '..', 'src', 'renderer', 'i18n.js')).href);
  const off = { isolated: false, reason: 'workspace', missing: [] };

  const shell = buildApprovalCardView(cardDto('shell_execute', off));
  assert.equal(shell.isolation.badge, 'Not isolated');
  assert.equal(shell.isolation.switchedOff, true);
  assert.equal(shell.isolation.settingsLabel, 'Sandbox setting');
  assert.equal(
    shell.warning,
    'You switched the sandbox off for this workspace. The command runs with your rights and is not limited to the project folder.',
  );
  const python = buildApprovalCardView(cardDto('run_python', off));
  assert.match(python.warning, /^You switched the sandbox off for this workspace\. The program runs with your rights/);

  // Any other reason offers no link: there is nothing the user switched.
  const windows = buildApprovalCardView(cardDto('shell_execute', { isolated: false, reason: 'platform', missing: [] }));
  assert.equal(windows.isolation.switchedOff, false);
  assert.equal(windows.isolation.settingsLabel, '');

  setLocale('de');
  try {
    const de = buildApprovalCardView(cardDto('shell_execute', off));
    assert.equal(de.isolation.badge, 'Nicht isoliert');
    assert.equal(de.isolation.settingsLabel, 'Sandbox-Einstellung');
    assert.match(de.warning, /^Du hast die Sandbox für diesen Workspace abgeschaltet\./);
  } finally {
    setLocale('en');
  }
});

// ── Mode pill ──────────────────────────────────────────────────────────────

test('mode pill: warns only in "Auto" with an execution tool that would run unisolated', async () => {
  const { describeAutoIsolationWarning } = await loadRenderer('tool-approval-view.js');
  const unisolated = (tools, reason) => ({ unisolated: true, tools, reason });

  assert.equal(
    describeAutoIsolationWarning({ mode: 'auto', executionIsolation: unisolated(['shell_execute'], 'workspace') }),
    'No sandbox for shell_execute in this workspace, and every run happens without asking.',
  );
  assert.equal(
    describeAutoIsolationWarning({ mode: 'auto', executionIsolation: unisolated(['run_python', 'shell_execute'], 'platform') }),
    'No sandbox for run_python and shell_execute on this system, and every run happens without asking.',
  );
  // No warning: another mode, an isolated sandbox, no execution tool, no state.
  assert.equal(describeAutoIsolationWarning({ mode: 'smart', executionIsolation: unisolated(['shell_execute'], 'workspace') }), '');
  assert.equal(describeAutoIsolationWarning({ mode: 'auto', executionIsolation: { unisolated: false, tools: ['shell_execute'] } }), '');
  assert.equal(describeAutoIsolationWarning({ mode: 'auto', executionIsolation: unisolated([], 'workspace') }), '');
  assert.equal(describeAutoIsolationWarning({ mode: 'auto' }), '');
  assert.equal(describeAutoIsolationWarning(null), '');
});

test('mode pill: the warning is spelled out on the pill and in the menu (#396)', async () => {
  const { describeModePill } = await loadRenderer('tool-approval-view.js');
  const { setLocale } = await loadRenderer('../i18n.js');
  const unisolated = (reason) => ({ unisolated: true, tools: ['shell_execute'], reason });

  // Without a warning the pill just names the mode; an unknown mode reads as the default.
  assert.deepEqual(describeModePill({ mode: 'auto', executionIsolation: { unisolated: false, tools: ['shell_execute'] } }), {
    mode: 'auto', label: 'Auto', unisolated: false, heading: '', warning: '', settingsLabel: '',
  });
  assert.equal(describeModePill({ mode: 'bogus' }).mode, 'smart');
  assert.equal(describeModePill({ mode: 'smart', executionIsolation: unisolated('workspace') }).unisolated, false);

  const off = describeModePill({ mode: 'auto', executionIsolation: unisolated('workspace') });
  assert.deepEqual(off, {
    mode: 'auto',
    label: 'Auto · not isolated',
    unisolated: true,
    heading: 'Not isolated',
    warning: 'No sandbox for shell_execute in this workspace, and every run happens without asking.',
    settingsLabel: 'Sandbox setting',
  });
  // A missing package can be fixed in the settings; Windows has nothing to switch.
  assert.equal(describeModePill({ mode: 'auto', executionIsolation: unisolated('dependencies') }).settingsLabel, 'Sandbox setting');
  assert.equal(describeModePill({ mode: 'auto', executionIsolation: unisolated('platform') }).settingsLabel, '');

  setLocale('de');
  try {
    const de = describeModePill({ mode: 'auto', executionIsolation: unisolated('workspace') });
    assert.equal(de.label, 'Auto · nicht isoliert');
    assert.equal(de.heading, 'Nicht isoliert');
    assert.equal(de.settingsLabel, 'Sandbox-Einstellung');
  } finally {
    setLocale('en');
  }
});

// ── Settings ───────────────────────────────────────────────────────────────

test('settings: the isolation line of each tool names the switched-off workspace', async () => {
  const { describeSandboxStatus } = await loadRenderer('sandbox-status-view.js');
  const status = describeSandboxStatus({ isolated: true, status: 'isolated' }, true, { workspaceDisabled: true });
  assert.equal(status.isWarning, true);
  assert.equal(status.text, 'Not isolated in this workspace: you switched the sandbox off below.');
  // Windows has nothing to switch off; its own reason stays.
  const windows = describeSandboxStatus({ isolated: false, status: 'unavailable', reason: 'platform' }, true, { workspaceDisabled: true });
  assert.match(windows.text, /Windows has no sandbox yet/);
  // A tool that is off says nothing, switched or not.
  assert.equal(describeSandboxStatus({ isolated: true }, false, { workspaceDisabled: true }), null);
});

test('settings: the workspace switch — hidden, no folder, on, off', async () => {
  const { describeWorkspaceSandbox } = await loadRenderer('sandbox-status-view.js');
  const sandbox = { isolated: true, status: 'isolated' };
  const autoLabel = 'Auto';

  // Hidden while both tools are off, and on Windows.
  assert.equal(describeWorkspaceSandbox({ permissions: { workspaceRoot: WORKSPACE }, toolsOn: false, sandbox, autoLabel }).visible, false);
  assert.equal(describeWorkspaceSandbox({
    permissions: { workspaceRoot: WORKSPACE }, toolsOn: true, sandbox: { isolated: false, reason: 'platform' }, autoLabel,
  }).visible, false);

  const none = describeWorkspaceSandbox({ permissions: { workspaceRoot: null }, toolsOn: true, sandbox, autoLabel });
  assert.deepEqual(
    { visible: none.visible, hasWorkspace: none.hasWorkspace, checked: none.checked, stateIsWarning: none.stateIsWarning },
    { visible: true, hasWorkspace: false, checked: true, stateIsWarning: false },
  );
  assert.equal(none.stateText, 'Open a folder to decide for it.');

  const on = describeWorkspaceSandbox({ permissions: { workspaceRoot: WORKSPACE, workspaceSandboxDisabled: false }, toolsOn: true, sandbox, autoLabel });
  assert.equal(on.checked, true);
  assert.equal(on.rootLabel, WORKSPACE);
  assert.equal(on.stateText, '');

  const off = describeWorkspaceSandbox({ permissions: { workspaceRoot: WORKSPACE, workspaceSandboxDisabled: true }, toolsOn: true, sandbox, autoLabel });
  assert.equal(off.checked, false);
  assert.equal(off.stateIsWarning, true);
  assert.match(off.stateText, /^Off in this workspace: every run has your full rights\./);
  assert.match(off.stateText, /in “Auto” mode it runs without asking/);
});
