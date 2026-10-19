const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createChatEngine } = require('../src/application/chat/chat-engine');
const { createConversationService } = require('../src/application/chat/conversation-service');
const { createCostEntry } = require('../src/shared/contracts/cost');
const { createStorageService } = require('../src/main/services/storage-service');
const { createChatHistoryStorePort } = require('../src/main/adapters/persistence-store-adapters');
const { createChatHistoryService } = require('../src/main/services/chat-history-service');
const { createChatHistoryAdapter } = require('../src/main/adapters/chat-history-adapter');
const { createMockProviderCatalog } = require('./helpers/provider-ports');
const { removeTempDir } = require('./helpers/temp-dir');

// A front end without Electron and without a DOM (#981, scenario CORE-1):
// it opens a chat stored on disk, runs a turn through the core, and the chat
// on disk carries the turn's cost and the name the model gave it.

const PRICE = { input: 1, output: 2 };

function fakeLlm(answers) {
  const seen = [];
  let index = 0;
  return {
    seen,
    async resolveChatTarget() { return { providerId: 'test', model: 'test-model' }; },
    async validateTarget() { return null; },
    async prepareSendBundle(target) {
      return { config: { apiKey: 'test' }, model: target.model, providerName: 'Test', capabilities: {} };
    },
    async streamRound(params) {
      seen.push(params.messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : ''}`));
      const content = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return {
        message: { role: 'assistant', content },
        finishReason: 'stop',
        usage: { prompt: 1000, completion: 100, total: 1100 },
        cost: {
          entry: createCostEntry({
            providerId: 'test',
            model: 'test-model',
            usage: { input_tokens: 1000, output_tokens: 100 },
            price: PRICE,
            priceSource: 'override',
          }),
          priceTable: { date: '2026-10-19', origin: 'bundled' },
        },
      };
    },
    formatRoundError: (error) => String(error?.message || error),
  };
}

test('a stored chat is resumed and a turn runs through the core, without Electron or a DOM', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-resume-'));
  t.after(() => removeTempDir(tmpDir));
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
  const chatHistory = createChatHistoryService({ chatHistoryStore: createChatHistoryStorePort(storage) });
  await chatHistory.saveSession({
    id: 'stored',
    messages: [
      { role: 'user', content: 'What is the capital of France?' },
      { role: 'assistant', content: 'Paris.' },
    ],
  });

  const llm = fakeLlm(['About two million.', 'Paris facts']);
  const engine = createChatEngine({
    llm,
    tools: {
      getTools: () => [],
      buildSystemPrompt: () => '',
      requiresWorkspace: () => true,
      supportsSkillPaths: () => false,
      plan: async () => null,
      buildTraceEntry: (tool, args) => ({ tool, args }),
      formatDisplayLine: () => '',
      execute: async () => ({ output: '{}', progressEvents: [] }),
    },
    preferences: { async read() { return {}; } },
    workspacePaths: {
      resolveRoot: () => null,
      resolveSelection: () => null,
      basename: (p) => path.basename(p),
    },
    maxToolRounds: 2,
  });
  const conversation = createConversationService({ engine, history: createChatHistoryAdapter(chatHistory) });

  // The front end names the chat and sends its question; the core does the rest.
  const result = await conversation.runTurn({ sessionId: 'cli-1', chatId: 'stored', message: { content: 'And its population?' } });
  assert.equal(result.content, 'About two million.');
  assert.deepEqual(llm.seen[0].filter((line) => !line.startsWith('system:')), [
    'user:What is the capital of France?',
    'assistant:Paris.',
    'user:And its population?',
  ], 'the stored turns reach the model before the new question');

  // The chat's sum is the core's word, and it is on disk.
  assert.equal(result.chatCost.models[0].rounds, 1);
  assert.equal((await chatHistory.load('stored')).cost.models[0].rounds, 1);

  // The turn is in the chat on disk, and the core named the chat after it.
  await conversation.settled();
  const stored = await chatHistory.load('stored');
  assert.deepEqual(stored.messages.map((m) => m.content), [
    'What is the capital of France?', 'Paris.', 'And its population?', 'About two million.',
  ]);
  assert.equal(stored.title, 'Paris facts');
});
