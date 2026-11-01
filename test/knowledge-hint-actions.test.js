// The actions behind the hints of Settings › Knowledge (#1279): Remove, Edit,
// Move to rules…, Create a skill…, Merge… — each named by the hint's ref,
// carried out in main, written to the journal with Undo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createKnowledgeJournal } = require('../src/main/services/knowledge-journal');
const { registerKnowledgeHandlers } = require('../src/main/ipc/knowledge-handlers');
const { createRulesAdapter } = require('../src/main/adapters/rules-adapter');
const { createProjectInstructionsAdapter } = require('../src/main/adapters/project-instructions-adapter');
const { createMemoryAdapter } = require('../src/main/adapters/memory-adapter');
const { createKnowledgeWriterAdapter } = require('../src/main/adapters/knowledge-writer-adapter');
const { mergedText, removeNthEntry } = require('../src/main/services/knowledge-hint-actions');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');

const NOW = new Date('2026-10-31T12:00:00Z');

async function setup({ memory = '', userMemory = '', rules = {} } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-hint-actions-'));
  const root = path.join(base, 'ws');
  const home = path.join(base, 'home');
  await fs.mkdir(path.join(root, '.agents', 'rules'), { recursive: true });
  await fs.mkdir(path.join(home, '.snotra'), { recursive: true });
  if (memory) await fs.writeFile(path.join(root, '.agents', 'memory.md'), memory);
  if (userMemory) await fs.writeFile(path.join(home, '.snotra', 'memory.md'), userMemory);
  for (const [name, text] of Object.entries(rules)) await fs.writeFile(path.join(root, '.agents', 'rules', `${name}.md`), text);
  const fakeOs = { homedir: () => home };
  let prefs = {};
  const journal = createKnowledgeJournal({ fs, path, file: path.join(base, 'journal.json'), homeDir: home });
  const memoryPort = createMemoryAdapter({ fs, path, os: fakeOs });
  const opened = [];
  const registered = new Map();
  registerKnowledgeHandlers({
    ipcMain: { handle: (channel, fn) => registered.set(channel, fn) },
    REQ,
    knowledge: {
      rules: createRulesAdapter({ fs, path, os: fakeOs }),
      projectInstructions: createProjectInstructionsAdapter({ fs, path, os: fakeOs }),
      journal,
      knowledgeWriter: createKnowledgeWriterAdapter({ fs, path, os: fakeOs, memory: memoryPort, journal }),
    },
    memory: memoryPort,
    uiPrefsStore: { readUIPrefs: async () => ({ ...prefs }), updateUIPrefs: async (update) => { prefs = await update({ ...prefs }); return prefs; } },
    getActiveWorkspaceRoot: () => root,
    shell: { openPath: async (file) => { opened.push(file); return ''; } },
    fs,
    path,
    homeDir: home,
    now: () => NOW,
  });
  const call = (channel, payload) => registered.get(channel)({}, payload);
  const hintOf = async (id, text) => (await call(REQ.KNOWLEDGE_GET_STATE)).hints.find((hint) => hint.id === id && (!text || hint.at.text === text || hint.at.name === text));
  const read = (...parts) => fs.readFile(path.join(...parts), 'utf8');
  return { root, home, call, hintOf, read, journal, opened };
}

test('Remove takes the one memory entry off, lands in the journal as settings, and Undo puts it back', async () => {
  const { root, call, hintOf, read, journal } = await setup({ memory: '# Memory\n\n- 2026-10-29 — Today we fixed the login bug.\n- 2026-10-01 — Tests run with npm test.\n' });
  const hint = await hintOf('looksLikeEpisode');
  assert.deepEqual(hint.actions, ['remove']);
  const result = await call(REQ.KNOWLEDGE_HINT_ACTION, { ref: hint.ref, action: 'remove' });
  assert.equal(result.ok, true);
  assert.doesNotMatch(await read(root, '.agents', 'memory.md'), /login/);
  assert.equal(result.state.hints.some((item) => item.id === 'looksLikeEpisode'), false);
  const [entry] = await journal.list();
  assert.deepEqual([entry.source, entry.path], ['settings', '.agents/memory.md']);
  assert.deepEqual(await journal.undo(entry.id), { ok: true });
  assert.match(await read(root, '.agents', 'memory.md'), /login/);
});

test('Remove on a rules entry takes only its own copy, never its twin', async () => {
  const twin = '- 2026-10-28 — The deploy is failing right now.';
  const { root, call, hintOf, read } = await setup({ rules: { deploy: `# Deploying\n\n${twin}\n- Never on Fridays.\n${twin}\n` } });
  const hints = (await call(REQ.KNOWLEDGE_GET_STATE)).hints.filter((hint) => hint.id === 'nearlyTheSame');
  assert.equal(hints.length, 2);
  assert.equal((await call(REQ.KNOWLEDGE_HINT_ACTION, { ref: hints[1].ref, action: 'remove' })).ok, true);
  const text = await read(root, '.agents', 'rules', 'deploy.md');
  assert.equal(text.split('failing right now').length - 1, 1, text);
  assert.match(text, /^# Deploying\n\n- 2026-10-28 — The deploy is failing right now\.\n- Never on Fridays\.\n?$/);
  assert.ok(await hintOf('looksLikeEpisode'), 'the remaining copy still reads like an episode');
});

test('Edit opens the file the entry is in; a hint never offers what it does not have', async () => {
  const { root, call, hintOf, opened } = await setup({ memory: '- 2025-01-01 — The beds are measured in centimetres.\n' });
  const hint = await hintOf('notedAWhileAgo');
  assert.deepEqual(hint.actions, ['remove', 'edit']);
  assert.equal((await call(REQ.KNOWLEDGE_HINT_ACTION, { ref: hint.ref, action: 'edit' })).ok, true);
  assert.deepEqual(opened, [path.join(root, '.agents', 'memory.md')]);
  assert.equal((await call(REQ.KNOWLEDGE_HINT_ACTION, { ref: hint.ref, action: 'merge' })).ok, false);
  assert.equal((await call(REQ.KNOWLEDGE_HINT_ACTION, { ref: 'made-up', action: 'remove' })).ok, false);
});

test('Move to rules writes the rule at the fact\'s level and the fact leaves memory', async () => {
  const fact = 'Whenever you write a commit message, write it in English.';
  const { root, call, hintOf, read, journal } = await setup({ memory: `- 2026-10-31 — ${fact}\n- 2026-10-01 — Tests run with npm test.\n` });
  const hint = await hintOf('factLooksLikeRule');
  const refused = await call(REQ.KNOWLEDGE_HINT_ACTION, { ref: hint.ref, action: 'moveToRules', choice: { level: 'workspace', topic: 'commit-messages' } });
  assert.deepEqual(refused.error, { key: 'settings.knowledge.error.description' }, 'a new rules file needs its description');
  const moved = await call(REQ.KNOWLEDGE_HINT_ACTION, { ref: hint.ref, action: 'moveToRules', choice: { level: 'workspace', topic: 'commit-messages', description: 'When you write a commit message' } });
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.done, { action: 'moveToRules', topic: 'commit-messages' });
  assert.match(await read(root, '.agents', 'rules', 'commit-messages.md'), /^---\ndescription: When you write a commit message\n---[\s\S]*write it in English\./);
  assert.doesNotMatch(await read(root, '.agents', 'memory.md'), /commit message/);
  assert.deepEqual((await journal.list()).map((entry) => entry.source), ['settings', 'settings']);
});

test('Move to rules at the other level writes there, and an existing file needs no description', async () => {
  const fact = 'Always answer in German.';
  const { root, home, call, hintOf, read } = await setup({ memory: `- 2026-10-31 — ${fact}\n` });
  await fs.mkdir(path.join(home, '.snotra', 'rules'), { recursive: true });
  await fs.writeFile(path.join(home, '.snotra', 'rules', 'language.md'), '---\ndescription: When you answer me\n---\n\n- Short sentences.\n');
  const hint = await hintOf('factLooksLikeRule');
  const moved = await call(REQ.KNOWLEDGE_HINT_ACTION, { ref: hint.ref, action: 'moveToRules', choice: { level: 'user', topic: 'language' } });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.match(await read(home, '.snotra', 'rules', 'language.md'), /Short sentences\.\n- \d{4}-\d{2}-\d{2} — Always answer in German\./);
  assert.doesNotMatch(await read(root, '.agents', 'memory.md'), /German/);
});

test('Create a skill writes SKILL.md at the fact\'s level and never over an existing skill', async () => {
  const steps = 'To release: first bump the version, then tag it, then push the tag.';
  const { root, call, hintOf, read } = await setup({ memory: `- 2026-10-30 — ${steps}\n` });
  const hint = await hintOf('factLooksLikeProcedure');
  assert.deepEqual(hint.actions, ['createSkill']);
  await fs.mkdir(path.join(root, '.agents', 'skills', 'taken'), { recursive: true });
  const taken = await call(REQ.KNOWLEDGE_HINT_ACTION, { ref: hint.ref, action: 'createSkill', choice: { name: 'taken', description: 'Releasing' } });
  assert.deepEqual(taken.error, { key: 'settings.knowledge.hint.error.skillExists', params: { name: 'taken' } });
  assert.equal((await call(REQ.KNOWLEDGE_HINT_ACTION, { ref: hint.ref, action: 'createSkill', choice: { name: '../x', description: 'x' } })).ok, false);
  const made = await call(REQ.KNOWLEDGE_HINT_ACTION, { ref: hint.ref, action: 'createSkill', choice: { name: 'release', description: 'When you cut a release' } });
  assert.equal(made.ok, true, JSON.stringify(made));
  const skill = await read(root, '.agents', 'skills', 'release', 'SKILL.md');
  assert.match(skill, /name: release/);
  assert.match(skill, /When you cut a release/);
  assert.match(skill, /first bump the version/);
  assert.doesNotMatch(await read(root, '.agents', 'memory.md'), /release/);
});

test('Merge moves the other file\'s rules into the kept one, without duplicates, and removes it', async () => {
  const { root, call, hintOf, read, journal } = await setup({ rules: {
    commit: '---\ndescription: When you commit\n---\n\n- Write in English.\n',
    commits: '---\ndescription: When you write a commit\n---\n\n## Style\n\n- write in english\n- Write in English.\n- Link the issue.\n',
  } });
  const hint = await hintOf('similarTopicNames', 'commit');
  assert.deepEqual(hint.actions, ['merge']);
  assert.equal((await call(REQ.KNOWLEDGE_HINT_ACTION, { ref: hint.ref, action: 'merge', choice: { keep: 'other' } })).ok, false);
  const merged = await call(REQ.KNOWLEDGE_HINT_ACTION, { ref: hint.ref, action: 'merge', choice: { keep: 'commit' } });
  assert.deepEqual(merged.done, { action: 'merge', kept: 'commit', removed: 'commits' });
  assert.equal(await read(root, '.agents', 'rules', 'commit.md'),
    '---\ndescription: When you commit\n---\n\n- Write in English.\n\n## Style\n\n- write in english\n- Link the issue.\n');
  await assert.rejects(fs.stat(path.join(root, '.agents', 'rules', 'commits.md')));
  const removedEntry = (await journal.list()).find((entry) => entry.path === '.agents/rules/commits.md');
  assert.deepEqual(await journal.undo(removedEntry.id), { ok: true });
  assert.match(await read(root, '.agents', 'rules', 'commits.md'), /Link the issue/);
});

test('Merge is not offered for a file of ~/.agents/rules, which Snotra does not write', async () => {
  const { home, call } = await setup();
  await fs.mkdir(path.join(home, '.snotra', 'rules'), { recursive: true });
  await fs.mkdir(path.join(home, '.agents', 'rules'), { recursive: true });
  await fs.writeFile(path.join(home, '.snotra', 'rules', 'commit.md'), '- a\n');
  await fs.writeFile(path.join(home, '.agents', 'rules', 'commits.md'), '- b\n');
  const hints = (await call(REQ.KNOWLEDGE_GET_STATE)).hints.filter((hint) => hint.id === 'similarTopicNames');
  assert.equal(hints.length, 2);
  assert.deepEqual(hints.map((hint) => hint.actions), [[], []]);
});

test('mergedText and removeNthEntry keep everything they are not asked to drop', () => {
  assert.equal(mergedText('- a\n', '---\ndescription: x\n---\n\n- a\n- b\n'), '- a\n\n- b\n');
  assert.equal(mergedText('- a\n', '- a\n'), '- a\n');
  assert.equal(removeNthEntry('- x\n- y\n- x\n', '- x\n- y\n- x\n', 2, 'x'), '- x\n- y\n');
  assert.equal(removeNthEntry('- y\n', '- y\n', 0, 'x'), null);
});
