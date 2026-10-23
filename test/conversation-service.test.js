const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversationService } = require('../src/application/chat/conversation-service');
const { mergeSessionCost } = require('../src/shared/contracts/cost');

// The conversation around a turn (#981), in plain Node: an engine and a
// history held in memory, no Electron, no DOM.

const round = (rounds) => ({
  models: [{
    providerId: 'openai',
    model: 'gpt-x',
    tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0 },
    usd: { input: 0.001, cacheRead: 0, cacheWrite: 0, output: 0.0002 },
    priceSource: 'table',
    rounds,
    unpricedRounds: 0,
  }],
});

function memoryHistory(chats = {}) {
  const store = new Map(Object.entries(chats));
  return {
    store,
    load: async (id) => (store.has(id) ? structuredClone(store.get(id)) : null),
    addCost: async (id, cost) => {
      const chat = store.get(id);
      const next = mergeSessionCost(chat?.cost, cost);
      if (chat) chat.cost = next;
      return next;
    },
    setTitle: async (id, title) => {
      if (!store.has(id)) return false;
      store.get(id).title = title;
      return true;
    },
    save: async (chat) => {
      store.set(chat.id, { ...(store.get(chat.id) || {}), ...structuredClone(chat) });
      return { ok: true };
    },
    readAttachment: async () => ({ ok: false }),
  };
}

function fakeEngine({ result = { content: 'ok' }, title = 'A name' } = {}) {
  const calls = [];
  return {
    calls,
    send: async (request) => {
      calls.push(['send', request.payload.chatId]);
      return result;
    },
    abort: () => {},
    generateTitle: async ({ messages }) => {
      calls.push(['title', messages.map((m) => m.content)]);
      return title ? { title } : { error: 'no title' };
    },
  };
}

const TURN = [{ role: 'user', content: 'What is 2+2?' }, { role: 'assistant', content: 'Four.' }];

test('a turn\'s cost is added to the chat, and the reply carries the new sum', async () => {
  const history = memoryHistory({ c1: { id: 'c1', messages: TURN, cost: round(1) } });
  const engine = fakeEngine({ result: { content: 'ok', cost: round(2) } });
  const conversation = createConversationService({ engine, history });
  const reply = await conversation.runTurn({ sessionId: 1, chatId: 'c1', message: { content: 'More?' } });
  assert.equal(reply.content, 'ok');
  assert.equal(reply.chatCost.models[0].rounds, 3);
  assert.equal(history.store.get('c1').cost.models[0].rounds, 3);
});

test('a turn without cost leaves the sum alone', async () => {
  const history = memoryHistory({ c1: { id: 'c1', messages: TURN, cost: round(1) } });
  const conversation = createConversationService({ engine: fakeEngine({ result: { error: 'boom' } }), history });
  const reply = await conversation.runTurn({ sessionId: 1, chatId: 'c1', message: { content: 'More?' } });
  assert.equal('chatCost' in reply, false);
  assert.equal(history.store.get('c1').cost.models[0].rounds, 1);
});

test('a sum that cannot be written does not cost the turn its answer', async () => {
  const history = { ...memoryHistory(), addCost: async () => { throw new Error('disk gone'); } };
  const conversation = createConversationService({ engine: fakeEngine({ result: { content: 'ok', cost: round(1) } }), history });
  const original = console.error;
  console.error = () => {};
  try {
    const reply = await conversation.runTurn({ sessionId: 1, chatId: 'c1', message: { content: 'More?' } });
    assert.equal(reply.content, 'ok');
    assert.equal('chatCost' in reply, false);
  } finally {
    console.error = original;
  }
});

test('a chat is named from its first question and answer, once', async () => {
  const history = memoryHistory({ c1: { id: 'c1', title: '', messages: [...TURN, { role: 'user', content: 'And 3+3?' }] } });
  const engine = fakeEngine({ title: 'Simple sums' });
  const conversation = createConversationService({ engine, history });
  assert.deepEqual(await conversation.nameChat('c1'), { title: 'Simple sums' });
  assert.deepEqual(engine.calls.at(-1), ['title', ['What is 2+2?', 'Four.']]);
  assert.equal(history.store.get('c1').title, 'Simple sums');

  // Named now: no second request.
  assert.deepEqual(await conversation.nameChat('c1'), { title: null });
  assert.equal(engine.calls.length, 1);
});

test('no name without an answer, for an unknown chat, or when the model gives none', async () => {
  const history = memoryHistory({
    asked: { id: 'asked', title: '', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Failed', isError: true }] },
    plain: { id: 'plain', title: '', messages: TURN },
  });
  const conversation = createConversationService({ engine: fakeEngine({ title: '' }), history });
  assert.deepEqual(await conversation.nameChat('asked'), { title: null });
  assert.deepEqual(await conversation.nameChat('missing'), { title: null });
  assert.deepEqual(await conversation.nameChat('plain'), { title: null });
  assert.equal(history.store.get('plain').title, '');
});

test('a question from the phone is stored with its origin, and the model never sees it (#1197)', async () => {
  const history = memoryHistory({ c1: { id: 'c1', messages: TURN } });
  /** @type {any[]} */
  let sent = [];
  const engine = { ...fakeEngine(), send: async (request) => { sent = request.payload.messages; return { content: 'ok' }; } };
  const conversation = createConversationService({ engine, history });
  await conversation.runTurn({ sessionId: 'remote:c', chatId: 'c1', message: { content: 'From the train', origin: { kind: 'relay', client: 'iPhone' } } });
  const question = history.store.get('c1').messages[2];
  assert.deepEqual(question, { role: 'user', content: 'From the train', origin: { kind: 'relay', client: 'iPhone' } });
  assert.deepEqual(sent.at(-1), { role: 'user', content: 'From the train' });
  assert.ok(sent.every((message) => !('origin' in message)));

  // A question from the window, or one with a mark nobody gives, carries none.
  await conversation.runTurn({ sessionId: 1, chatId: 'c1', message: { content: 'At the desk', origin: { kind: 'desktop' } } });
  assert.deepEqual(history.store.get('c1').messages[4], { role: 'user', content: 'At the desk' });
});
