// The `@` and `/` lists and the skill suggestion belong to the input (#584).
//
// They closed on blur but could open again without the focus: the skill
// watcher refreshed the `/` list, a folder switch closed it and a waiting
// update reopened it, a slow path load opened the `@` list after a blur, and
// switching the suggestions off did not stop an answer already on its way.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const SKILLS = [
  { name: 'review', description: 'Review a pull request', status: 'active' },
  { name: 'minutes', description: 'Write meeting minutes', status: 'active' },
];

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function fakeCatalog(skills = SKILLS) {
  let pending = null;
  return {
    hold() { pending = deferred(); return pending; },
    load: async () => {
      if (pending) await pending.promise;
      return skills;
    },
    onInvalidated: () => () => {},
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await flush();
}

function type(input, text) {
  input.value = text;
  input.selectionStart = text.length;
  input.selectionEnd = text.length;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mountSkillList() {
  const dom = setupRendererDom();
  const { initSkillAutocomplete } = await importRenderer('components', 'SkillAutocomplete.js');
  const catalog = fakeCatalog();
  const list = initSkillAutocomplete({ catalog, onInputChanged() {} });
  const input = dom.document.getElementById('chat-input');
  const menu = dom.document.getElementById('chat-skill-menu');
  return { dom, list, catalog, input, menu, other: dom.document.getElementById('btn-chat-send') };
}

test('typing "/" in the focused input opens the skill list, and Enter takes the highlighted skill', async (t) => {
  const { dom, list, input } = await mountSkillList();
  t.after(dom.cleanup);
  input.focus();
  type(input, '/rev');
  await settle();
  assert.equal(list.isOpen(), true);

  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(input.value, '/review ');
  assert.equal(list.isOpen(), false);
});

test('a catalogue change while the focus is elsewhere does not open the skill list', async (t) => {
  const { dom, list, input, other } = await mountSkillList();
  t.after(dom.cleanup);
  input.focus();
  type(input, '/rev');
  await settle();
  other.focus();
  input.dispatchEvent(new Event('blur'));
  assert.equal(list.isOpen(), false);

  list.refresh();
  await settle();
  assert.equal(list.isOpen(), false, 'the watcher must not open the list over the composer');
});

test('close() during a pending catalogue load leaves the skill list closed', async (t) => {
  const { dom, list, catalog, input } = await mountSkillList();
  t.after(dom.cleanup);
  input.focus();
  const hold = catalog.hold();
  type(input, '/rev');
  await flush();
  // The order of onWorkspaceChanged: invalidate (which refreshes), then close.
  list.refresh();
  list.close();
  hold.resolve();
  await settle();
  assert.equal(list.isOpen(), false);
});

test('a slow path load that outlives a blur does not open the @ list', async (t) => {
  const dom = setupRendererDom();
  t.after(dom.cleanup);
  const { initMentionAutocomplete } = await importRenderer('components', 'MentionAutocomplete.js');
  const { appStore } = await importRenderer('state', 'store.js');
  const paths = deferred();
  appStore.rootPath = '/ws';
  const mention = initMentionAutocomplete({
    api: { listWorkspacePaths: () => paths.promise },
    appStore,
    onInputChanged() {},
  });
  const input = dom.document.getElementById('chat-input');
  input.focus();
  type(input, '@src');
  await flush();
  dom.document.getElementById('btn-chat-send').focus();
  input.dispatchEvent(new Event('blur'));

  paths.resolve({ entries: [{ path: 'src/index.js', kind: 'file' }] });
  await settle();
  assert.equal(mention.isOpen(), false);
});

async function mountSuggestion({ suggestSkills }) {
  const dom = setupRendererDom();
  const { initSkillSuggestion } = await importRenderer('components', 'SkillSuggestion.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en');
  const suggestion = initSkillSuggestion({ catalog: fakeCatalog(), api: { suggestSkills }, onInputChanged() {} });
  const input = dom.document.getElementById('chat-input');
  const row = dom.document.getElementById('chat-skill-suggestion');
  return { dom, suggestion, input, row };
}

test('the lexical suggestion appears below the focused input', async (t) => {
  const { dom, suggestion, input, row } = await mountSuggestion({});
  t.after(dom.cleanup);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  suggestion.setMode('lexical');
  input.focus();
  type(input, 'write the meeting minutes /');
  t.mock.timers.tick(250);
  await settle();
  assert.equal(row.classList.contains('hidden'), false);
  assert.match(row.textContent, /\/minutes/);
});

test('a catalogue change while the focus is elsewhere does not show the suggestion', async (t) => {
  const { dom, suggestion, input, row } = await mountSuggestion({});
  t.after(dom.cleanup);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  suggestion.setMode('lexical');
  input.value = 'write the meeting minutes /';
  input.selectionStart = input.value.length;
  dom.document.getElementById('btn-chat-send').focus();
  suggestion.refresh();
  t.mock.timers.tick(250);
  await settle();
  assert.equal(row.classList.contains('hidden'), true);
});

test('switching the suggestions off discards a model answer still on its way', async (t) => {
  const answer = deferred();
  const { dom, suggestion, input, row } = await mountSuggestion({ suggestSkills: () => answer.promise });
  t.after(dom.cleanup);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  suggestion.setMode('model');
  input.focus();
  type(input, 'write the meeting minutes /');
  t.mock.timers.tick(1000);
  await flush();

  suggestion.setMode('off');
  answer.resolve({ name: 'minutes' });
  await settle();
  assert.equal(row.classList.contains('hidden'), true);
});
