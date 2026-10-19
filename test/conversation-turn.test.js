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

/** A model that answers from a list; a function entry runs before it answers. */
function fakeLlm(rounds) {
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

async function setup(t, rounds) {
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
  const llm = fakeLlm(rounds);
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
  assert.ok(progress(events, 'chat-saved').length >= 2 && progress(events, 'chat-saved').every((p) => p.ok));

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
      // The second round: the step is done, the checkpoint written.
      await new Promise((resolve) => setTimeout(resolve, 20));
      midRun = await history.load('tools');
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
  const { chatHistory, conversation, turn } = await setup(t, [async (params) => {
    params.callbacks.onTextDelta('Half an ans');
    await gate;
    return text('never seen');
  }]);
  const running = turn('stopped', { content: 'Tell me' });
  await new Promise((resolve) => setTimeout(resolve, 20));
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
  const { chatHistory, conversation, events, turn } = await setup(t, [async () => {
    await gate;
    return text('never written');
  }]);
  const running = turn('gone', { content: 'Long question' });
  await new Promise((resolve) => setTimeout(resolve, 20));
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
  const { chatHistory, turn } = await setup(t, [async () => {
    await gate;
    return text('too late');
  }]);
  const running = turn('doomed', { content: 'Hi' });
  await new Promise((resolve) => setTimeout(resolve, 20));
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
