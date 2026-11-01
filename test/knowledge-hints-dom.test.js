// The hint lines of Settings › Knowledge (#1279, variant A) as the page draws
// them: one line under an entry, "+N more" for the rest, the entries of a
// rules file behind a disclosure, and every button asking main by the hint's
// ref — Dismiss by its key.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, focusFixup } = require('./helpers/dom.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const at = (line, text) => ({ kind: 'memory', scope: 'workspace', line, date: '2026-02-01', text });
const STATE = {
  workspaceRoot: '/w',
  rules: [
    { level: 'workspace', enabled: true, available: true, dir: '.agents/rules', inSubfolders: 0, overLimit: 0, invalid: [], files: [
      { source: 'workspace', name: 'commit', path: '.agents/rules/commit.md', description: 'When you commit', always: false, descriptionDerived: false, chars: 20, truncated: false, shadowed: false, key: 'k1', on: true, covert: [] },
      { source: 'workspace', name: 'commits', path: '.agents/rules/commits.md', description: 'When you commit', always: false, descriptionDerived: false, chars: 20, truncated: false, shadowed: false, key: 'k2', on: true, covert: [] },
    ] },
    { level: 'user', enabled: true, available: true, dir: '~/.snotra/rules', inSubfolders: 0, overLimit: 0, invalid: [], files: [] },
  ],
  agents: { enabled: true, files: [] },
  memoryCovert: [],
  journal: [],
  hints: [
    { id: 'factLooksLikeRule', key: 'r', ref: 'r@1', dismissible: true, actions: ['moveToRules'], at: at(2, 'Always answer in German.') },
    { id: 'looksLikeEpisode', key: 'e', ref: 'e@3', dismissible: true, actions: ['remove'], at: at(3, 'The deploy is failing right now.') },
    { id: 'notedAWhileAgo', key: 'n', ref: 'n@3', dismissible: true, actions: ['remove', 'edit'], date: '2026-02-01', at: at(3, 'The deploy is failing right now.') },
    { id: 'similarTopicNames', key: 's', ref: 's@a', dismissible: true, actions: ['merge'],
      at: { kind: 'ruleFile', level: 'workspace', source: 'workspace', name: 'commit' }, with: { kind: 'ruleFile', level: 'workspace', source: 'workspace', name: 'commits' } },
    { id: 'looksLikeEpisode', key: 'x', ref: 'x@r', dismissible: true, actions: ['remove'],
      at: { kind: 'rule', level: 'workspace', source: 'workspace', name: 'commits', line: 4, date: null, text: 'The build is red today.' } },
    { id: 'closeToLimit', key: 'c', ref: 'c@m', dismissible: false, actions: [], share: 0.86, at: { kind: 'memoryFile', scope: 'workspace' } },
  ],
};
const MEMORY = {
  available: true,
  selfEnabled: true,
  scopes: [{
    scope: 'workspace', path: '/w/.agents/memory.md', shortPath: '.agents/memory.md', folderName: 'w', enabled: true, chars: 6900, maxChars: 8000, truncated: false,
    entries: [
      { line: 2, date: '2026-10-31', text: 'Always answer in German.', origin: 'requested' },
      { line: 3, date: '2026-02-01', text: 'The deploy is failing right now.', origin: 'requested' },
      { line: 4, date: '2026-10-01', text: 'Tests run with npm test.', origin: 'requested' },
    ],
  }],
};

async function mount({ locale = 'en', state = STATE } = {}) {
  const dom = setupRendererDom();
  const { setLocale } = await importRenderer('i18n.js');
  setLocale(locale, { force: true });
  const { createKnowledgeHints } = await importRenderer('components', 'KnowledgeHints.js');
  const { initKnowledgePanel } = await importRenderer('components', 'KnowledgePanel.js');
  const { initMemoryPanel } = await importRenderer('components', 'MemoryPanel.js');
  const calls = [];
  const api = {
    getKnowledgeState: async () => structuredClone(state),
    getMemory: async () => structuredClone(MEMORY),
    setUIPrefs: async (prefs) => prefs,
    dismissKnowledgeHint: async (key) => { calls.push(['dismiss', key]); return { ok: true, state }; },
    knowledgeHintAction: async (ref, action, choice) => { calls.push([action, ref, choice]); return { ok: true, done: { action, topic: choice?.topic, kept: choice?.keep, removed: 'commits' }, state }; },
  };
  const hints = createKnowledgeHints({ api });
  const facts = initMemoryPanel({ api, hints });
  const knowledge = initKnowledgePanel({ api, hints });
  hints.reload = () => knowledge.refresh();
  hints.refreshAll = async () => { await knowledge.refresh(); await facts.refresh(); };
  await hints.refreshAll();
  const doc = dom.document;
  return { dom, doc, calls, facts: doc.getElementById('settings-memory-scopes'), rules: doc.getElementById('settings-knowledge-rules') };
}

const item = (host, text) => [...host.querySelectorAll('.memory-item')].find((node) => node.querySelector('.memory-item__text').textContent.startsWith(text));
const button = (scope, label) => [...scope.querySelectorAll('button')].find((node) => node.textContent === label);

test('one line per entry, the rest behind "+N more", none on an entry without a hint', async (t) => {
  const { dom, facts } = await mount();
  t.after(dom.cleanup);
  assert.match(item(facts, 'Always').querySelector('.knowledge-hint').textContent, /Reads like a rule.*Move to rules….*Dismiss/);
  const deploy = item(facts, 'The deploy');
  assert.equal(deploy.querySelectorAll('.knowledge-hint').length, 2);
  const rest = deploy.querySelector('.knowledge-hints__rest');
  assert.equal(rest.hidden, true);
  const more = deploy.querySelector('.knowledge-hint__more');
  assert.equal(more.textContent, '+1 more');
  more.click();
  assert.equal(rest.hidden, false);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.match(rest.textContent, /Noted on 2026-02-01 — still true\?/);
  assert.equal(item(facts, 'Tests run').querySelector('.knowledge-hint'), null);
  assert.match(facts.querySelector('.memory-card > .knowledge-hints').textContent, /86 % used/);
  assert.equal(button(facts.querySelector('.memory-card > .knowledge-hints'), 'Dismiss'), undefined, 'close to the limit is a state');
  const group = item(facts, 'Always').querySelector('.knowledge-hint');
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(group.getAttribute('aria-label'), 'Reads like a rule');
  assert.equal(group.getAttribute('aria-describedby'), item(facts, 'Always').querySelector('.memory-item__text').id);
});

test('Dismiss sends the hint\'s key; Remove sends its ref and says what happened', async (t) => {
  const { dom, doc, facts, calls } = await mount();
  t.after(dom.cleanup);
  button(item(facts, 'Always'), 'Dismiss').click();
  await flush(); await flush(); await flush();
  assert.deepEqual(calls.at(-1), ['dismiss', 'r']);
  assert.match(facts.previousElementSibling.textContent, /Hint dismissed/);
  assert.equal(doc.activeElement, facts.previousElementSibling, 'the keyboard lands on what happened');
  button(item(facts, 'The deploy'), 'Remove').click();
  await flush(); await flush(); await flush();
  assert.deepEqual(calls.at(-1).slice(0, 2), ['remove', 'e@3']);
});

test('Move to rules… asks level, file and description in a form; Escape closes it and the focus goes back', async (t) => {
  const { dom, doc, facts, calls } = await mount();
  t.after(dom.cleanup);
  focusFixup?.(doc);
  const trigger = button(item(facts, 'Always'), 'Move to rules…');
  trigger.click();
  const form = item(facts, 'Always').querySelector('.knowledge-hint-form');
  assert.ok(form);
  const [level, topic, description] = form.querySelectorAll('select, input');
  assert.equal(level.value, 'workspace');
  topic.value = 'commit';
  topic.dispatchEvent(new dom.window.Event('input'));
  assert.equal(description.required, false, 'an existing file needs no description');
  assert.match(form.textContent, /added to commit\.md/);
  topic.value = 'language';
  topic.dispatchEvent(new dom.window.Event('input'));
  assert.equal(description.required, true);
  description.value = 'When you answer me';
  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await flush(); await flush(); await flush();
  assert.deepEqual(calls.at(-1), ['moveToRules', 'r@1', { level: 'workspace', topic: 'language', description: 'When you answer me' }]);

  const again = button(item(facts, 'Always'), 'Move to rules…');
  again.click();
  const open = item(facts, 'Always').querySelector('.knowledge-hint-form');
  open.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(item(facts, 'Always').querySelector('.knowledge-hint-form'), null);
  assert.equal(doc.activeElement, again);
});

test('rules: a file\'s own hint on its row, its entries\' behind a disclosure, Merge… asks which file stays', async (t) => {
  const { dom, rules, calls } = await mount();
  t.after(dom.cleanup);
  const rows = [...rules.querySelectorAll('.knowledge-row')];
  assert.match(rows[0].textContent, /Similar topic name: commits/);
  const disclosure = rows[1].querySelector('.knowledge-disclosure');
  assert.equal(disclosure.textContent, '1 entry with a hint');
  const list = rows[1].querySelector('.knowledge-hint-entries');
  assert.equal(list.hidden, true);
  disclosure.click();
  assert.equal(list.hidden, false);
  assert.match(list.textContent, /The build is red today\..*Reads like an episode/);
  button(rows[0], 'Merge…').click();
  const form = rows[0].querySelector('.knowledge-hint-form');
  const keep = form.querySelector('select');
  keep.value = 'commits';
  keep.dispatchEvent(new dom.window.Event('change'));
  assert.match(form.textContent, /rules of commit\.md move into commits\.md/);
  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await flush(); await flush(); await flush();
  assert.deepEqual(calls.at(-1), ['merge', 's@a', { keep: 'commits' }]);
});

test('German: the same lines, in German', async (t) => {
  const { dom, facts, rules } = await mount({ locale: 'de' });
  t.after(dom.cleanup);
  assert.match(item(facts, 'Always').textContent, /Liest sich wie eine Regel.*In Regeln verschieben….*Ausblenden/);
  assert.equal(item(facts, 'The deploy').querySelector('.knowledge-hint__more').textContent, '+1 weitere');
  assert.match(rules.textContent, /Ähnlicher Themenname: commits.*Zusammenführen…/);
  assert.match(rules.textContent, /1 Eintrag mit Hinweis/);
});

test('without hints the page draws no hint, no disclosure and no empty status', async (t) => {
  const { dom, doc } = await mount({ state: { ...STATE, hints: [] } });
  t.after(dom.cleanup);
  assert.equal(doc.querySelectorAll('.knowledge-hint, .knowledge-disclosure').length, 0);
  assert.deepEqual([...doc.querySelectorAll('.knowledge-hint-status')].map((node) => node.textContent), ['', '']);
});
