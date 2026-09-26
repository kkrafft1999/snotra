// Remembered shell commands (#121): one exact command line of `shell_execute`
// may be allowed permanently for one workspace. Contract form, policy match,
// the card's offer, the native confirmation, storage and the card's wording.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const nodePath = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const {
  normalizeRememberableCommand,
  normalizeCommandCwd,
  normalizePermissionRule,
  isCommandRule,
  createToolApprovalRequestDto,
  COMMAND_RULE_UNAVAILABLE_REASONS: REASONS,
} = require('../src/shared/contracts/tool-permissions');
const { decideToolPolicy } = require('../src/application/permissions/tool-policy');
const { buildApprovalRequest } = require('../src/application/permissions/approval-request');
const { createToolPolicyStore } = require('../src/main/services/tool-policy-store');
const { createToolApprovalAdapter } = require('../src/main/adapters/tool-approval-adapter');
const { registerToolPermissionHandlers, commandRuleDialog } = require('../src/main/ipc/tool-permission-handlers');
const { createSessionGrants } = require('../src/application/permissions/session-grants');
const { createToolCallPlanner } = require('../src/main/tools/tool-call-planner');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createTranslator } = require('../src/shared/i18n');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

const ROOT = '/work/projekt';

const loadView = () =>
  import(pathToFileURL(nodePath.join(__dirname, '..', 'src', 'renderer', 'utils', 'tool-approval-view.js')).href);
const loadI18n = () =>
  import(pathToFileURL(nodePath.join(__dirname, '..', 'src', 'renderer', 'i18n.js')).href);

function commandRule(overrides = {}) {
  return {
    id: 'cmd-1',
    effect: 'allow',
    scope: 'workspace',
    root: ROOT,
    tool: 'shell_execute',
    riskClass: null,
    pathPattern: '**',
    command: 'git status',
    cwd: '',
    networkDomains: [],
    createdAt: 0,
    ...overrides,
  };
}

function shellCall(overrides = {}) {
  return { command: 'git status', cwd: '', networkDomains: [], stdin: false, ...overrides };
}

function decide(overrides = {}) {
  return decideToolPolicy({
    mode: 'smart',
    toolName: 'shell_execute',
    riskClasses: ['execute'],
    targets: [],
    root: ROOT,
    rules: [commandRule()],
    shellCommand: shellCall(),
    ...overrides,
  });
}

// ── Contract ────────────────────────────────────────────────────────────────

test('only simple commands have a remembered form; spaces collapse', () => {
  assert.equal(normalizeRememberableCommand('  git   status  '), 'git status');
  assert.equal(normalizeRememberableCommand('npm test'), 'npm test');
  assert.equal(normalizeRememberableCommand('ls -la src/*.js'), 'ls -la src/*.js');
  assert.equal(normalizeRememberableCommand('npx eslint --fix=false src'), 'npx eslint --fix=false src');
  for (const unsafe of [
    'git status && rm x', 'git status; rm x', 'git log | head', 'echo hi > out.txt', 'cat < in',
    'echo $HOME', 'echo `id`', 'echo $(id)', 'git commit -m "x"', "echo 'x'", 'type C:\\x',
    'dir %TEMP%', 'git status\nrm x', 'npm test &', '-rf', '', '   ',
  ]) {
    assert.equal(normalizeRememberableCommand(unsafe), null, unsafe);
  }
  assert.equal(normalizeRememberableCommand('a'.repeat(401)), null);
  assert.equal(normalizeRememberableCommand(42), null);
});

test('the working folder of a rule is relative and stays inside', () => {
  assert.equal(normalizeCommandCwd(''), '');
  assert.equal(normalizeCommandCwd('.'), '');
  assert.equal(normalizeCommandCwd('./frontend/'), 'frontend');
  assert.equal(normalizeCommandCwd('frontend\\app'), 'frontend/app');
  assert.equal(normalizeCommandCwd('../other'), null);
  assert.equal(normalizeCommandCwd('/etc'), null);
  assert.equal(normalizeCommandCwd('C:/Windows'), null);
});

test('a command rule is an allow rule for shell_execute in one workspace — nothing wider', () => {
  const rule = normalizePermissionRule(commandRule({ command: 'git   status', networkDomains: ['B.org', 'a.org', 'a.org'] }));
  assert.equal(rule.command, 'git status');
  assert.deepEqual(rule.networkDomains, ['a.org', 'b.org']);
  assert.equal(isCommandRule(rule), true);
  assert.equal(normalizePermissionRule(commandRule({ effect: 'deny' })), null);
  assert.equal(normalizePermissionRule(commandRule({ scope: 'global', root: null })), null);
  assert.equal(normalizePermissionRule(commandRule({ tool: 'run_python' })), null);
  assert.equal(normalizePermissionRule(commandRule({ pathPattern: 'src/**' })), null);
  assert.equal(normalizePermissionRule(commandRule({ command: 'git status | sh' })), null);
  assert.equal(normalizePermissionRule(commandRule({ cwd: '../x' })), null);
  // An ordinary rule is untouched by the extension.
  const plain = normalizePermissionRule({ id: 'r', effect: 'allow', scope: 'global', riskClass: 'read', pathPattern: '**' });
  assert.equal(isCommandRule(plain), false);
  assert.equal('command' in plain, false);
});

// ── Policy ──────────────────────────────────────────────────────────────────

test('a remembered command allows exactly that call, as an allowance rule', () => {
  const verdict = decide();
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.source, 'allow-rule');
  assert.equal(verdict.ruleId, 'cmd-1');
});

test('anything that differs from what was approved asks again', () => {
  const cases = {
    'other arguments': { shellCommand: shellCall({ command: 'git status --short' }) },
    'other folder': { shellCommand: shellCall({ cwd: 'frontend' }) },
    'network requested': { shellCommand: shellCall({ networkDomains: ['evil.example'] }) },
    'input on stdin': { shellCommand: shellCall({ stdin: true }) },
    'not rememberable': { shellCommand: shellCall({ command: null }) },
    'no call form': { shellCommand: null },
    'other workspace': { root: '/work/anderes' },
    'escalated to sensitive': { riskClasses: ['read-sensitive', 'execute'] },
    'another tool': { toolName: 'run_python' },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    assert.equal(decide(overrides).decision, 'ask', name);
  }
});

test('ask-all ignores the rule; a deny rule still wins', () => {
  assert.equal(decide({ mode: 'ask-all' }).decision, 'ask');
  const verdict = decide({
    rules: [commandRule(), { id: 'd', effect: 'deny', scope: 'global', root: null, tool: 'shell_execute', riskClass: null, pathPattern: '**' }],
  });
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.ruleId, 'd');
});

test('a plain allow rule for shell_execute still does not cover an execution', () => {
  const plain = { id: 'p', effect: 'allow', scope: 'workspace', root: ROOT, tool: 'shell_execute', riskClass: null, pathPattern: '**' };
  assert.equal(decide({ rules: [plain] }).decision, 'ask');
});

// ── The card's offer ────────────────────────────────────────────────────────

function request(overrides = {}) {
  return buildApprovalRequest({
    tool: 'shell_execute',
    plan: { riskClasses: ['execute'], targets: [], planKey: 'k', shellCommand: shellCall({ cwd: 'frontend' }) },
    askClasses: ['execute'],
    mode: 'smart',
    policyVersion: '1:ok',
    workspaceRoot: ROOT,
    encryptionAvailable: true,
    ...overrides,
  });
}

test('the card offers "always" and main keeps the rule it would store', () => {
  const req = request();
  assert.equal(req.alwaysAllowed, true);
  assert.deepEqual(req.commandRule, {
    effect: 'allow', scope: 'workspace', root: ROOT, tool: 'shell_execute',
    command: 'git status', cwd: 'frontend', networkDomains: [],
  });
  // The renderer learns that it is offered — not the rule, not the root.
  const dto = createToolApprovalRequestDto({ ...req, requestId: 'r1' });
  assert.equal(dto.alwaysAllowed, true);
  assert.equal('commandRule' in dto, false);
});

test('when "always" is not offered, the card is told why', () => {
  const plan = (shellCommand) => ({ riskClasses: ['execute'], targets: [], planKey: 'k', shellCommand });
  const cases = [
    [{ mode: 'ask-all' }, REASONS.ASK_ALL],
    [{ plan: plan(shellCall({ command: null })) }, REASONS.NOT_SIMPLE],
    [{ plan: plan(shellCall({ stdin: true })) }, REASONS.STDIN],
    [{ encryptionAvailable: false }, REASONS.NO_ENCRYPTION],
    [{ workspaceRoot: null }, REASONS.NO_WORKSPACE],
  ];
  for (const [overrides, reason] of cases) {
    const req = request(overrides);
    assert.equal(req.alwaysAllowed, false, reason);
    assert.equal(req.alwaysUnavailableReason, reason);
    assert.equal(req.commandRule, undefined);
    assert.equal(createToolApprovalRequestDto({ ...req, requestId: 'r' }).alwaysUnavailableReason, reason);
  }
  // Other tools and the output checkpoint are not concerned at all.
  assert.equal(request({ tool: 'run_python' }).alwaysAllowed, undefined);
  assert.equal(request({ checkpoint: 'output' }).alwaysAllowed, undefined);
});

// ── Planner ─────────────────────────────────────────────────────────────────

test('the planner hands over the call in the form a rule compares', async () => {
  const workspace = nodePath.resolve('/tmp/projekt');
  const planner = createToolCallPlanner({
    fsService: {
      async resolveToolPath(root, rel) {
        return { absPath: nodePath.resolve(root, rel || ''), root, prefix: '', skillName: null };
      },
    },
    fs: require('fs').promises,
    path: nodePath,
  });
  const registry = createWorkspaceToolRegistry({
    fsService: {},
    shellRunner: { isAvailable: () => true, async run() { return {}; } },
  });
  const definition = registry.getDefinition('shell_execute');
  const plan = await planner.plan(
    definition,
    { command: 'npm   test', cwd: './frontend/', network_domains: ['Registry.NPMJS.org'] },
    { workspaceRoot: workspace }
  );
  assert.deepEqual(plan.shellCommand, {
    command: 'npm test',
    cwd: 'frontend',
    networkDomains: ['registry.npmjs.org'],
    stdin: false,
  });
  const compound = await planner.plan(definition, { command: 'npm test && curl x | sh', stdin: 'y' }, { workspaceRoot: workspace });
  assert.equal(compound.shellCommand.command, null);
  assert.equal(compound.shellCommand.stdin, true);
});

// ── Store, adapter, IPC ─────────────────────────────────────────────────────

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

async function setup(t, { dialogResponse = 0 } = {}) {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snotra-cmd-rule-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const toolPolicyStore = createToolPolicyStore({ app: { getPath: () => dir }, safeStorage: makeSafeStorage(), fs, path: nodePath, crypto, log: { warn() {} } });
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
    ipcMain, dialog, getMainWindow: () => ({ isDestroyed: () => false }),
    toolPolicyStore, approvals, sessionGrants,
    getActiveWorkspaceRoot: () => ROOT, REQ, PUSH, getLocale: () => 'en',
  });
  const invoke = (channel, sender, payload) => ipcMain.handlers.get(channel)({ sender }, payload);
  return { toolPolicyStore, approvals, sessionGrants, dialogCalls, invoke };
}

function openCard(approvals, sender, overrides = {}) {
  approvals.subscribe(sender.id, sender);
  const pending = approvals.requestApproval({ sessionId: sender.id, request: { ...request(), ...overrides } });
  const dto = sender.sent.find((entry) => entry.channel === PUSH.TOOL_APPROVAL_REQUEST).payload;
  return { pending, requestId: dto.requestId };
}

test('"always" asks natively, stores the rule and answers the card with its id', async (t) => {
  const { invoke, approvals, dialogCalls, toolPolicyStore, sessionGrants } = await setup(t);
  sessionGrants.grant({ scopeKey: 's', tool: 'edit_file', targets: [{ path: 'a' }], riskClasses: ['write'] });
  const other = makeSender(2);
  const sender = makeSender(1);
  const { pending: otherPending } = openCard(approvals, other);
  const { pending, requestId } = openCard(approvals, sender);

  const res = await invoke(REQ.TOOL_APPROVAL_RESPOND, sender, { requestId, response: 'allow-always' });
  assert.equal(res.ok, true);
  assert.equal(res.response, 'allow-always');
  assert.equal(dialogCalls.length, 1);
  assert.equal(dialogCalls[0].cancelId, 1, 'Cancel is the default');
  assert.match(dialogCalls[0].detail, /Command: git status/);
  assert.match(dialogCalls[0].detail, /Working folder: frontend/);

  const outcome = await pending;
  assert.equal(outcome.response, 'allow-always');
  const state = await toolPolicyStore.read();
  const stored = state.workspaceRules[ROOT];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, outcome.ruleId);
  assert.equal(stored[0].command, 'git status');
  assert.equal(stored[0].cwd, 'frontend');
  assert.ok(sender.sent.some((entry) => entry.channel === PUSH.TOOL_PERMISSIONS_CHANGED));
  // Remembering one command drops neither another card nor a session approval.
  assert.equal(approvals.pendingCount(), 1);
  assert.equal(sessionGrants.count(), 1);
  approvals.invalidateAll();
  await otherPending;
});

test('cancelling the dialog stores nothing and leaves the card open', async (t) => {
  const { invoke, approvals, toolPolicyStore } = await setup(t, { dialogResponse: 1 });
  const sender = makeSender();
  const { pending, requestId } = openCard(approvals, sender);
  const res = await invoke(REQ.TOOL_APPROVAL_RESPOND, sender, { requestId, response: 'allow-always' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'cancelled');
  assert.equal(approvals.pendingCount(), 1);
  assert.deepEqual((await toolPolicyStore.read()).workspaceRules, {});
  // The user decides again — once, this time.
  assert.equal((await invoke(REQ.TOOL_APPROVAL_RESPOND, sender, { requestId, response: 'allow-once' })).ok, true);
  assert.equal((await pending).response, 'allow-once');
});

test('a card that did not offer "always" is answered once, without a dialog or a rule', async (t) => {
  const { invoke, approvals, dialogCalls, toolPolicyStore } = await setup(t);
  const sender = makeSender();
  const { pending, requestId } = openCard(approvals, sender, {
    alwaysAllowed: false, alwaysUnavailableReason: REASONS.NOT_SIMPLE, commandRule: undefined,
  });
  const res = await invoke(REQ.TOOL_APPROVAL_RESPOND, sender, { requestId, response: 'allow-always' });
  assert.equal(res.response, 'allow-once');
  assert.equal(dialogCalls.length, 0);
  assert.equal((await pending).response, 'allow-once');
  assert.deepEqual((await toolPolicyStore.read()).workspaceRules, {});
});

test('a card that expired while the dialog was open stores nothing', async (t) => {
  let approvalsRef;
  const { invoke, approvals, toolPolicyStore } = await setup(t, {
    dialogResponse: () => {
      approvalsRef.invalidateAll();
      return 0;
    },
  });
  approvalsRef = approvals;
  const sender = makeSender();
  const { pending, requestId } = openCard(approvals, sender);
  const res = await invoke(REQ.TOOL_APPROVAL_RESPOND, sender, { requestId, response: 'allow-always' });
  assert.equal(res.ok, false);
  assert.equal((await pending).invalidated, true);
  assert.deepEqual((await toolPolicyStore.read()).workspaceRules, {});
});

test('the adapter never turns "always" into more than once without a stored rule', async () => {
  const approvals = createToolApprovalAdapter({ randomUUID: () => 'id-1', PUSH, log: { warn() {} } });
  const sender = makeSender();
  approvals.subscribe(sender.id, sender);
  const pending = approvals.requestApproval({ sessionId: sender.id, request: request() });
  assert.equal(approvals.getPendingRequest(2, 'id-1'), null, 'another window sees nothing');
  assert.equal(approvals.getPendingRequest(sender.id, 'id-1').commandRule.command, 'git status');
  assert.deepEqual(approvals.respond(sender.id, { requestId: 'id-1', response: 'allow-always' }), { ok: true, response: 'allow-once' });
  assert.equal((await pending).response, 'allow-once');
});

test('the same command remembered twice is one rule', async (t) => {
  const { toolPolicyStore } = await setup(t);
  const rule = request().commandRule;
  const first = await toolPolicyStore.addRule(rule);
  const second = await toolPolicyStore.addRule(rule);
  assert.equal(second.ruleId, first.ruleId);
  assert.equal((await toolPolicyStore.read()).workspaceRules[ROOT].length, 1);
});

test('a failed signature drops remembered commands with every other allowance', async (t) => {
  const { toolPolicyStore } = await setup(t);
  await toolPolicyStore.addRule(request().commandRule);
  const file = toolPolicyStore.getPolicyPath();
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.signature = '0'.repeat(64);
  await fs.writeFile(file, JSON.stringify(raw));
  const state = await toolPolicyStore.read();
  assert.equal(state.integrity, 'invalid');
  assert.deepEqual(state.rules, []);
});

test('the dialog names command, folder and network in both languages', () => {
  const rule = normalizePermissionRule(commandRule({ id: 'x', networkDomains: ['pypi.org'] }));
  const en = commandRuleDialog(rule, createTranslator('en'));
  assert.equal(en.title, 'Always allow this command?');
  assert.match(en.detail, /Command: git status\nWorking folder: project folder\nNetwork: pypi\.org/);
  assert.deepEqual(en.buttons, ['Always allow', 'Cancel']);
  const de = commandRuleDialog(rule, createTranslator('de'));
  assert.equal(de.title, 'Diesen Befehl immer erlauben?');
  assert.match(de.detail, /Befehl: git status\nArbeitsordner: Projektordner\nNetzwerk: pypi\.org/);
  assert.match(de.detail, /bis du sie unter/);
});

// ── Card and rule list ──────────────────────────────────────────────────────

function cardDto(overrides = {}) {
  return {
    contractVersion: 1,
    requestId: 'req-1',
    tool: 'shell_execute',
    riskClasses: ['execute'],
    targets: [],
    mode: 'smart',
    sessionAllowed: false,
    preview: { kind: 'shell', text: 'git status', truncated: false, masked: false, shell: 'zsh', cwd: ROOT },
    alwaysAllowed: true,
    ...overrides,
  };
}

test('a command card has "always" where other cards have "for this session"', async () => {
  const { buildApprovalCardView } = await loadView();
  const view = buildApprovalCardView(cardDto());
  assert.deepEqual(view.actionOrder, ['once', 'always', 'deny']);
  assert.equal(view.actions.always.enabled, true);
  assert.equal(view.actions.always.response, 'allow-always');
  assert.equal(view.actions.always.label, 'Always allow this command');
  assert.match(view.actions.always.hint, /exactly this command line/);
  assert.match(view.actions.always.hint, /“Permissions”/);

  const blocked = buildApprovalCardView(cardDto({ alwaysAllowed: undefined, alwaysUnavailableReason: 'not-simple' }));
  assert.equal(blocked.actions.always.enabled, false);
  assert.match(blocked.actions.always.hint, /Only simple commands/);

  const edit = buildApprovalCardView(cardDto({ tool: 'edit_file', riskClasses: ['write'], alwaysAllowed: undefined, sessionAllowed: true }));
  assert.deepEqual(edit.actionOrder, ['once', 'session', 'deny']);
});

test('the outcome and the rule list say what was remembered, in both languages', async () => {
  const { describeApprovalOutcome, describeRule } = await loadView();
  const { setLocale } = await loadI18n();
  const outcome = describeApprovalOutcome({ response: 'allow-always' });
  assert.equal(outcome.status, 'allowed');
  assert.equal(outcome.label, 'Always allowed in this workspace');
  const row = describeRule(commandRule({ cwd: 'frontend', networkDomains: ['pypi.org'] }));
  assert.equal(row.patternLabel, 'git status');
  assert.equal(row.subject, 'Command in frontend · network: pypi.org');
  assert.equal(row.text, 'Allowance: Command in frontend · network: pypi.org git status (This workspace)');
  setLocale('de');
  try {
    assert.equal(describeApprovalOutcome({ response: 'allow-always' }).label, 'In diesem Workspace immer erlaubt');
    assert.equal(describeRule(commandRule()).subject, 'Befehl');
    for (const reason of Object.values(REASONS)) {
      const { buildApprovalCardView } = await loadView();
      const hint = buildApprovalCardView(cardDto({ alwaysAllowed: undefined, alwaysUnavailableReason: reason })).actions.always.hint;
      assert.ok(hint && !hint.includes('approval.'), `${reason}: ${hint}`);
    }
  } finally {
    setLocale('en');
  }
});
