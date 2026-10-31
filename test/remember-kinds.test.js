// remember with a kind and a reader (#1276): facts and rules, for the user,
// Snotra in the folder or every tool through AGENTS.md; a card in every mode
// that the user can re-sort; replaces writes first and removes second.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  appendToSnotraSection,
  appendRuleEntry,
  newRuleFileText,
  removeEntriesByText,
} = require('../src/shared/contracts/knowledge-write');
const { createKnowledgeWriterAdapter } = require('../src/main/adapters/knowledge-writer-adapter');
const { createMemoryAdapter } = require('../src/main/adapters/memory-adapter');
const { createToolApprovalRequestDto, normalizeToolApprovalResponse } = require('../src/shared/contracts/tool-permissions');
const { createToolApprovalAdapter } = require('../src/main/adapters/tool-approval-adapter');
const { PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');

// ── The text ────────────────────────────────────────────────────────────────

test('Snotra\'s section is added at the end of AGENTS.md and grows there; the team\'s text stays', () => {
  const first = appendToSnotraSection('# Team\n\n- Tests with npm test.\n', '- 2026-10-31 — x', 'en');
  assert.equal(first, '# Team\n\n- Tests with npm test.\n\n## Added by Snotra\n\n- 2026-10-31 — x\n');
  const second = appendToSnotraSection(`${first}\n## Later section\n\n- y\n`, '- 2026-10-31 — z', 'de');
  assert.match(second, /- 2026-10-31 — x\n- 2026-10-31 — z\n\n## Later section/);
  assert.equal(appendToSnotraSection('', '- a', 'de'), '## Von Snotra ergänzt\n\n- a\n');
});

test('a rules file is created with its front matter; an existing one keeps always and may get a new description', () => {
  assert.equal(newRuleFileText({ description: 'When you commit', always: true, line: '- a' }), '---\ndescription: When you commit\nalways: true\n---\n\n- a\n');
  assert.equal(appendRuleEntry('---\ndescription: old\nalways: true\n---\n\n- a\n', { line: '- b', description: 'new' }),
    '---\ndescription: new\nalways: true\n---\n\n- a\n- b\n');
});

test('replaces removes list items by their text, dated or not, never a heading', () => {
  const { text, removed } = removeEntriesByText('# tea\n\n- 2026-10-01 (remembered on its own) — tea\n- coffee\n- tea\n', 'tea');
  assert.equal(removed, 2);
  assert.equal(text, '# tea\n\n- coffee\n');
});

// ── The writer ──────────────────────────────────────────────────────────────

async function writer({ selfAllowed = true } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-remember-'));
  const root = path.join(base, 'ws');
  const home = path.join(base, 'home');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const fakeOs = { homedir: () => home };
  const memory = createMemoryAdapter({ fs, path, os: fakeOs, isSelfMemoryAllowed: async () => selfAllowed, getLocale: () => 'en' });
  const port = createKnowledgeWriterAdapter({ fs, path, os: fakeOs, memory, isSelfMemoryAllowed: async () => selfAllowed, getLocale: () => 'en' });
  return { root, home, port };
}

const read = (file) => fs.readFile(file, 'utf8');

test('a fact goes into memory, a rule into a rules file, team into AGENTS.md — never ~/.agents or the global AGENTS.md', async () => {
  const { root, home, port } = await writer();
  await port.write({ kind: 'fact', scope: 'user', workspaceRoot: root, text: 'The beds are measured in centimetres.', origin: 'requested' });
  assert.match(await read(path.join(home, '.snotra', 'memory.md')), /centimetres/);
  await port.write({ kind: 'rule', scope: 'workspace', workspaceRoot: root, text: 'When you commit, write English.', topic: 'commit-messages', description: 'When you write a commit message', always: true, origin: 'self' });
  const rule = await read(path.join(root, '.agents', 'rules', 'commit-messages.md'));
  assert.match(rule, /^---\ndescription: When you write a commit message\nalways: true\n---\n\n- \d{4}-\d{2}-\d{2} \(remembered on its own\) — When you commit, write English\.\n$/);
  await port.write({ kind: 'rule', scope: 'user', workspaceRoot: root, text: 'When you answer me, answer in German.', topic: 'language', description: 'When you answer the user', origin: 'requested' });
  assert.match(await read(path.join(home, '.snotra', 'rules', 'language.md')), /answer in German/);
  await port.write({ kind: 'fact', scope: 'team', workspaceRoot: root, text: 'Tests run with npm test.', origin: 'requested' });
  assert.match(await read(path.join(root, 'AGENTS.md')), /## Added by Snotra\n\n- \d{4}-\d{2}-\d{2} — Tests run with npm test\./);
  await assert.rejects(fs.stat(path.join(home, '.agents')));
  await assert.rejects(fs.stat(path.join(home, '.snotra', 'AGENTS.md')));
});

test('nothing is written for an invalid topic, a missing description, no folder, a procedure, or the switch off', async () => {
  const { root, port } = await writer({ selfAllowed: false });
  const base = { kind: 'rule', scope: 'workspace', workspaceRoot: root, text: 'When x, y.', origin: 'requested' };
  assert.match((await port.describe({ ...base, topic: 'Bad Topic' })).refusal, /needs a topic/);
  assert.match((await port.describe({ ...base, topic: 'x' })).refusal, /needs a description/);
  assert.match((await port.describe({ ...base, scope: 'team', workspaceRoot: null, topic: 'x' })).refusal, /Without an open folder/);
  assert.match((await port.describe({ ...base, kind: 'instruction', scope: 'team' })).refusal, /no "team" reader/);
  await assert.rejects(port.write({ ...base, topic: 'x', description: 'When x', origin: 'self' }), /switched off/);
  await assert.rejects(fs.stat(path.join(root, '.agents')));
});

test('replaces: a memory entry becomes a rule — written first, removed second; a missing or ambiguous one is refused', async () => {
  const { root, port } = await writer();
  await port.write({ kind: 'fact', scope: 'workspace', workspaceRoot: root, text: 'Commit messages are English.', origin: 'requested' });
  const request = {
    kind: 'rule', scope: 'workspace', workspaceRoot: root, text: 'When you commit, write English.', topic: 'commit-messages',
    description: 'When you write a commit message', origin: 'requested', replaces: 'Commit messages are English.',
  };
  const described = await port.describe(request);
  assert.deepEqual(described.replaced, { text: 'Commit messages are English.', where: 'memory', count: 1 });
  const result = await port.write(request);
  assert.deepEqual(result.replaced, { removed: 1 });
  assert.equal((await read(path.join(root, '.agents', 'memory.md'))).includes('Commit messages are English.'), false);
  assert.match((await port.describe({ ...request, replaces: 'nothing like this' })).refusal, /not found/);
  await port.write({ kind: 'fact', scope: 'workspace', workspaceRoot: root, text: 'Twice.', origin: 'requested' });
  await port.write({ kind: 'fact', scope: 'team', workspaceRoot: root, text: 'Twice.', origin: 'requested' });
  assert.match((await port.describe({ ...request, replaces: 'Twice.' })).refusal, /more than one file/);
  assert.equal((await port.describe({ ...request, replaces: 'Twice.', replacesIn: 'agents' })).replaced.where, 'agents');
});

test('describe names the target, the alternatives the pills switch to, and what the folder brings', async () => {
  const { root, port } = await writer();
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# Team\n');
  const described = await port.describe({ kind: 'fact', scope: 'user', workspaceRoot: root, text: 'x', origin: 'requested' });
  assert.deepEqual(described.target, { path: '~/.snotra/memory.md', exists: false, file: 'memory' });
  assert.equal(described.alternatives.fact.team.path, 'AGENTS.md');
  assert.equal(described.alternatives.fact.workspace.path, '.agents/memory.md');
  assert.deepEqual(described.folderInstructions, { agentsMd: true, rulesFiles: 0 });
  const noFolder = await port.describe({ kind: 'fact', scope: 'user', workspaceRoot: null, text: 'x', origin: 'requested' });
  assert.equal(noFolder.alternatives.fact.team, null);
});

// ── The card and the answer ─────────────────────────────────────────────────

const CARD = {
  kind: 'rule', scope: 'workspace', entry: 'When x, y.', origin: 'requested', topic: 't', description: 'When x',
  target: { path: '.agents/rules/t.md', exists: false, file: 'rules' },
  alternatives: {
    fact: { user: { path: '~/.snotra/memory.md', exists: true, file: 'memory' }, workspace: { path: '.agents/memory.md', exists: false, file: 'memory' }, team: { path: 'AGENTS.md', exists: true, file: 'agents' } },
    rule: { user: { path: '~/.snotra/rules/t.md', exists: false, file: 'rules' }, workspace: { path: '.agents/rules/t.md', exists: false, file: 'rules' }, team: { path: 'AGENTS.md', exists: true, file: 'agents' } },
  },
  folderInstructions: { agentsMd: true, rulesFiles: 2 },
  bogus: 'dropped',
};

test('the card travels sanitised, and a choice only to what the card offered', () => {
  const dto = createToolApprovalRequestDto({ requestId: 'r', tool: 'remember', riskClasses: ['write'], targets: [], knowledge: true, knowledgeCard: CARD });
  assert.equal(dto.knowledgeCard.kind, 'rule');
  assert.equal('bogus' in dto.knowledgeCard, false);
  assert.equal(normalizeToolApprovalResponse({ requestId: 'r', response: 'allow-once', knowledgeChoice: { kind: 'fact', scope: 'team' } }).knowledgeChoice.scope, 'team');
  assert.equal(normalizeToolApprovalResponse({ requestId: 'r', response: 'allow-once', knowledgeChoice: { kind: 'x', scope: 'team' } }).knowledgeChoice, undefined);

  const outcomes = [];
  let counter = 0;
  const approvals = createToolApprovalAdapter({ randomUUID: () => `req-${(counter += 1)}`, PUSH, log: { warn() {} } });
  approvals.subscribe(1, { id: 1, isDestroyed: () => false, send() {}, once() {}, on() {} });
  const ask = async (choice) => {
    const pending = approvals.requestApproval({ sessionId: 1, request: { tool: 'remember', riskClasses: ['write'], targets: [], knowledge: true, knowledgeCard: CARD } });
    const [open] = approvals.listPending(1);
    approvals.respond(1, { requestId: open.requestId, response: 'allow-once', knowledgeChoice: choice });
    outcomes.push(await pending);
  };
  return ask({ kind: 'fact', scope: 'team' })
    .then(() => ask({ kind: 'instruction', scope: 'team' }))
    .then(() => {
      assert.deepEqual(outcomes[0].knowledgeChoice, { kind: 'fact', scope: 'team' });
      assert.equal(outcomes[1].knowledgeChoice, undefined, 'a procedure has no team reader');
    });
});

// ── Through the engine ──────────────────────────────────────────────────────

const { createChatEngine } = require('../src/application/chat/chat-engine');
const { createSessionGrants } = require('../src/application/permissions/session-grants');

function engineRun({ args, choice, mode = 'auto' }) {
  const requests = [];
  const executed = [];
  const tools = {
    getTools: () => [{ type: 'function', function: { name: 'remember' } }],
    buildSystemPrompt: () => '',
    async plan(toolName, planned) {
      return {
        tool: toolName, riskClasses: ['write'], targets: [], planKey: JSON.stringify(planned), knowledge: true,
        knowledgeCard: { ...CARD, kind: planned.kind, scope: planned.scope },
      };
    },
    buildTraceEntry: (toolName, a, extra = {}) => ({ tool: toolName, args: a, category: 'write', ...extra }),
    formatDisplayLine: () => '',
    async execute(toolName, a) {
      executed.push({ ...a });
      return { output: JSON.stringify({ ok: true }) };
    },
  };
  const llm = {
    calls: [],
    async resolveChatTarget() { return { providerId: 'test', model: 'm' }; },
    async validateTarget() { return null; },
    async prepareSendBundle(target) { return { config: {}, model: target.model }; },
    async streamRound(params) {
      this.calls.push(structuredClone(params.messages));
      return this.calls.length === 1
        ? { message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'remember', arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls', usage: null }
        : { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: null };
    },
    formatRoundError: (err) => err?.message || String(err),
  };
  const engine = createChatEngine({
    llm,
    tools,
    preferences: { async read() { return {}; } },
    workspacePaths: { resolveRoot: (raw) => raw || null, resolveSelection: () => null, basename: (p) => path.basename(p) },
    toolPolicy: { async read() { return { mode, rules: [], sensitivePathPatterns: [], policyVersion: '1:ok' }; } },
    approvals: {
      isAvailable: () => true,
      async requestApproval({ request }) {
        requests.push(request);
        return { response: 'allow-once', ...(choice ? { knowledgeChoice: choice } : {}) };
      },
    },
    sessionGrants: createSessionGrants(),
    maxToolRounds: 4,
  });
  return engine.send({ sessionId: 'w', payload: { messages: [{ role: 'user', content: 'go' }], workspaceRoot: '/tmp/snotra-1276', chatId: 'c' } })
    .then((result) => ({ result, requests, executed, llm }));
}

const RULE_ARGS = { kind: 'rule', scope: 'workspace', text: 'When x, y.', topic: 't', description: 'When x', origin: 'requested' };

test('in Auto the remember card asks; another reader chosen on it is written without a second card', async () => {
  const { requests, executed } = await engineRun({ args: RULE_ARGS, choice: { kind: 'rule', scope: 'team' } });
  assert.equal(requests.length, 1, 'one card');
  assert.equal(requests[0].knowledgeCard.kind, 'rule');
  assert.equal(executed.length, 1);
  assert.equal(executed[0].scope, 'team');
});

test('a rule turned into a fact on the card loses its rule fields and is written', async () => {
  const { executed } = await engineRun({ args: RULE_ARGS, choice: { kind: 'fact', scope: 'workspace' } });
  assert.deepEqual(executed[0], { kind: 'fact', scope: 'workspace', text: 'When x, y.', origin: 'requested' });
});

test('a fact turned into a rule goes back to the model to be worded, and nothing is written', async () => {
  const { executed, llm } = await engineRun({ args: { kind: 'fact', scope: 'user', text: 'x', origin: 'requested' }, choice: { kind: 'rule', scope: 'user' } });
  assert.equal(executed.length, 0);
  const toolMessage = llm.calls[1].find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /wants this stored as a rule/);
});
