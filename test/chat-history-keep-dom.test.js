// *Keep* and chats from folders that no longer exist (#1320), in the history
// column on the real DOM: the bookmark next to the bin, the note above the
// list that unfolds into the missing folders, and the ceiling note.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const WS = '/work/garden';
const SESSIONS = [
  { id: 'kept', title: 'Plan the release', updatedAt: 30, workspaceRoot: WS, keep: true },
  { id: 'plain', title: 'Fix the flaky test', updatedAt: 20, workspaceRoot: WS },
];
const ORPHANS = [
  { id: 'o1', title: 'Watering schedule', updatedAt: 9, workspaceRoot: '/old/garden-planner' },
  { id: 'o2', title: 'Order list', updatedAt: 8, workspaceRoot: '/old/garden-planner' },
  { id: 'o3', title: 'Agenda', updatedAt: 7, workspaceRoot: '/old/offsite' },
];
const LIMITS = { folder: { count: 1, max: 200 }, overall: { count: 5, max: 2000, reached: false } };

async function setup(t, { locale = 'en', sessions = SESSIONS, orphaned = ORPHANS, limits = LIMITS, setChatKeep, assignChatToFolder } = {}) {
  const dom = setupRendererDom();
  t.after(() => dom.cleanup?.());
  const { initChatHistoryPanel } = await importRenderer('components', 'ChatHistoryPanel.js');
  const { appStore } = await importRenderer('state', 'store.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale(locale);

  const state = { sessions: sessions.map((s) => ({ ...s })), orphaned: orphaned.map((s) => ({ ...s })) };
  const calls = [];
  const move = (ids) => {
    const moved = state.orphaned.filter((s) => ids.includes(s.id));
    state.orphaned = state.orphaned.filter((s) => !ids.includes(s.id));
    state.sessions.push(...moved.map((s) => ({ ...s, workspaceRoot: WS })));
    return moved.length;
  };
  appStore.currentChatId = 'chat-elsewhere';
  appStore.chatMessages = [];

  const panel = initChatHistoryPanel({
    api: {
      getChatHistory: async () => ({ sessions: state.sessions, orphaned: state.orphaned, activeChatId: null, workspaceRoot: WS, limits }),
      setActiveChatId: async () => ({ ok: true }),
      setUIPrefs: async () => ({ ok: true }),
      getChatSession: async (id) => { calls.push(['open', id]); return { session: null }; },
      setChatKeep: setChatKeep || (async (id, keep) => { calls.push(['keep', id, keep]); return { ok: true, keep }; }),
      assignChatToFolder: assignChatToFolder || (async (id) => { calls.push(['assign', id]); move([id]); return { ok: true, workspaceRoot: WS }; }),
      assignFolderChatsToFolder: async (root) => {
        calls.push(['assignAll', root]);
        const count = move(state.orphaned.filter((s) => s.workspaceRoot === root).map((s) => s.id));
        return { ok: count > 0, count, workspaceRoot: WS };
      },
    },
    appStore,
    stopChatVoiceListening: () => {},
    renderChatMessages: () => {},
    updateChatChrome: () => {},
    onInputChanged: () => {},
    setChatTokenUsage: () => {},
    resetChatTokenUsage: () => {},
    seedGreetingIfWorkspace: () => {},
    onNewChatStarted: async () => {},
  });
  await panel.renderHistoryList();
  const document = dom.document;
  const row = (id) => document.querySelector(`.chat-history-row[data-chat-id="${id}"]`);
  return {
    document,
    appStore,
    calls,
    row,
    keep: (id) => row(id).querySelector('.chat-history-row-keep'),
    status: () => document.getElementById('chat-history-status').textContent,
    toggle: () => document.querySelector('.chat-history-orphans-toggle'),
  };
}

test('the bookmark sits between the open button and the bin, named, with its state in aria-pressed', async (t) => {
  const { row, keep } = await setup(t);
  const buttons = [...row('plain').children].map((el) => el.className);
  assert.deepEqual(buttons, ['chat-history-row-main', 'chat-history-row-keep', 'chat-history-row-delete']);
  assert.equal(keep('kept').getAttribute('aria-pressed'), 'true');
  assert.equal(keep('plain').getAttribute('aria-pressed'), 'false');
  assert.equal(keep('plain').getAttribute('aria-label'), 'Keep chat', 'one name; the state is aria-pressed');
  assert.equal(keep('kept').getAttribute('aria-label'), 'Keep chat');
  assert.match(keep('plain').title, /more than 200 chats/);
  assert.match(keep('kept').title, /^Kept/);
});

test('a click on the bookmark keeps the chat, says so, and does not open it', async (t) => {
  const { keep, calls, appStore, status } = await setup(t);
  keep('plain').click();
  await flush();
  assert.deepEqual(calls, [['keep', 'plain', true]]);
  assert.equal(keep('plain').getAttribute('aria-pressed'), 'true');
  assert.equal(status(), '“Fix the flaky test” is kept.');
  assert.equal(appStore.currentChatId, 'chat-elsewhere', 'the row did not open the chat');

  keep('kept').click();
  await flush();
  assert.deepEqual(calls.at(-1), ['keep', 'kept', false]);
  assert.equal(keep('kept').getAttribute('aria-pressed'), 'false');
  assert.equal(status(), '“Plan the release” is no longer kept.');
});

test('a mark that could not be saved stays as it was, and the status line says so', async (t) => {
  const { keep, status } = await setup(t, { setChatKeep: async () => ({ ok: false }) });
  keep('plain').click();
  await flush();
  assert.equal(keep('plain').getAttribute('aria-pressed'), 'false');
  assert.equal(status(), 'The chat could not be marked.');
});

test('no note without chats from missing folders, and no ceiling note below the ceiling', async (t) => {
  const { document } = await setup(t, { orphaned: [] });
  assert.equal(document.querySelector('.chat-history-orphans'), null);
  assert.equal(document.querySelector('.chat-history-ceiling'), null);
});

test('the note unfolds into the missing folders, each with its chats', async (t) => {
  const { document, toggle } = await setup(t);
  assert.equal(toggle().textContent.includes('3 chats from folders that no longer exist'), true);
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  const list = document.getElementById(toggle().getAttribute('aria-controls'));
  assert.equal(list.hidden, true);

  toggle().click();
  assert.equal(toggle().getAttribute('aria-expanded'), 'true');
  assert.equal(list.hidden, false);
  assert.match(toggle().textContent, /Hide/);
  const groups = [...document.querySelectorAll('.chat-history-orphans-group')];
  assert.deepEqual(groups.map((g) => g.querySelector('.chat-history-orphans-folder').textContent), ['garden-planner', 'offsite']);
  assert.equal(groups[0].querySelector('.chat-history-orphans-folder').title, '/old/garden-planner', 'the whole path on hover');
  assert.equal(groups[0].getAttribute('aria-label'), 'Chats from /old/garden-planner');
  assert.equal(groups[0].querySelectorAll('.chat-history-orphan').length, 2);
  assert.equal(groups[0].querySelector('.chat-history-orphans-assign-all').getAttribute('aria-label'),
    'Assign all 2 chats from garden-planner to this folder');
  assert.equal(groups[1].querySelector('.chat-history-orphans-assign-all'), null, 'one chat needs no Assign all');
  assert.equal(groups[1].querySelector('.chat-history-orphan-assign').getAttribute('aria-label'), 'Assign “Agenda” to this folder');
});

test('Assign moves one chat, Assign all a folder; the focus stays in the note, then goes to the list', async (t) => {
  const { document, calls, toggle, status, row } = await setup(t);
  toggle().click();
  document.querySelector('.chat-history-orphans-group:last-child .chat-history-orphan-assign').click();
  await flush();
  assert.deepEqual(calls, [['assign', 'o3']]);
  assert.equal(status(), '“Agenda” now belongs to this folder.');
  assert.ok(row('o3'), 'the chat is in the folder\'s list now');
  assert.equal(toggle().getAttribute('aria-expanded'), 'true', 'the note stays unfolded across the redraw');
  assert.equal(document.activeElement.className, 'chat-history-orphans-assign-all');

  document.activeElement.click();
  await flush();
  assert.deepEqual(calls.at(-1), ['assignAll', '/old/garden-planner']);
  assert.equal(status(), '2 chats now belong to this folder.');
  assert.equal(document.querySelector('.chat-history-orphans'), null, 'nothing left to assign');
  assert.equal(document.activeElement.className, 'chat-history-row-main');
});

test('an assignment that fails keeps the chat in the note and says so', async (t) => {
  const { document, toggle, status } = await setup(t, { assignChatToFolder: async () => ({ ok: false }) });
  toggle().click();
  document.querySelector('.chat-history-orphan-assign').click();
  await flush();
  assert.equal(document.querySelectorAll('.chat-history-orphan').length, 3);
  assert.equal(status(), 'The chat could not be assigned to this folder.');
});

test('over the ceiling the list says so, quietly, in the interface language', async (t) => {
  const limits = { folder: { count: 2, max: 200 }, overall: { count: 2015, max: 2000, reached: true } };
  const { document } = await setup(t, { locale: 'de', limits });
  const note = document.querySelector('.chat-history-ceiling');
  assert.match(note.textContent, /^Dein Verlauf hat 2\.015 Chats, mehr als die 2\.000/);
  assert.equal(note.getAttribute('role'), null, 'a note, not an alert');
  assert.match(document.querySelector('.chat-history-orphans-toggle').textContent, /3 Chats aus Ordnern, die es nicht mehr gibt/);
  assert.equal(document.querySelector('.chat-history-row-keep').getAttribute('aria-label'), 'Chat behalten');
});
