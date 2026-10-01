// The effective state for Settings › Security (#448): every mode × class
// against the planner's matrix, rows that are off for lack of tools or by a
// block, the exceptions per row, the chats that differ from the default.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  describeSecurityOverview,
  rowsOfTool,
} = require('../src/application/permissions/security-overview');
const { matrixDecision } = require('../src/application/permissions/tool-policy');
const { TOOL_RISK_CLASS_ORDER } = require('../src/shared/contracts/tool-permissions');

const ROOT = '/work/snotra';

function tool(name, riskClasses, extra = {}) {
  return { name, shortDescription: name, riskClasses, available: true, disabled: false, mcpServer: null, ...extra };
}

const TOOLS = [
  tool('read_file_text', ['read']),
  tool('list_directory_tree', ['read']),
  tool('write_file_text', ['write'], { mayOverwrite: true }),
  tool('edit_file', ['write']),
  tool('shell_execute', ['execute']),
  tool('run_python', ['execute']),
  tool('web_search', ['external']),
  tool('fetch_url', ['external']),
];

function row(overview, riskClass) {
  return overview.classes.find((entry) => entry.riskClass === riskClass);
}

function rule(overrides) {
  return { id: `r-${Math.random().toString(36).slice(2)}`, scope: 'global', root: null, tool: null, riskClass: null, pathPattern: '**', ...overrides };
}

test('every mode × class follows the planner matrix', () => {
  for (const mode of ['smart', 'ask-all', 'auto']) {
    const overview = describeSecurityOverview({ root: ROOT, mode, tools: TOOLS });
    assert.equal(overview.defaultMode, mode);
    assert.deepEqual(overview.classes.map((entry) => entry.riskClass), [...TOOL_RISK_CLASS_ORDER]);
    for (const entry of overview.classes) {
      const expected = matrixDecision(mode, entry.riskClass) === 'allow' ? 'runs' : 'asks';
      assert.equal(entry.status, expected, `${mode} × ${entry.riskClass}`);
      assert.equal(entry.askFirst, expected === 'asks');
      assert.equal(entry.offReason, null);
    }
  }
});

test('rows list the tools a call of that class can come from', () => {
  const overview = describeSecurityOverview({ root: ROOT, mode: 'smart', tools: TOOLS });
  const names = (riskClass) => row(overview, riskClass).tools.map((entry) => entry.name);
  assert.deepEqual(names('read'), ['read_file_text', 'list_directory_tree']);
  assert.deepEqual(names('read-sensitive'), ['read_file_text', 'list_directory_tree']);
  assert.deepEqual(names('write'), ['write_file_text', 'edit_file']);
  assert.deepEqual(names('delete'), ['write_file_text']);
  assert.deepEqual(names('execute'), ['shell_execute', 'run_python']);
  assert.deepEqual(names('external'), ['web_search', 'fetch_url']);
});

test('an MCP tool sits with the external services, and under overwrite when it deletes', () => {
  assert.deepEqual([...rowsOfTool(tool('mcp__gh__issues', ['execute', 'external'], { mcpServer: 'GitHub' }))], ['external']);
  assert.deepEqual(
    [...rowsOfTool(tool('mcp__gh__drop', ['execute', 'external', 'delete'], { mcpServer: 'GitHub' }))].sort(),
    ['delete', 'external']
  );
});

test('a class without an offered tool is off, and says why', () => {
  const tools = TOOLS.map((entry) => {
    if (entry.name === 'shell_execute') return { ...entry, disabled: true };
    if (entry.name === 'run_python') return { ...entry, available: false };
    return entry;
  });
  const execute = row(describeSecurityOverview({ root: ROOT, mode: 'auto', tools }), 'execute');
  assert.equal(execute.status, 'off');
  assert.equal(execute.offReason, 'no-tools');
  assert.deepEqual(execute.tools.map((entry) => entry.state), ['disabled', 'unavailable']);
  assert.equal(execute.noSandbox, false);
});

test('a block for every path turns the row off; a narrower one is only listed', () => {
  const overview = describeSecurityOverview({
    root: ROOT,
    mode: 'auto',
    tools: TOOLS,
    globalRules: [
      rule({ effect: 'deny', riskClass: 'external' }),
      rule({ effect: 'deny', riskClass: 'write', pathPattern: '.git/**' }),
    ],
  });
  assert.equal(row(overview, 'external').status, 'off');
  assert.equal(row(overview, 'external').offReason, 'blocked');
  assert.ok(row(overview, 'external').tools.every((entry) => entry.blocked));
  assert.equal(row(overview, 'write').status, 'runs');
  assert.deepEqual(row(overview, 'write').denyRules.map((entry) => entry.pathPattern), ['.git/**']);
});

test('a block on one tool leaves the row running on the others', () => {
  const overview = describeSecurityOverview({
    root: ROOT,
    mode: 'smart',
    tools: TOOLS,
    globalRules: [rule({ effect: 'deny', tool: 'web_search' })],
  });
  const external = row(overview, 'external');
  assert.equal(external.status, 'asks');
  assert.deepEqual(external.tools.filter((entry) => entry.blocked).map((entry) => entry.name), ['web_search']);
});

test('exceptions per row: allowances, remembered commands, session approvals', () => {
  const overview = describeSecurityOverview({
    root: ROOT,
    mode: 'smart',
    tools: TOOLS,
    globalRules: [rule({ effect: 'allow', riskClass: 'write', pathPattern: 'docs/**' })],
    workspaceRules: [
      rule({ effect: 'allow', scope: 'workspace', root: ROOT, tool: 'shell_execute', command: 'npm test', cwd: '.' }),
      // A rule of another folder never shows here.
      rule({ effect: 'allow', scope: 'workspace', root: '/elsewhere', riskClass: 'read', pathPattern: '**' }),
    ],
    sessionGrants: [
      { id: 'g1', tool: 'edit_file', classes: ['write'], chatId: 'c1', chatTitle: 'Release', current: true },
      { id: 'g2', tool: 'read_file_text', classes: ['read', 'read-sensitive'], chatId: 'c1', chatTitle: 'Release' },
    ],
  });
  assert.equal(overview.allowancesApply, true);
  assert.deepEqual(row(overview, 'write').allowRules.map((entry) => [entry.scope, entry.pathPattern]), [['global', 'docs/**']]);
  assert.deepEqual(row(overview, 'execute').commandRules.map((entry) => entry.command), ['npm test']);
  assert.deepEqual(row(overview, 'execute').allowRules, []);
  assert.deepEqual(row(overview, 'read').allowRules, []);
  assert.deepEqual(row(overview, 'write').sessionGrants.map((entry) => entry.id), ['g1']);
  assert.deepEqual(row(overview, 'read-sensitive').sessionGrants.map((entry) => entry.id), ['g2']);
  // Nothing that matches an approval travels along.
  assert.equal('scopeKey' in row(overview, 'write').sessionGrants[0], false);
});

test('allowances only apply in Smart', () => {
  assert.equal(describeSecurityOverview({ root: ROOT, mode: 'ask-all', tools: TOOLS }).allowancesApply, false);
  assert.equal(describeSecurityOverview({ root: ROOT, mode: 'auto', tools: TOOLS }).allowancesApply, false);
});

test('the execute row warns when a command would run without the sandbox', () => {
  const overview = describeSecurityOverview({
    root: ROOT,
    mode: 'smart',
    tools: TOOLS,
    execution: { unisolated: true, workspaceSandboxDisabled: true, sandbox: { status: 'isolated', isolated: true } },
  });
  assert.equal(row(overview, 'execute').noSandbox, true);
  assert.equal(overview.execution.workspaceSandboxDisabled, true);
  assert.equal(overview.execution.toolsOn, true);
  assert.equal(row(overview, 'read').noSandbox, false);
});

test('sandbox and program allowances are described even while execution is off', () => {
  const tools = TOOLS.filter((entry) => !['shell_execute', 'run_python'].includes(entry.name));
  const overview = describeSecurityOverview({
    root: ROOT,
    mode: 'smart',
    tools,
    execution: { sandbox: { status: 'isolated', isolated: true }, programAllowances: [{ path: '/usr/bin/gh', domains: ['api.github.com'], writePaths: [], trustd: true }] },
  });
  assert.equal(overview.execution.toolsOn, false);
  assert.equal(overview.execution.sandbox.isolated, true);
  assert.equal(overview.execution.programAllowances.length, 1);
});

test('chats that differ from the default are named, the others are not', () => {
  const overview = describeSecurityOverview({
    root: ROOT,
    mode: 'smart',
    tools: TOOLS,
    chats: [
      { id: 'a', title: ' Check dependencies ', mode: 'ask-all' },
      { id: 'b', title: 'Same', mode: 'smart' },
      { id: 'c', title: 'Screen', mode: 'auto', current: true },
    ],
  });
  assert.deepEqual(overview.chatsWithOtherMode, [
    { id: 'a', title: 'Check dependencies', mode: 'ask-all', current: false },
    { id: 'c', title: 'Screen', mode: 'auto', current: true },
  ]);
});

test('without a folder: no workspace, no chats, workspace rules ignored', () => {
  const overview = describeSecurityOverview({
    root: null,
    mode: 'smart',
    tools: TOOLS,
    globalRules: [rule({ effect: 'deny', riskClass: 'external', pathPattern: 'x/**' })],
    workspaceRules: [rule({ effect: 'deny', scope: 'workspace', root: ROOT, riskClass: 'write' })],
    chats: [{ id: 'a', title: 'x', mode: 'auto' }],
  });
  assert.equal(overview.workspace, null);
  assert.deepEqual(overview.chatsWithOtherMode, []);
  assert.equal(row(overview, 'write').status, 'asks');
  assert.equal(row(overview, 'external').denyRules.length, 1);
});

test('the workspace name is the last segment of the root, on every platform', () => {
  assert.deepEqual(describeSecurityOverview({ root: '/work/snotra/', tools: [] }).workspace, { root: '/work/snotra/', name: 'snotra' });
  assert.equal(describeSecurityOverview({ root: 'C:\\Users\\k\\proj', tools: [] }).workspace.name, 'proj');
});

test('the built-in sensitive patterns go along, next to the user\'s own', () => {
  const overview = describeSecurityOverview({ root: ROOT, tools: TOOLS, sensitivePathPatterns: ['personal/**', 42] });
  assert.ok(overview.sensitive.builtInNames.includes('.env*'));
  assert.ok(overview.sensitive.builtInDirectories.includes('.ssh'));
  assert.deepEqual(overview.sensitive.userPatterns, ['personal/**']);
});

test('an unknown mode falls back to Smart, like the planner', () => {
  const overview = describeSecurityOverview({ root: ROOT, mode: 'yolo', tools: TOOLS });
  assert.equal(overview.defaultMode, 'smart');
  assert.equal(row(overview, 'read').status, 'runs');
});

test('the Delete row is blocked by a block on writes exactly when the policy is (#515)', () => {
  const { decideToolPolicy } = require('../src/application/permissions/tool-policy');
  const denyWrite = { id: 'd', effect: 'deny', scope: 'global', root: null, tool: null, riskClass: 'write', pathPattern: '**', createdAt: 0 };
  const overview = describeSecurityOverview({
    mode: 'auto',
    globalRules: [denyWrite],
    tools: [{ name: 'write_file_text', riskClasses: ['write'], mayOverwrite: true }],
  });
  const row = overview.classes.find((entry) => entry.riskClass === 'delete');
  assert.equal(row.status, 'off');
  assert.equal(row.offReason, 'blocked');
  const verdict = decideToolPolicy({ mode: 'auto', toolName: 'write_file_text', riskClasses: ['delete'], targets: [{ path: 'a.txt' }], rules: [denyWrite] });
  assert.equal(verdict.decision, 'deny');
});
