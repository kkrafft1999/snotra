// remember with kind "instruction" (#1314): a procedure becomes a skill,
// written as a whole version — text only, at the folder or the global level,
// never for "team", never a system skill — and the card shows its diff.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createKnowledgeWriterAdapter } = require('../src/main/adapters/knowledge-writer-adapter');
const { createMemoryAdapter } = require('../src/main/adapters/memory-adapter');
const { checkSkillDocument } = require('../src/shared/runtime/skill-frontmatter');
const { createToolApprovalRequestDto } = require('../src/shared/contracts/tool-permissions');

async function writer() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-remember-skill-'));
  const root = path.join(base, 'ws');
  const home = path.join(base, 'home');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const fakeOs = { homedir: () => home };
  const memory = createMemoryAdapter({ fs, path, os: fakeOs, isSelfMemoryAllowed: async () => true });
  return { root, home, port: createKnowledgeWriterAdapter({ fs, path, os: fakeOs, memory, isSelfMemoryAllowed: async () => true }) };
}

const SKILL = {
  kind: 'instruction', scope: 'workspace', topic: 'release', description: 'How a release is cut: bump, tag, push',
  body: '# Cutting a release\n\n1. Bump the version.\n2. Tag it.\n3. Push the tag.', origin: 'requested',
};

test('a procedure becomes a skill in the folder, with name, description and metadata — a valid skill', async () => {
  const { root, port } = await writer();
  const described = await port.describe({ ...SKILL, workspaceRoot: root });
  assert.deepEqual(described.target, { path: '.agents/skills/release/SKILL.md', exists: false, file: 'skills' });
  assert.equal(described.skill.kind, 'text');
  assert.match(described.skill.text, /1\. Bump the version\./);
  await port.write({ ...SKILL, workspaceRoot: root });
  const text = await fs.readFile(path.join(root, '.agents', 'skills', 'release', 'SKILL.md'), 'utf8');
  assert.match(text, /^---\nname: release\ndescription: "How a release is cut: bump, tag, push"\nmetadata:\n  remembered: '\d{4}-\d{2}-\d{2}'\n  origin: requested\n---\n\n# Cutting a release/);
  assert.equal(checkSkillDocument(text, 'release').ok, true);
  assert.deepEqual(await fs.readdir(path.join(root, '.agents', 'skills', 'release')), ['SKILL.md'], 'text only');
});

test('a procedure written with replaces removes the fact it replaces from memory', async () => {
  const { root, port } = await writer();
  const fact = 'First bump the version, then tag it, then push the tag.';
  await port.write({ kind: 'fact', scope: 'workspace', text: fact, origin: 'requested', workspaceRoot: root });
  const result = await port.write({ ...SKILL, workspaceRoot: root, replaces: fact });
  assert.equal(result.text, 'release');
  assert.deepEqual(result.replaced, { removed: 1 });
  const memory = await fs.readFile(path.join(root, '.agents', 'memory.md'), 'utf8');
  assert.equal(memory.includes(fact), false);
});

test('a global skill goes to ~/.snotra/skills, never ~/.agents/skills; a new version replaces the old and the card shows the diff', async () => {
  const { root, home, port } = await writer();
  await port.write({ ...SKILL, scope: 'user', workspaceRoot: root });
  const next = { ...SKILL, scope: 'user', workspaceRoot: root, description: undefined, body: '# Cutting a release\n\n1. Bump the version.\n2. Run the tests.\n3. Tag it.\n4. Push the tag.' };
  const described = await port.describe(next);
  assert.equal(described.skill.kind, 'diff');
  assert.match(described.skill.text, /\+2\. Run the tests\./);
  assert.equal(described.skill.description, 'How a release is cut: bump, tag, push');
  await port.write(next);
  const text = await fs.readFile(path.join(home, '.snotra', 'skills', 'release', 'SKILL.md'), 'utf8');
  assert.match(text, /description: "How a release is cut: bump, tag, push"/, 'the description stays when none is given');
  assert.match(text, /2\. Run the tests\.\n3\. Tag it\./, 'the whole version, in its order');
  assert.equal((text.match(/Bump the version/g) || []).length, 1, 'not appended');
  await assert.rejects(fs.stat(path.join(home, '.agents')));
});

test('a procedure is refused for team, a system skill\'s name, no body, too long a body, no folder, or no description when new', async () => {
  const { root, port } = await writer();
  const refusal = async (request) => (await port.describe({ ...SKILL, workspaceRoot: root, ...request })).refusal;
  assert.match(await refusal({ scope: 'team' }), /no "team" reader/);
  assert.match(await refusal({ topic: 'snotra-memory' }), /built into Snotra/);
  assert.match(await refusal({ body: '' }), /needs its steps/);
  assert.match(await refusal({ body: 'x'.repeat(20_001) }), /at most 20000/);
  assert.match(await refusal({ workspaceRoot: null }), /Without an open folder/);
  assert.match(await refusal({ description: undefined }), /needs a description/);
  await assert.rejects(fs.stat(path.join(root, '.agents')));
});

test('the card carries the skill\'s body or diff to the renderer', () => {
  const dto = createToolApprovalRequestDto({
    requestId: 'r', tool: 'remember', riskClasses: ['write'], targets: [], knowledge: true,
    knowledgeCard: {
      kind: 'instruction', scope: 'user', entry: '', origin: 'requested', topic: 'release',
      target: { path: '~/.snotra/skills/release/SKILL.md', exists: true, file: 'skills' },
      alternatives: {}, folderInstructions: { agentsMd: false, rulesFiles: 0 },
      skill: { description: 'old', kind: 'diff', text: '+2. Run the tests.', truncated: false },
    },
  });
  assert.deepEqual(dto.knowledgeCard.skill, { description: 'old', kind: 'diff', text: '+2. Run the tests.', truncated: false });
});
