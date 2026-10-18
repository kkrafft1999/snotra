// The skills and tools of a chat at the composer (#773), on the real DOM.
//
// The pill counts the skills that are on; its popover lists every skill and
// tool with its state, what is missing first, and leads to the setting that
// changes it. It shows and never switches.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

function config(overrides = {}) {
  return {
    workspaceOpen: true,
    skills: [
      { name: 'pdf-export', description: 'Turns Markdown into a PDF.', source: 'user-snotra', state: 'off', chatOnly: false },
      { name: 'snotra-capabilities', description: 'What Snotra can do.', source: 'system', state: 'on', chatOnly: false },
      { name: 'release', description: 'Cuts a release.', source: 'workspace-agents', state: 'on', chatOnly: false },
      { name: 'broken', description: '', source: 'user-snotra', state: 'invalid', chatOnly: false },
    ],
    tools: [
      { name: 'read_file_text', mcpServer: null, group: 'read', on: true, reason: null, setup: null },
      { name: 'mcp__github__get_issue', mcpServer: 'GitHub', group: 'mcp', on: true, reason: null, setup: null },
      { name: 'edit_file', mcpServer: null, group: 'write', on: true, reason: null, setup: null },
      { name: 'find_files', mcpServer: null, group: 'read', on: false, reason: 'switchedOff', setup: null },
      { name: 'web_search', mcpServer: null, group: 'web', on: false, reason: 'notConfigured', setup: 'webSearch' },
      { name: 'shell_execute', mcpServer: null, group: 'exec', on: false, reason: 'notConfigured', setup: 'shell' },
    ],
    ...overrides,
  };
}

async function setup({ locale = 'en', answers = [config()], messages = [], llmState = null } = {}) {
  const dom = setupRendererDom();
  const { initChatConfigIndicator } = await importRenderer('components', 'ChatConfigIndicator.js');
  const { appStore } = await importRenderer('state', 'store.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale(locale);
  appStore.chatMessages = messages;
  if (llmState) appStore.llmState = llmState;
  const requests = [];
  const opened = [];
  const queue = [...answers];
  const indicator = initChatConfigIndicator({
    api: {
      getChatConfiguration: async (request) => {
        requests.push(request);
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return typeof next === 'function' ? next() : next;
      },
    },
    appStore,
    onOpenSettings: (place) => opened.push(place),
  });
  await indicator.refresh();
  const document = dom.document;
  const byId = (id) => document.getElementById(id);
  const open = async () => {
    byId('btn-chat-config').click();
    await flush();
  };
  return { dom, document, byId, indicator, requests, opened, open, appStore };
}

test('the pill counts the skills that are on and names itself by its label', async (t) => {
  const { dom, byId } = await setup();
  t.after(dom.cleanup);
  assert.equal(byId('chat-config-wrap').classList.contains('hidden'), false);
  assert.equal(byId('chat-config-label').textContent, '2 skills');
  // Tooltip and accessible name begin with what the pill shows (#583).
  assert.match(byId('btn-chat-config').getAttribute('aria-label'), /^2 skills – /);
  assert.match(byId('btn-chat-config').title, /^2 skills – /);
});

test('one skill, none, and German', async (t) => {
  const one = await setup({ answers: [config({ skills: [config().skills[1]] })] });
  assert.equal(one.byId('chat-config-label').textContent, '1 skill');
  one.dom.cleanup();
  const none = await setup({ locale: 'de', answers: [config({ skills: [config().skills[0]] })] });
  t.after(none.dom.cleanup);
  assert.equal(none.byId('chat-config-label').textContent, 'Keine Skills');
  await none.open();
  assert.match(none.byId('chat-config-popup').textContent, /Kein Skill eingeschaltet/);
});

test('the pill waits for the first answer instead of claiming "No skills"', async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const dom = setupRendererDom();
  t.after(dom.cleanup);
  const { initChatConfigIndicator } = await importRenderer('components', 'ChatConfigIndicator.js');
  const { appStore } = await importRenderer('state', 'store.js');
  appStore.chatMessages = [];
  const indicator = initChatConfigIndicator({ api: { getChatConfiguration: () => pending }, appStore });
  const done = indicator.refresh();
  assert.equal(dom.document.getElementById('chat-config-wrap').classList.contains('hidden'), true);
  release(config());
  await done;
  assert.equal(dom.document.getElementById('chat-config-wrap').classList.contains('hidden'), false);
});

test('skills that are on come first; off and broken say so in words', async (t) => {
  const { dom, document, open } = await setup();
  t.after(dom.cleanup);
  await open();
  const rows = [...document.querySelectorAll('#chat-config-popup .chat-config-row--skill')];
  assert.deepEqual(rows.map((row) => row.querySelector('.chat-config-name').textContent),
    ['snotra-capabilities', 'release', 'pdf-export', 'broken']);
  const state = (row) => row.querySelector('.chat-config-state, .sr-only').textContent;
  assert.deepEqual(rows.map(state), ['on', 'on', 'off', 'cannot be read']);
  // "on" is read out, not shown — the filled dot carries it.
  assert.equal(rows[0].querySelector('.sr-only').textContent, 'on');
  assert.equal(rows[0].querySelector('.chat-config-mark--on') !== null, true);
  assert.equal(rows[2].querySelector('.chat-config-mark--on'), null);
  assert.equal(rows[0].querySelector('.chat-config-src').textContent, 'System');
  assert.equal(rows[1].querySelector('.chat-config-src').textContent, 'Folder · .agents/skills');
  assert.equal(document.querySelector('#chat-config-skills-heading .chat-config-count').textContent, '2 of 4');
});

test('a skill invoked with /name is on for this chat only, and the request names it', async (t) => {
  const answer = config();
  answer.skills[0] = { ...answer.skills[0], state: 'on', chatOnly: true };
  const { dom, document, open, requests } = await setup({
    answers: [answer],
    messages: [
      { role: 'user', content: '/pdf-export the changelog' },
      // A name in an answer switches nothing on, as in the engine.
      { role: 'assistant', content: 'Try /release next time.' },
    ],
  });
  t.after(dom.cleanup);
  assert.deepEqual(requests[0], { invokedSkills: ['pdf-export'] });
  await open();
  const row = [...document.querySelectorAll('.chat-config-row--skill')].find((item) => item.textContent.includes('pdf-export'));
  assert.equal(row.querySelector('.chat-config-tag').textContent, 'this chat only');
});

test('missing tools first with their reason and the way to the setting; the rest by group', async (t) => {
  const { dom, document, open, opened, byId } = await setup();
  t.after(dom.cleanup);
  await open();
  const missing = [...document.querySelectorAll('.chat-config-row--tool')];
  assert.deepEqual(missing.map((row) => row.querySelector('.chat-config-name').textContent),
    ['find_files', 'web_search', 'shell_execute']);
  assert.deepEqual(missing.map((row) => row.querySelector('.chat-config-sub').textContent),
    ['switched off', 'no search service key', 'no shell found']);
  const actions = missing.map((row) => row.querySelector('.chat-config-action')?.textContent ?? null);
  // No setting finds a shell for you — so no button that pretends one does.
  assert.deepEqual(actions, ['Switch on', 'Set up', null]);
  assert.equal(missing[1].querySelector('.chat-config-action').getAttribute('aria-label'),
    'Set up: web_search – in Settings › Tools › Setup');

  const summary = document.querySelector('.chat-config-summary');
  assert.equal(summary.textContent, '3 switched on');
  assert.equal(summary.getAttribute('aria-expanded'), 'false');
  assert.equal(byId('chat-config-groups').hidden, true);
  summary.click();
  assert.equal(summary.getAttribute('aria-expanded'), 'true');
  assert.equal(byId('chat-config-groups').hidden, false);
  assert.deepEqual([...document.querySelectorAll('.chat-config-group-name')].map((node) => node.textContent),
    ['Read & search', 'Write', 'MCP: GitHub']);

  missing[1].querySelector('.chat-config-action').click();
  assert.deepEqual(opened, [{ panel: 'tools', target: 'heading-web-search' }]);
  // The way to the setting closes the popover and hands the focus back first.
  assert.equal(byId('chat-config-popup').classList.contains('hidden'), true);
  assert.equal(document.activeElement, byId('btn-chat-config'));
});

test('tools that only lack a folder are one line', async (t) => {
  const answer = config({
    workspaceOpen: false,
    tools: [
      { name: 'read_file_text', mcpServer: null, group: 'read', on: false, reason: 'noFolder', setup: null },
      { name: 'write_file_text', mcpServer: null, group: 'write', on: false, reason: 'noFolder', setup: null },
    ],
  });
  const { dom, document, open } = await setup({ answers: [answer] });
  t.after(dom.cleanup);
  await open();
  const rows = [...document.querySelectorAll('.chat-config-row--tool')];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].textContent, '2 tools need an open folder');
  assert.equal(document.querySelector('.chat-config-summary'), null);
});

test('the links under the lists open the skills and the security page', async (t) => {
  const { dom, document, open, opened } = await setup();
  t.after(dom.cleanup);
  await open();
  const links = [...document.querySelectorAll('.chat-config-link')];
  assert.deepEqual(links.map((link) => link.textContent),
    ['Skills in Settings › Skills', 'Tools in Settings › Tools › Autonomy']);
  links[0].click();
  assert.deepEqual(opened, [{ panel: 'skills', target: null }]);
});

test('keyboard: open moves the focus in, arrows walk the buttons, Escape goes back to the pill', async (t) => {
  const { dom, document, open, byId } = await setup();
  t.after(dom.cleanup);
  await open();
  const popup = byId('chat-config-popup');
  assert.equal(byId('btn-chat-config').getAttribute('aria-expanded'), 'true');
  assert.equal(popup.getAttribute('role'), 'dialog');
  assert.equal(popup.getAttribute('aria-label'), 'Skills and tools of this chat');
  assert.equal(document.activeElement, popup);
  const key = (k) => popup.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  key('ArrowDown');
  assert.equal(document.activeElement.textContent, 'Switch on');
  key('ArrowUp');
  assert.equal(document.activeElement.textContent, 'Tools in Settings › Tools › Autonomy');
  key('Escape');
  assert.equal(popup.classList.contains('hidden'), true);
  assert.equal(byId('btn-chat-config').getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, byId('btn-chat-config'));
});

test('opening reads again, and an older answer never overwrites a newer one', async (t) => {
  let slow;
  const late = new Promise((resolve) => { slow = resolve; });
  const fresh = config({ skills: [config().skills[1]] });
  const { dom, byId, indicator, requests } = await setup({ answers: [config(), () => late, fresh] });
  t.after(dom.cleanup);
  assert.equal(byId('chat-config-label').textContent, '2 skills');
  const first = indicator.refresh();
  const second = indicator.refresh();
  await second;
  assert.equal(byId('chat-config-label').textContent, '1 skill');
  slow(config());
  await first;
  assert.equal(byId('chat-config-label').textContent, '1 skill');
  assert.equal(requests.length, 3);
});

test('a failed read says so in the popover rather than showing an empty list', async (t) => {
  const { dom, byId, open } = await setup({ answers: [() => { throw new Error('ipc gone'); }] });
  t.after(dom.cleanup);
  assert.equal(byId('chat-config-wrap').classList.contains('hidden'), false);
  assert.equal(byId('chat-config-label').textContent, 'Skills');
  await open();
  assert.match(byId('chat-config-popup').textContent, /could not be read/);
});

// What a card switched for this chat (#774) has rows of its own on top: a tool
// on here and off in the settings is not read as a setting, and has no button
// that would lead to a setting saying the opposite.
test('a tool or skill switched on a card is marked as this chat\'s', async (t) => {
  const base = config();
  const { dom, document, open } = await setup({
    answers: [config({
      skills: [{ ...base.skills[0], state: 'on', chatOnly: true, chatCard: true }, ...base.skills.slice(1)],
      tools: [
        ...base.tools,
        { name: 'fetch_url', mcpServer: null, group: 'web', on: true, reason: null, setup: null, chatOnly: true },
        { name: 'search_in_files', mcpServer: null, group: 'read', on: false, reason: 'switchedOff', setup: null, chatOnly: true },
      ],
    })],
  });
  t.after(dom.cleanup);
  await open();
  const rows = [...document.querySelectorAll('#chat-config-popup .chat-config-row--tool')];
  const row = (name) => rows.find((item) => item.querySelector('.chat-config-name')?.textContent === name);
  assert.equal(rows.indexOf(row('fetch_url')), 0, 'changed rows come first');
  assert.equal(row('fetch_url').querySelector('.chat-config-tag').textContent, 'this chat only');
  assert.equal(row('fetch_url').querySelector('.chat-config-sub').textContent, 'on in this chat; off in the settings');
  assert.equal(row('fetch_url').classList.contains('chat-config-row--off'), false);
  assert.equal(row('search_in_files').querySelector('.chat-config-sub').textContent, 'off in this chat; on in the settings');
  assert.equal(row('search_in_files').querySelector('.chat-config-action'), null);
  // Not listed a second time among the tools that are off.
  assert.equal(rows.filter((item) => item.textContent.includes('search_in_files')).length, 1);
  const skill = [...document.querySelectorAll('#chat-config-popup .chat-config-row--skill')]
    .find((item) => item.textContent.includes('pdf-export'));
  assert.equal(skill.querySelector('.chat-config-tag').title, 'Switched on for this chat on a card; the setting stays as it is.');
});

/** An OpenAI-compatible entry with "Send tools along" on or off (#1013). */
function llmStateWithTools(sendTools) {
  return {
    activePresetId: 'local',
    presets: [{ id: 'local', providerId: 'openai-compatible', configured: true, connection: { sendTools } }],
  };
}

test('an entry that sends no tools says so on the pill and in the popover (#1013)', async (t) => {
  const { dom, byId, open, opened } = await setup({ llmState: llmStateWithTools(false) });
  t.after(dom.cleanup);
  assert.equal(byId('chat-config-label').textContent, 'No tools');
  assert.equal(byId('chat-config-wrap').dataset.noTools, 'true');
  assert.match(byId('btn-chat-config').getAttribute('aria-label'), /^This model gets no tools – /);
  await open();
  const popup = byId('chat-config-popup');
  assert.match(popup.textContent, /This model gets no tools: “Send tools along” is switched off/);
  // No list of switched-on tools that would never reach the model.
  assert.equal(popup.querySelector('.chat-config-summary'), null);
  assert.equal(popup.textContent.includes('web_search'), false);
  const link = [...popup.querySelectorAll('.chat-config-link')].find((b) => b.dataset.panel === 'models');
  assert.equal(link.textContent, 'Change it in Settings › Models');
  link.click();
  assert.deepEqual(opened.at(-1), { panel: 'models', target: null });
});

test('switching to an entry with tools brings the count back without a new read', async (t) => {
  const { dom, byId, indicator, appStore, requests } = await setup({ locale: 'de', llmState: llmStateWithTools(false) });
  t.after(dom.cleanup);
  assert.equal(byId('chat-config-label').textContent, 'Keine Tools');
  const reads = requests.length;
  appStore.llmState = llmStateWithTools(true);
  indicator.redraw();
  assert.equal(byId('chat-config-label').textContent, '2 Skills');
  assert.equal(byId('chat-config-wrap').dataset.noTools, undefined);
  assert.equal(requests.length, reads);
});
