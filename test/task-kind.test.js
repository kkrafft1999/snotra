const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TASK_KIND_IDS,
  TASK_KIND_DEFINITIONS,
  normalizeTaskKind,
  classifiedTaskKindId,
  mayReplaceTaskKind,
  wantsModelTaskKind,
  parseTaskKindAnswer,
  taskKindPromptList,
} = require('../src/shared/contracts/task-kind');
const { estimateTaskKind } = require('../src/application/chat/task-kind-estimate');
const en = require('../src/shared/i18n/messages/en');
const de = require('../src/shared/i18n/messages/de');

// The kinds of task (#1281, concept docs/concepts/task-kinds-concept.md).

const catalogue = (messages) => messages.default || messages.MESSAGES || messages;

test('seven fixed kinds, each with a definition and a name in both languages', () => {
  assert.deepEqual([...TASK_KIND_IDS], ['coding', 'writing', 'research', 'data', 'planning', 'organisation', 'other']);
  for (const id of TASK_KIND_IDS) {
    assert.ok(TASK_KIND_DEFINITIONS[id], `${id} has a definition`);
    assert.equal(catalogue(en)[`taskKind.${id}.definition`], TASK_KIND_DEFINITIONS[id], `${id}: the English catalogue says what the model reads`);
    for (const messages of [en, de]) {
      assert.ok(catalogue(messages)[`taskKind.${id}`], `${id} has a name`);
      assert.ok(catalogue(messages)[`taskKind.${id}.definition`], `${id} has a definition for the user`);
    }
  }
  // Unclassified is a word for the report, not a kind.
  assert.equal(TASK_KIND_IDS.includes('unclassified'), false);
  assert.equal(catalogue(de)['taskKind.unclassified'], 'Nicht eingeordnet');
  assert.match(taskKindPromptList(), /^- coding: Writing, changing/);
});

test('organisation is a kind of its own, and planning says where it ends (#1312)', () => {
  assert.equal(parseTaskKindAnswer('organisation'), 'organisation');
  assert.match(TASK_KIND_DEFINITIONS.organisation, /booking hours/);
  assert.match(TASK_KIND_DEFINITIONS.planning, /not managing tasks or time/);
  // Right after planning, so the two related kinds sit next to each other.
  assert.equal(TASK_KIND_IDS.indexOf('organisation'), TASK_KIND_IDS.indexOf('planning') + 1);
  assert.match(taskKindPromptList(), /\n- organisation: Managing tasks, time and files/);
  assert.equal(catalogue(en)['taskKind.organisation'], 'Organisation & admin');
  assert.equal(catalogue(de)['taskKind.organisation'], 'Organisation & Verwaltung');
});

test('a stored kind is normalised; an unknown one is kept but counts as unclassified', () => {
  const at = '2026-10-25T14:20:10.000Z';
  assert.deepEqual(normalizeTaskKind({ id: 'coding', source: 'model', at, extra: 1 }), { id: 'coding', source: 'model', at });
  assert.equal(classifiedTaskKindId({ id: 'coding', source: 'model', at }), 'coding');

  const newer = normalizeTaskKind({ id: 'translation', source: 'model', at });
  assert.deepEqual(newer, { id: 'translation', source: 'model', at });
  assert.equal(classifiedTaskKindId(newer), null);
  assert.equal(classifiedTaskKindId({ id: 'coding', source: 'guess', at }), null);

  for (const junk of [null, 'coding', [], { id: 'Coding!', source: 'model' }, { id: 'coding' }, { id: 'x'.repeat(41), source: 'user' }]) {
    assert.equal(normalizeTaskKind(junk), null);
  }
  // A time that is no time falls back to the epoch rather than losing the kind.
  assert.equal(normalizeTaskKind({ id: 'data', source: 'user', at: 'yesterday' }).at, new Date(0).toISOString());
});

test('precedence: user > model > estimate, and a kind from a newer version stays', () => {
  const kind = (source, id = 'coding') => ({ id, source, at: '2026-10-25T00:00:00.000Z' });
  assert.equal(mayReplaceTaskKind(undefined, 'estimate'), true);
  assert.equal(mayReplaceTaskKind(kind('estimate'), 'estimate'), true);
  assert.equal(mayReplaceTaskKind(kind('estimate'), 'model'), true);
  assert.equal(mayReplaceTaskKind(kind('model'), 'estimate'), false);
  assert.equal(mayReplaceTaskKind(kind('model'), 'user'), true);
  assert.equal(mayReplaceTaskKind(kind('user'), 'model'), false);
  assert.equal(mayReplaceTaskKind(kind('model', 'translation'), 'model'), false);

  assert.equal(wantsModelTaskKind(undefined), true);
  assert.equal(wantsModelTaskKind(kind('estimate')), true);
  assert.equal(wantsModelTaskKind(kind('model')), false);
  assert.equal(wantsModelTaskKind(kind('user')), false);
  assert.equal(wantsModelTaskKind(kind('estimate', 'translation')), false);
});

test('the model\'s answer is read leniently, and only the six ids count', () => {
  assert.equal(parseTaskKindAnswer('coding'), 'coding');
  assert.equal(parseTaskKindAnswer('  Kind: Data.'), 'data');
  assert.equal(parseTaskKindAnswer('`research`'), 'research');
  assert.equal(parseTaskKindAnswer('\nplanning\n'), 'planning');
  assert.equal(parseTaskKindAnswer('debugging'), null);
  assert.equal(parseTaskKindAnswer('unclassified'), null);
  assert.equal(parseTaskKindAnswer(''), null);
  assert.equal(parseTaskKindAnswer(undefined), null);
});

const turn = (...toolTrace) => [{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A', toolTrace }];
const wrote = (tool, relativePath) => ({ line: `Wrote ${relativePath}`, tool, changes: [{ id: 'c', relativePath }] });

test('the estimate follows the dominant signal of the tools', () => {
  assert.equal(estimateTaskKind(turn(wrote('edit_file', 'src/a.ts'))), 'coding');
  assert.equal(estimateTaskKind(turn({ line: 'Ran npm run build', tool: 'shell_execute' })), 'coding');
  assert.equal(estimateTaskKind(turn({ line: 'Ran script', tool: 'run_python' })), 'data');
  assert.equal(estimateTaskKind(turn({ line: 'Read sales.csv', tool: 'read_file_text' })), 'data');
  assert.equal(estimateTaskKind(turn(wrote('write_file_text', 'docs/letter.md'))), 'writing');
  assert.equal(estimateTaskKind(turn({ line: 'Searched', tool: 'web_search' }, { line: 'Fetched', tool: 'fetch_url' })), 'research');
  // Over several turns.
  assert.equal(estimateTaskKind([...turn(wrote('apply_patch', 'a.py')), ...turn(wrote('apply_patch', 'b.py'), wrote('edit_file', 'NOTES.md'))]), 'coding');
});

test('the estimate stays out of it when no signal dominates or none is there', () => {
  // No tools at all: most chats.
  assert.equal(estimateTaskKind([{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }]), null);
  // Code and prose written alike.
  assert.equal(estimateTaskKind(turn(wrote('edit_file', 'a.js'), wrote('edit_file', 'README.md'))), null);
  // Tabular data read while code is written counts for coding alone.
  assert.equal(estimateTaskKind(turn({ line: 'Read data.json', tool: 'read_file_text' }, wrote('edit_file', 'parse.js'))), 'coding');
  // Research only while nothing was written or run.
  assert.equal(estimateTaskKind(turn({ line: 'Searched', tool: 'web_search' }, { line: 'Ran ls', tool: 'shell_execute' })), null);
  assert.equal(estimateTaskKind(turn({ line: 'Searched', tool: 'web_search' }, wrote('edit_file', 'image.png'))), null);
  // Planning and other are never estimated; plain trace lines and junk are ignored.
  assert.equal(estimateTaskKind(turn('Listed .', null, { line: 'Remembered', tool: 'remember' })), null);
  assert.equal(estimateTaskKind(undefined), null);
});
