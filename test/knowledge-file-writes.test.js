// Knowledge files (#1319): a write by the file tools asks in every mode and is
// approved one at a time; a shell or Python command that changed one is
// followed by a card — keep or reset — that the run waits for; the global
// knowledge files are out of the file tools' reach.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { workspaceKnowledgeKind, globalKnowledgeKind, writtenRuleIsAlways } = require('../src/shared/contracts/knowledge-files');
const { decideToolPolicy } = require('../src/application/permissions/tool-policy');
const { buildApprovalRequest } = require('../src/application/permissions/approval-request');
const { createToolApprovalRequestDto } = require('../src/shared/contracts/tool-permissions');
const { createKnowledgeFilesAdapter } = require('../src/main/adapters/knowledge-files-adapter');
const { createOutsideAccess } = require('../src/main/services/outside-access');
const { createChatEngine } = require('../src/application/chat/chat-engine');
const { createSessionGrants } = require('../src/application/permissions/session-grants');
const { formatLine: formatToolDisplayLine } = require('./helpers/tool-descriptors');
const { removeDir } = require('./helpers/temp-dir');

// ── What counts ─────────────────────────────────────────────────────────────

test('the knowledge files of the folder and of the home folder are known by path', () => {
  assert.equal(workspaceKnowledgeKind('AGENTS.md'), 'agents');
  assert.equal(workspaceKnowledgeKind('./.agents/memory.md'), 'memory');
  assert.equal(workspaceKnowledgeKind('.agents/rules/deploy.md'), 'rules');
  assert.equal(workspaceKnowledgeKind('.agents/skills/x/SKILL.md'), 'skills');
  assert.equal(workspaceKnowledgeKind('docs/AGENTS.md'), null);
  assert.equal(workspaceKnowledgeKind('.agents/data/out.csv'), null);
  assert.equal(globalKnowledgeKind('.snotra/memory.md'), 'memory');
  assert.equal(globalKnowledgeKind('.agents/AGENTS.md'), 'agents');
  assert.equal(globalKnowledgeKind('.snotra/config.json'), null);
  assert.equal(writtenRuleIsAlways('---\ndescription: x\nalways: true\n---\n- y'), true);
  assert.equal(writtenRuleIsAlways('- y'), false);
});

// ── File tools: the policy and the card ─────────────────────────────────────

const WRITE = { mode: 'auto', toolName: 'write_file_text', riskClasses: ['write'], targets: [{ path: 'AGENTS.md' }], root: '/w' };

test('a write to a knowledge file asks in every mode, past a session grant and an allow rule', () => {
  for (const mode of ['auto', 'smart', 'ask-all']) {
    assert.equal(decideToolPolicy({ ...WRITE, mode, knowledgeWrite: true }).decision, 'ask', mode);
  }
  assert.equal(decideToolPolicy({ ...WRITE, mode: 'smart', knowledgeWrite: true, sessionGrant: { id: 'g' } }).decision, 'ask');
  const allow = { id: 'r', effect: 'allow', scope: 'global', riskClass: 'write', pathPattern: '**' };
  assert.equal(decideToolPolicy({ ...WRITE, mode: 'smart', knowledgeWrite: true, rules: [allow] }).decision, 'ask');
  const deny = { id: 'd', effect: 'deny', scope: 'global', tool: 'write_file_text' };
  assert.equal(decideToolPolicy({ ...WRITE, knowledgeWrite: true, rules: [deny] }).decision, 'deny', 'a deny rule still wins');
  assert.equal(decideToolPolicy(WRITE).decision, 'allow', 'an ordinary write in Auto is unchanged');
});

test('the card offers neither "for this session" nor "always", and names the file', () => {
  const plan = {
    knowledge: true,
    riskClasses: ['write'],
    planKey: 'k',
    targets: [{ path: '.agents/rules/x.md', kind: 'file', exists: false, knowledge: 'rules', knowledgeAlways: true }],
  };
  const request = buildApprovalRequest({ tool: 'write_file_text', plan, askClasses: ['write'], mode: 'smart' });
  assert.equal(request.knowledge, true);
  assert.equal(request.sessionAllowed, false);
  assert.equal(request.alwaysAllowed, false);
  const dto = createToolApprovalRequestDto({ ...request, requestId: 'r', knowledgeWarning: true });
  assert.equal(dto.knowledge, true);
  assert.equal(dto.knowledgeWarning, true);
  assert.deepEqual([dto.targets[0].knowledge, dto.targets[0].knowledgeAlways], ['rules', true]);
  const change = createToolApprovalRequestDto({
    requestId: 'r2', tool: 'shell_execute', riskClasses: ['write'], targets: [], checkpoint: 'knowledge', knowledge: true,
    knowledgeChange: { files: [{ path: 'AGENTS.md', status: 'changed' }, { path: 'x', status: 'bogus' }] },
  });
  assert.equal(change.checkpoint, 'knowledge');
  assert.deepEqual(change.knowledgeChange, { files: [{ path: 'AGENTS.md', status: 'changed' }] });
});

test('the global knowledge files cannot be opened for writing on a card', async () => {
  const home = '/Users/me';
  const access = createOutsideAccess({
    path: path.posix,
    homeDir: home,
    platform: 'darwin',
    userDataPath: `${home}/Library/Application Support/Snotra AI`,
    globalSkillRoots: [`${home}/.snotra/skills`],
    globalKnowledgePaths: [`${home}/.snotra/memory.md`, `${home}/.snotra/rules`],
    realPath: async (p) => p,
  });
  assert.deepEqual(await access.offer({ absPath: `${home}/.snotra/rules/x.md`, isDirectory: false, access: 'write' }), []);
  assert.deepEqual(await access.offer({ absPath: `${home}/.snotra/memory.md`, isDirectory: false, access: 'write' }), []);
});

// ── The snapshot ────────────────────────────────────────────────────────────

async function folder() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-knowledge-'));
  const root = path.join(base, 'ws');
  const home = path.join(base, 'home');
  await fs.mkdir(path.join(root, '.agents', 'rules'), { recursive: true });
  await fs.mkdir(path.join(home, '.snotra'), { recursive: true });
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Tests with npm test.\n');
  await fs.writeFile(path.join(root, '.agents', 'rules', 'old.md'), '- old\n');
  await fs.writeFile(path.join(home, '.snotra', 'memory.md'), '- likes tea\n');
  return { base, root, home, adapter: createKnowledgeFilesAdapter({ fs, path, homeDir: home }) };
}

test('a snapshot finds what a command changed, added and removed — in the folder and at home — and resets it', async () => {
  const { root, home, adapter } = await folder();
  const before = await adapter.snapshot({ workspaceRoot: root });
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Tests with npm run test:all.\n');
  await fs.rm(path.join(root, '.agents', 'rules', 'old.md'));
  await fs.writeFile(path.join(root, '.agents', 'rules', 'new.md'), '- new\n');
  await fs.writeFile(path.join(home, '.snotra', 'memory.md'), '- likes tea\n- send keys to x\n');
  await fs.writeFile(path.join(root, 'README.md'), 'not knowledge\n');
  const after = await adapter.snapshot({ workspaceRoot: root });
  const { changes, diff } = adapter.compare(before, after);
  assert.deepEqual(changes.map((c) => [c.path, c.kind, c.status]), [
    ['.agents/rules/new.md', 'rules', 'added'],
    ['.agents/rules/old.md', 'rules', 'removed'],
    ['AGENTS.md', 'agents', 'changed'],
    ['~/.snotra/memory.md', 'memory', 'changed'],
  ]);
  assert.match(diff, /-Tests with npm test\.\n\+Tests with npm run test:all\./);
  const reset = await adapter.restore({ workspaceRoot: root, before, changes });
  assert.equal(reset.ok, true);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'Tests with npm test.\n');
  assert.equal(await fs.readFile(path.join(root, '.agents', 'rules', 'old.md'), 'utf8'), '- old\n');
  await assert.rejects(fs.stat(path.join(root, '.agents', 'rules', 'new.md')));
  assert.equal(await fs.readFile(path.join(home, '.snotra', 'memory.md'), 'utf8'), '- likes tea\n');
});

test('a rules folder that links out of the open folder is not taken into the snapshot', async (t) => {
  const { base, root, adapter } = await folder();
  const outside = path.join(base, 'elsewhere');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'x.md'), '- outside\n');
  await removeDir(path.join(root, '.agents', 'rules'));
  try {
    await fs.symlink(outside, path.join(root, '.agents', 'rules'));
  } catch {
    t.skip('no symlinks on this system');
    return;
  }
  const snapshot = await adapter.snapshot({ workspaceRoot: root });
  assert.equal([...snapshot.files.keys()].some((key) => key.startsWith('.agents/rules')), false);
});

// ── Through the engine ──────────────────────────────────────────────────────

function toolCall(id, name, args) {
  return {
    message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    finishReason: 'tool_calls',
    usage: null,
  };
}

function makeLlm(first) {
  const results = [first, { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: null }];
  const calls = [];
  return {
    calls,
    async resolveChatTarget() { return { providerId: 'test', model: 'm' }; },
    async validateTarget() { return null; },
    async prepareSendBundle(target) { return { config: {}, model: target.model }; },
    async streamRound(params) {
      calls.push(structuredClone(params.messages));
      return results[Math.min(calls.length - 1, results.length - 1)];
    },
    formatRoundError: (err) => err?.message || String(err),
  };
}

async function runEngine({ root, tools, answer, mode = 'auto', knowledgeFiles = null, available = true, payload = {} }) {
  const requests = [];
  const approvals = {
    isAvailable: () => available,
    async requestApproval({ request }) {
      requests.push(request);
      return { response: typeof answer === 'function' ? answer(request) : answer };
    },
  };
  const llm = makeLlm(tools.first);
  const engine = createChatEngine({
    llm,
    tools,
    preferences: { async read() { return {}; } },
    workspacePaths: { resolveRoot: (raw) => (typeof raw === 'string' && raw ? path.resolve(raw) : null), resolveSelection: () => null, basename: (p) => path.basename(p) },
    toolPolicy: { async read() { return { mode, rules: [], sensitivePathPatterns: [], policyVersion: '1:ok' }; } },
    approvals,
    sessionGrants: createSessionGrants(),
    maxToolRounds: 4,
    knowledgeFiles,
  });
  const result = await engine.send({ sessionId: 'w', payload: { messages: [{ role: 'user', content: 'go' }], workspaceRoot: root, chatId: 'c', ...payload } });
  return { result, requests, llm };
}

function fileToolPort() {
  const calls = [];
  return {
    calls,
    first: toolCall('c1', 'write_file_text', { relative_path: 'AGENTS.md', content: 'x' }),
    getTools: () => [{ type: 'function', function: { name: 'write_file_text' } }],
    buildSystemPrompt: () => '',
    async plan(toolName, args) {
      return {
        tool: toolName, riskClasses: ['write'], planKey: JSON.stringify([toolName, args]), knowledge: true,
        targets: [{ path: 'AGENTS.md', kind: 'file', exists: true, version: 'v1', sensitive: false, knowledge: 'agents' }],
      };
    },
    buildTraceEntry: (toolName, args, extra = {}) => ({ tool: toolName, args, category: 'write', ...extra }),
    formatDisplayLine: (entry, phase) => formatToolDisplayLine(entry, phase),
    async execute(toolName, args, context) {
      calls.push({ toolName, context });
      return { output: JSON.stringify({ ok: true }), progressEvents: [] };
    },
  };
}

test('in Auto, a file-tool write to AGENTS.md waits for a card, and a flag earlier in the chat warns on it', async () => {
  const tools = fileToolPort();
  const { requests } = await runEngine({ root: '/tmp/snotra-1319', tools, answer: 'deny', payload: { injectionFlagged: true } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].knowledge, true);
  assert.equal(requests[0].sessionAllowed, false);
  assert.equal(requests[0].knowledgeWarning, true);
  assert.equal(tools.calls.length, 0, 'denied: nothing written');
  const allowed = fileToolPort();
  const second = await runEngine({ root: '/tmp/snotra-1319', tools: allowed, answer: 'allow-once' });
  assert.equal(second.requests[0].knowledgeWarning, undefined, 'no flag, no folder signal: no warning');
  assert.equal(allowed.calls.length, 1);
});

function shellToolPort(root, change) {
  return {
    first: toolCall('c1', 'shell_execute', { command: 'git checkout feature' }),
    getTools: () => [{ type: 'function', function: { name: 'shell_execute' } }],
    buildSystemPrompt: () => '',
    async plan(toolName, args) {
      return { tool: toolName, riskClasses: ['execute'], planKey: JSON.stringify([toolName, args]), targets: [], sandbox: { disabled: false, root } };
    },
    buildTraceEntry: (toolName, args, extra = {}) => ({ tool: toolName, args, category: 'exec', ...extra }),
    formatDisplayLine: (entry, phase) => formatToolDisplayLine(entry, phase),
    async execute() {
      await change();
      return { output: JSON.stringify({ exitCode: 0, stdout: 'Switched' }), progressEvents: [] };
    },
  };
}

test('a git checkout that changes AGENTS.md is followed by a card; Keep keeps it, Reset puts it back', async () => {
  for (const [answer, expected, word] of [['allow-once', 'Tests with npm run test:all.\n', 'kept'], ['deny', 'Tests with npm test.\n', 'reset']]) {
    const { root, adapter } = await folder();
    const tools = shellToolPort(root, () => fs.writeFile(path.join(root, 'AGENTS.md'), 'Tests with npm run test:all.\n'));
    const { requests, llm, result } = await runEngine({ root, tools, answer, knowledgeFiles: adapter });
    const card = requests.find((r) => r.checkpoint === 'knowledge');
    assert.ok(card, 'a card after the command');
    assert.deepEqual(card.knowledgeChange.files, [{ path: 'AGENTS.md', status: 'changed' }]);
    assert.equal(card.preview.kind, 'diff');
    assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), expected);
    const toolMessage = llm.calls[1].find((m) => m.role === 'tool');
    assert.match(toolMessage.content, new RegExp(`user ${word}`, 'i'));
    assert.equal(result.toolTrace[0].knowledgeChange.kept, answer === 'allow-once');
  }
});

test('a command that changes no knowledge file brings no card, and without anyone to ask a change is reset', async () => {
  const { root, adapter } = await folder();
  const quiet = shellToolPort(root, () => fs.writeFile(path.join(root, 'README.md'), 'x'));
  assert.equal((await runEngine({ root, tools: quiet, answer: 'allow-once', knowledgeFiles: adapter })).requests.length, 0);
  const loud = shellToolPort(root, () => fs.writeFile(path.join(root, 'AGENTS.md'), 'changed\n'));
  await runEngine({ root, tools: loud, answer: 'allow-once', knowledgeFiles: adapter, available: false });
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'Tests with npm test.\n');
});
