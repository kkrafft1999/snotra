const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createChatEngine } = require('../src/application/chat/chat-engine');
const { createConversationService } = require('../src/application/chat/conversation-service');
const { createStorageService } = require('../src/main/services/storage-service');
const { createChatHistoryStorePort } = require('../src/main/adapters/persistence-store-adapters');
const { createChatHistoryService } = require('../src/main/services/chat-history-service');
const { createChatAttachmentStore } = require('../src/main/services/chat-attachment-store');
const { createChatHistoryAdapter } = require('../src/main/adapters/chat-history-adapter');
const { createMockProviderCatalog } = require('./helpers/provider-ports');
const { formatLine } = require('./helpers/tool-descriptors');
const { removeTempDir } = require('./helpers/temp-dir');

// The core keeps the conversation (#981): a turn appended to the stored chat,
// saved after each finished step (#979) and once it settles — in plain Node,
// against the real engine and the real history on disk.

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const WORKSPACE = path.resolve('/work/a');

function text(content) {
  return { message: { role: 'assistant', content }, finishReason: 'stop', usage: { prompt: 10, completion: 2, total: 12 } };
}
function callTool(name, args) {
  return {
    message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    finishReason: 'tool_calls',
    usage: null,
  };
}

/**
 * A model that answers from a list; a function entry runs before it answers.
 * A title request, made in the background after a turn, gets `titled` and
 * leaves the list alone — given, unless the list is meant to answer it.
 */
function fakeLlm(rounds, { titled = null } = {}) {
  const seen = [];
  let index = 0;
  return {
    seen,
    async resolveChatTarget() { return { providerId: 'test', model: 'test-model' }; },
    async validateTarget() { return null; },
    async prepareSendBundle(target) {
      return { config: { apiKey: 'test' }, model: target.model, providerName: 'Test', capabilities: { images: true } };
    },
    async streamRound(params) {
      const isTitle = String(params.messages?.[0]?.content || '').startsWith('You name conversations.');
      if (isTitle && titled !== null) return text(titled);
      seen.push(params.messages);
      const round = rounds[Math.min(index, rounds.length - 1)];
      index += 1;
      const answer = typeof round === 'function' ? await round(params) : round;
      if (answer?.message?.content && params.callbacks?.onTextDelta) params.callbacks.onTextDelta(answer.message.content);
      return answer;
    },
    formatRoundError: (error) => String(error?.message || error),
  };
}

const tools = {
  getTools: () => [{ type: 'function', function: { name: 'list_directory' } }],
  buildSystemPrompt: () => '',
  requiresWorkspace: () => true,
  supportsSkillPaths: () => false,
  plan: async (tool, args) => ({ tool, riskClasses: ['read'], targets: [], planKey: JSON.stringify([tool, args]) }),
  buildTraceEntry: (tool, args, extra = {}) => ({ tool, args, ...extra }),
  formatDisplayLine: (entry, phase) => formatLine(entry, phase),
  execute: async () => ({ output: JSON.stringify({ entries: ['README.md'] }), progressEvents: [] }),
};

async function setup(t, rounds, { titled = null } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-turn-'));
  let conversation = null;
  t.after(async () => {
    await conversation?.settled();
    await removeTempDir(tmpDir);
  });
  const storage = createStorageService({
    userDataPath: tmpDir,
    secretStore: { isEncryptionAvailable: () => false },
    fs,
    path,
    providerCatalog: createMockProviderCatalog(() => null),
    maxChatSessions: 10,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
  });
  const chatAttachments = createChatAttachmentStore({ userDataPath: tmpDir, fs, path });
  const chatHistory = createChatHistoryService({
    chatHistoryStore: createChatHistoryStorePort(storage),
    chatAttachments,
    getActiveWorkspaceRoot: () => WORKSPACE,
  });
  const llm = fakeLlm(rounds, { titled });
  const engine = createChatEngine({
    llm,
    tools,
    preferences: { async read() { return {}; } },
    workspacePaths: {
      resolveRoot: (root) => (typeof root === 'string' && root ? path.resolve(root) : null),
      resolveSelection: () => null,
      basename: (p) => path.basename(p),
    },
    maxToolRounds: 3,
  });
  conversation = createConversationService({
    engine,
    history: createChatHistoryAdapter(chatHistory),
    describeError: (error) => `Error: ${typeof error === 'string' ? error : error?.key}`,
  });
  const events = [];
  const turn = (chatId, message, extra = {}) => conversation.runTurn({
    sessionId: 7,
    chatId,
    message,
    workspaceRoot: WORKSPACE,
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { chatHistory, conversation, llm, events, turn };
}

/** Resolves once the model has the turn: then a stop or a reload reaches the engine. */
function modelReached() {
  let reached;
  const promise = new Promise((resolve) => { reached = resolve; });
  return { promise, reached };
}

const progress = (events, type) => events.filter((e) => e.type === 'progress' && e.payload?.type === type).map((e) => e.payload);

test('a first turn makes the chat: question and answer saved, the chat its folder\'s active one, named', async (t) => {
  const { chatHistory, conversation, events, turn } = await setup(t, [text('Hello there.'), text('Greetings')]);
  const result = await turn('new-chat', { content: 'Hi' });
  assert.equal(result.content, 'Hello there.');

  const stored = await chatHistory.load('new-chat');
  assert.deepEqual(stored.messages.map((m) => [m.role, m.content, m.interrupted === true]), [
    ['user', 'Hi', false],
    ['assistant', 'Hello there.', false],
  ]);
  assert.equal(stored.workspaceRoot, WORKSPACE, 'a new chat goes under the open folder');
  assert.equal((await chatHistory.listForActiveFolder()).activeChatId, 'new-chat');
  assert.ok(progress(events, 'chat-saved').length >= 2 && progress(events, 'chat-saved').every((p) => p.ok && p.problem === null));

  await conversation.settled();
  assert.deepEqual(progress(events, 'chat-named'), [{ type: 'chat-named', title: 'Greetings' }]);
  assert.equal((await chatHistory.load('new-chat')).title, 'Greetings');
});

test('a stored chat is resumed: its earlier turns, image included, reach the model before the new question', async (t) => {
  const { chatHistory, llm, turn } = await setup(t, [text('A tiny picture.'), text('Picture')]);
  await chatHistory.saveSession({
    id: 'stored',
    workspaceRoot: WORKSPACE,
    messages: [
      { role: 'user', content: 'Look', attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: PNG_1PX, name: 'dot.png' }] },
      { role: 'assistant', content: 'A dot.' },
    ],
  });
  const before = await chatHistory.load('stored');
  assert.ok(before.messages[0].attachments[0].file, 'the history keeps the image as a file');

  await turn('stored', { content: 'How big is it?' });
  const sent = llm.seen[0].filter((m) => m.role !== 'system');
  assert.deepEqual(sent.map((m) => m.role), ['user', 'assistant', 'user']);
  const image = JSON.stringify(sent[0]);
  assert.ok(image.includes(PNG_1PX), 'the earlier image goes to the model as data');
  assert.equal((await chatHistory.load('stored')).messages.length, 4);
});

test('a turn is saved after each finished step and stored as cut off until it settles (#979)', async (t) => {
  let midRun = null;
  let history;
  const { chatHistory, turn } = await setup(t, [
    callTool('list_directory', { relative_path: '.' }),
    async () => {
      // The second round: the step is done; wait for its checkpoint on disk.
      for (let i = 0; i < 200; i += 1) {
        midRun = await history.load('tools');
        if (midRun?.messages?.[1]?.toolTrace?.length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return text('There is a README.');
    },
    text('Folder'),
  ]);
  history = chatHistory;
  await turn('tools', { content: 'What is here?' });

  const answerMidRun = midRun.messages[1];
  assert.equal(answerMidRun.interrupted, true, 'mid-run the turn is stored as cut off');
  assert.equal(answerMidRun.toolTrace.length, 1, 'with the finished step');
  assert.equal(answerMidRun.toolTrace[0].tool, 'list_directory');

  const settled = (await chatHistory.load('tools')).messages[1];
  assert.equal(settled.interrupted, undefined, 'the settled turn drops the mark');
  assert.equal(settled.content, 'There is a README.');
  assert.equal(settled.toolTrace.length, 1);
  assert.equal(JSON.stringify(settled).includes('relative_path'), false, 'no arguments in the history');
});

test('a turn the user stops is kept as far as it had come, not as cut off', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const model = modelReached();
  const { chatHistory, conversation, turn } = await setup(t, [async (params) => {
    params.callbacks.onTextDelta('Half an ans');
    model.reached();
    await gate;
    return text('never seen');
  }]);
  const running = turn('stopped', { content: 'Tell me' });
  await model.promise;
  conversation.stop(7, 'stopped');
  release();
  await running;
  const answer = (await chatHistory.load('stopped')).messages[1];
  assert.equal(answer.content, 'Half an ans');
  assert.equal(answer.interrupted, undefined);
});

test('a front end that goes away leaves the last save, marked as cut off, and nothing more (#979)', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const model = modelReached();
  const { chatHistory, conversation, events, turn } = await setup(t, [async () => {
    model.reached();
    await gate;
    return text('never written');
  }]);
  const running = turn('gone', { content: 'Long question' });
  await model.promise;
  conversation.abandon(7);
  release();
  await running;
  const stored = await chatHistory.load('gone');
  assert.equal(stored.messages.length, 2);
  assert.equal(stored.messages[1].interrupted, true);
  assert.equal(progress(events, 'chat-named').length, 0);
});

test('a chat deleted while its turn runs is not written back', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const model = modelReached();
  const { chatHistory, turn } = await setup(t, [async () => {
    model.reached();
    await gate;
    return text('too late');
  }]);
  const running = turn('doomed', { content: 'Hi' });
  await model.promise;
  await chatHistory.deleteSession('doomed');
  release();
  await running;
  assert.equal(await chatHistory.load('doomed'), null);
});

test('a failed turn keeps the question and says why, in the interface\'s words', async (t) => {
  const { chatHistory, turn } = await setup(t, [{ error: 'boom', code: 'api' }]);
  const result = await turn('failed', { content: 'Hi' });
  assert.ok(result.error);
  const stored = await chatHistory.load('failed');
  assert.equal(stored.messages.length, 2);
  assert.equal(stored.messages[1].isError, true);
  assert.match(stored.messages[1].content, /^Error: /);
});

test('a stop pressed while the chat is still being loaded is not lost', async (t) => {
  const { chatHistory, conversation, llm, turn } = await setup(t, [text('never asked')]);
  const running = turn('quick', { content: 'Hi' });
  conversation.stop(7, 'quick');
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(llm.seen.length, 0, 'the model was never asked');
  assert.deepEqual((await chatHistory.load('quick')).messages.map((m) => m.role), ['user'], 'the question stays');
});

test('a turn whose saves failed is not lost: the next turn goes on from it and saves all of it (#977)', async (t) => {
  const { chatHistory, conversation, turn } = await setup(t, [text('First answer.'), text('Second answer.'), text('Name')]);
  const realSave = chatHistory.save;
  let failing = true;
  chatHistory.save = async (chat, options) => (failing ? { ok: false, unreadable: true } : realSave(chat, options));
  await turn('flaky', { content: 'First question' });
  assert.equal(await chatHistory.load('flaky'), null, 'nothing reached the disk');

  failing = false;
  await turn('flaky', { content: 'Second question' });
  await conversation.settled();
  assert.deepEqual((await chatHistory.load('flaky')).messages.map((m) => m.content), [
    'First question', 'First answer.', 'Second question', 'Second answer.',
  ]);
});

test('a question sent right after a stop goes on from the stopped turn, not from an older save', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const model = modelReached();
  const { chatHistory, conversation, turn } = await setup(t, [
    async (params) => {
      params.callbacks.onTextDelta('Half');
      model.reached();
      await gate;
      return text('never seen');
    },
    text('Second answer.'),
  ], { titled: 'Name' });
  const first = turn('quick-again', { content: 'First' });
  await model.promise;
  conversation.stop(7, 'quick-again');
  const second = turn('quick-again', { content: 'Second' });
  release();
  await Promise.all([first, second]);
  await conversation.settled();
  const stored = (await chatHistory.load('quick-again')).messages;
  assert.deepEqual(stored.map((m) => [m.content, m.interrupted === true]), [
    ['First', false], ['Half', false], ['Second', false], ['Second answer.', false],
  ]);
});

test('a new turn in a chat whose turn still runs stops that one first', async (t) => {
  const model = modelReached();
  const { chatHistory, conversation, turn } = await setup(t, [
    async (params) => {
      params.callbacks.onTextDelta('Working');
      model.reached();
      await new Promise((resolve) => params.abortSignal?.addEventListener('abort', resolve, { once: true }));
      return { cancelled: true, message: { role: 'assistant', content: '' } };
    },
    text('Replacement.'),
  ], { titled: 'Name' });
  const first = turn('replaced', { content: 'One' });
  await model.promise;
  const second = turn('replaced', { content: 'Two' });
  await Promise.all([first, second]);
  await conversation.settled();
  assert.deepEqual((await chatHistory.load('replaced')).messages.map((m) => m.content), ['One', 'Working', 'Two', 'Replacement.']);
});

test('stopChat stops the turn of a chat whichever front end started it (#1194)', async (t) => {
  const model = modelReached();
  const { chatHistory, conversation, turn } = await setup(t, [
    async (params) => {
      params.callbacks.onTextDelta('Partly');
      model.reached();
      await new Promise((resolve) => params.abortSignal?.addEventListener('abort', resolve, { once: true }));
      return { cancelled: true, message: { role: 'assistant', content: '' } };
    },
  ]);
  assert.equal(conversation.stopChat('remote-stop'), false, 'nothing runs yet');
  // Started by the window (session 7); stopped without naming it, as a phone does.
  const running = turn('remote-stop', { content: 'Go' });
  await model.promise;
  assert.equal(conversation.stopChat('remote-stop'), true);
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(conversation.stopChat('remote-stop'), false, 'it ended');
  assert.deepEqual((await chatHistory.load('remote-stop')).messages.map((m) => m.content), ['Go', 'Partly']);
});
