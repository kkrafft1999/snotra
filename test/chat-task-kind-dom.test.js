// The chat's kind of task in the header (#1282), on the real DOM.
//
// A pill after the title shows the kind and opens the six kinds with the
// source of the current one; a pick is stored as the user's.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const QUESTION = [{ role: 'user', content: 'Fix the flaky test' }];

async function setup({ locale = 'en', taskKind = null, messages = QUESTION, setChatTaskKind } = {}) {
  const dom = setupRendererDom();
  const { initChatTaskKind } = await importRenderer('components', 'ChatTaskKind.js');
  const { appStore } = await importRenderer('state', 'store.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale(locale);
  appStore.currentChatId = 'chat-1';
  appStore.chatMessages = messages;
  appStore.currentChatTaskKind = taskKind;
  const stored = [];
  const kind = initChatTaskKind({
    api: {
      setChatTaskKind: setChatTaskKind || (async (chatId, id) => {
        stored.push([chatId, id]);
        return { taskKind: { id, source: 'user', at: '2026-10-30T10:00:00.000Z' } };
      }),
    },
    appStore,
  });
  kind.sync();
  const document = dom.document;
  return {
    dom,
    document,
    appStore,
    kind,
    stored,
    wrap: document.getElementById('chat-kind-wrap'),
    pill: document.getElementById('btn-chat-kind'),
    menu: document.getElementById('chat-kind-menu'),
    source: document.getElementById('chat-kind-source'),
    status: document.getElementById('chat-kind-status'),
    options: () => [...document.querySelectorAll('#chat-kind-menu .chat-kind-option')],
    key: (target, key) => {
      const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    },
  };
}

test('a chat without a question shows no kind yet', async () => {
  const { wrap } = await setup({ messages: [] });
  assert.equal(wrap.classList.contains('hidden'), true);
});

test('an unclassified chat shows the muted pill that invites a choice', async () => {
  const { wrap, pill } = await setup();
  assert.equal(wrap.classList.contains('hidden'), false);
  assert.equal(pill.classList.contains('chat-kind-pill--unclassified'), true);
  assert.equal(pill.textContent.trim(), 'Unclassified');
  assert.equal(pill.getAttribute('aria-label'), 'Kind of task: unclassified. Choose a kind');
});

test('the pill names the kind, its name also says where it came from', async () => {
  for (const [source, words] of [
    ['model', 'Suggested by the model'],
    ['estimate', 'Estimated by Snotra'],
    ['user', 'Set by you'],
  ]) {
    const { pill } = await setup({ taskKind: { id: 'coding', source, at: '2026-10-30T09:00:00.000Z' } });
    assert.equal(pill.textContent.trim(), 'Coding');
    assert.equal(pill.classList.contains('chat-kind-pill--unclassified'), false);
    assert.equal(pill.getAttribute('aria-label'), `Kind of task: Coding. ${words}. Change kind`);
  }
});

test('in German the source addresses the user as du', async () => {
  const { pill, source } = await setup({ locale: 'de', taskKind: { id: 'research', source: 'user', at: '2026-10-30T09:00:00.000Z' } });
  assert.equal(pill.textContent.trim(), 'Recherche & Fragen');
  pill.click();
  assert.equal(source.textContent, 'Von dir gesetzt');
});

test('a kind this version does not know counts as unclassified', async () => {
  const { pill } = await setup({ taskKind: { id: 'gardening', source: 'model', at: '2026-10-30T09:00:00.000Z' } });
  assert.equal(pill.textContent.trim(), 'Unclassified');
});

test('opening lists the six kinds with their definitions, the current one selected and focused', async () => {
  const { pill, menu, document, options, source } = await setup({ taskKind: { id: 'data', source: 'estimate', at: '2026-10-30T09:00:00.000Z' } });
  pill.click();
  assert.equal(menu.classList.contains('hidden'), false);
  assert.equal(pill.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(options().map((o) => o.dataset.kind), ['coding', 'writing', 'research', 'data', 'planning', 'other']);
  assert.ok(options()[3].textContent.includes('Evaluating data, tables or logs'));
  assert.equal(document.activeElement, options()[3]);
  assert.equal(options()[3].getAttribute('aria-selected'), 'true');
  assert.equal(source.textContent, 'Estimated by Snotra');
});

test('unclassified: the focus lands on the first kind and the popup asks for a choice', async () => {
  const { pill, document, options, source } = await setup();
  pill.click();
  assert.equal(document.activeElement, options()[0]);
  assert.ok(options().every((o) => o.getAttribute('aria-selected') === 'false'));
  assert.equal(source.textContent, 'Not classified yet — pick the kind that fits.');
});

test('the arrow keys move and wrap, Home and End jump, Escape closes back to the pill', async () => {
  const { pill, menu, document, options, key } = await setup();
  pill.click();
  key(document.activeElement, 'ArrowUp');
  assert.equal(document.activeElement, options()[5]);
  key(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement, options()[0]);
  key(document.activeElement, 'End');
  assert.equal(document.activeElement, options()[5]);
  key(document.activeElement, 'Home');
  assert.equal(document.activeElement, options()[0]);
  assert.equal(options().filter((o) => o.tabIndex === 0).length, 1, 'one tab stop for the list');
  const event = key(document.activeElement, 'Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(document.activeElement, pill);
});

test('a pick is stored as the user\'s, the pill shows it and gets the focus back', async () => {
  const { pill, menu, document, options, stored, appStore } = await setup({ taskKind: { id: 'coding', source: 'model', at: '2026-10-30T09:00:00.000Z' } });
  pill.click();
  options()[1].click();
  await flush();
  assert.deepEqual(stored, [['chat-1', 'writing']]);
  assert.equal(appStore.currentChatTaskKind.source, 'user');
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(document.activeElement, pill);
  assert.equal(pill.textContent.trim(), 'Writing & editing');
  assert.equal(pill.getAttribute('aria-label'), 'Kind of task: Writing & editing. Set by you. Change kind');
});

test('picking the kind the user already set stores nothing again', async () => {
  const { pill, options, stored } = await setup({ taskKind: { id: 'coding', source: 'user', at: '2026-10-30T09:00:00.000Z' } });
  pill.click();
  options()[0].click();
  await flush();
  assert.deepEqual(stored, []);
});

test('confirming the model\'s suggestion makes it the user\'s', async () => {
  const { pill, options, stored } = await setup({ taskKind: { id: 'coding', source: 'model', at: '2026-10-30T09:00:00.000Z' } });
  pill.click();
  options()[0].click();
  await flush();
  assert.deepEqual(stored, [['chat-1', 'coding']]);
});

test('a pick main did not store keeps the menu open and says so', async () => {
  const { pill, menu, options, status, appStore } = await setup({ setChatTaskKind: async () => ({ taskKind: null }) });
  pill.click();
  options()[2].click();
  await flush();
  assert.equal(menu.classList.contains('hidden'), false);
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'The kind could not be saved. Try again.');
  assert.equal(appStore.currentChatTaskKind, null);
});

test('a pick that lands after a switch to another chat changes nothing on screen', async () => {
  let answer;
  const { pill, options, appStore } = await setup({
    setChatTaskKind: () => new Promise((resolve) => { answer = resolve; }),
  });
  pill.click();
  options()[2].click();
  appStore.currentChatId = 'chat-2';
  answer({ taskKind: { id: 'research', source: 'user', at: '2026-10-30T10:00:00.000Z' } });
  await flush();
  assert.equal(appStore.currentChatTaskKind, null);
});

test('a kind that arrives later is drawn on the next sync', async () => {
  const { pill, kind, appStore } = await setup();
  appStore.currentChatTaskKind = { id: 'planning', source: 'model', at: '2026-10-30T09:00:00.000Z' };
  kind.sync();
  assert.equal(pill.textContent.trim(), 'Planning & concepts');
});
