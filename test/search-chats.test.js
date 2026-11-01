'use strict';

// search_chats (#1315): the agent searches the earlier chats of the open
// workspace. Scoped to the run's folder (no folder: the chats without one),
// never the asking chat, and local chats stay local (decision 13) — not
// found from a cloud turn, without a count of what was left out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStorageService } = require('../src/main/services/storage-service');
const { createChatHistoryStorePort } = require('../src/main/adapters/persistence-store-adapters');
const { createChatHistoryService } = require('../src/main/services/chat-history-service');
const { createChatSearchService, queryWords, CHAT_SEARCH_LIMITS } = require('../src/main/services/chat-search-service');
const { createWorkspaceToolRegistry } = require('../src/application/tools/workspace-tool-registry');
const { createWorkspaceToolAdapter } = require('../src/main/adapters/workspace-tool-adapter');
const { createMockProviderCatalog } = require('./helpers/provider-ports');
const { removeTempDir } = require('./helpers/temp-dir');

/** Which model entries run on this computer, as the provider adapter would say. */
const MODELS = { ollama: { runsLocally: true, providerName: 'Ollama' }, openai: { runsLocally: false, providerName: 'OpenAI' } };

async function setup(t) {
  let clock = 1_000_000;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-search-chats-'));
  t.after(() => removeTempDir(tmpDir));
  const userData = path.join(tmpDir, 'user-data');
  const folderA = path.join(tmpDir, 'a');
  const folderB = path.join(tmpDir, 'b');
  for (const dir of [userData, folderA, folderB]) await fs.mkdir(dir);
  const storage = createStorageService({
    userDataPath: userData,
    secretStore: { isEncryptionAvailable: () => false },
    fs,
    path,
    providerCatalog: createMockProviderCatalog(() => null),
    maxChatSessions: 100,
    maxChatSessionsPerFolder: 50,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
  });
  const store = createChatHistoryStorePort(storage);
  /** @type {string|null} */
  let activeRoot = folderA;
  const chatHistory = createChatHistoryService({
    chatHistoryStore: store,
    getActiveWorkspaceRoot: () => activeRoot,
    isKnownWorkspaceRoot: async () => true,
    now: () => (clock += 1000),
  });
  /** @type {Array<string|null>} */
  const described = [];
  const chats = createChatSearchService({
    chatHistoryStore: store,
    describeModel: async (presetId) => {
      described.push(presetId);
      return MODELS[presetId] || null;
    },
    log: null,
  });
  const registry = createWorkspaceToolRegistry({ fsService: {}, chats });
  /** Calls the tool as the engine would, with the run's folder, chat and locality — local unless said otherwise. */
  const call = async (args, { root = activeRoot, chatId = 'asker', runsLocally = true } = {}) => JSON.parse(
    await registry.getDefinition('search_chats').handler(args, { workspaceRoot: root, chatId, runsLocally }),
  );
  /** Saves a chat with one turn in a folder, as the renderer would. */
  const save = async (id, root, text, extra = {}) => {
    activeRoot = root;
    const result = await chatHistory.saveSession({
      id, workspaceRoot: root, title: extra.title || `Chat ${id}`,
      messages: [{ role: 'user', content: text }, { role: 'assistant', content: `Noted: ${text}` }],
    });
    assert.equal(result.ok, true);
  };
  return {
    store, chatHistory, chats, registry, call, save, described, folderA, folderB,
    open: (root) => { activeRoot = root; },
  };
}

const found = (result) => (result.results || []).map((r) => r.chat).sort();

test('the tool registers as a read without a card and with its own line', async () => {
  const registry = createWorkspaceToolRegistry({ fsService: {}, chats: { search: async () => ({}), read: async () => ({}) } });
  const tool = registry.getTools({}).find((t) => t.function.name === 'search_chats');
  assert.ok(tool, 'offered with a chat search, also without a folder');
  assert.equal(registry.listRiskCatalog().find((e) => e.name === 'search_chats').riskClasses[0], 'read');
  const definition = registry.getDefinition('search_chats');
  assert.equal(definition.category, 'search', 'the injection detector looks at it');
  assert.equal(definition.contentScan, 'output', 'its output is checked for sensitive content');
  assert.deepEqual(definition.display, { key: 'tools.line.searchChats', target: 'query' });
  const without = createWorkspaceToolRegistry({ fsService: {} });
  assert.equal(without.getTools({}).some((t) => t.function.name === 'search_chats'), false);
});

test('scoped to the open workspace: chats of two folders never mix', async (t) => {
  const { call, save, folderA, folderB } = await setup(t);
  await save('a1', folderA, 'We moved the release marker to the top.');
  await save('a2', folderA, 'Nothing about it here.');
  await save('b1', folderB, 'The release marker of the customer project.');

  const fromA = await call({ query: 'release marker' }, { root: folderA });
  assert.deepEqual(found(fromA), ['a1']);
  assert.equal(JSON.stringify(fromA).includes('customer'), false, 'nothing of folder B in the answer');
  assert.deepEqual(found(await call({ query: 'release marker' }, { root: folderB })), ['b1']);

  // A reference from the other folder reads like one that does not exist.
  const notFound = await call({ chat: 'does-not-exist' }, { root: folderA });
  assert.ok(notFound.error);
  assert.deepEqual(await call({ chat: 'b1' }, { root: folderA }), notFound);
});

test('with no folder open it searches the chats without a folder, and only those', async (t) => {
  const { call, save, folderA } = await setup(t);
  await save('loose', null, 'Shopping list for the release party.');
  await save('a1', folderA, 'The release party is on Friday.');
  const result = await call({ query: 'release party' }, { root: null });
  assert.deepEqual(found(result), ['loose']);
  assert.match(result.note, /without a folder/);
  assert.deepEqual(found(await call({ query: 'release party' }, { root: folderA })), ['a1']);
});

test('the asking chat is never part of the result', async (t) => {
  const { call, save, folderA } = await setup(t);
  await save('a1', folderA, 'release marker');
  await save('a2', folderA, 'release marker again');
  assert.deepEqual(found(await call({ query: 'release marker' }, { chatId: 'a2' })), ['a1']);
  assert.ok((await call({ chat: 'a2' }, { chatId: 'a2' })).error);
});

test('every word has to occur; excerpts carry title, date, role and the message to read from', async (t) => {
  const { call, save, folderA } = await setup(t);
  await save('a1', folderA, `${'Lorem ipsum '.repeat(40)}the manual marker was wrong ${'dolor sit '.repeat(40)}`, { title: 'Release 1.28.1' });
  await save('a2', folderA, 'The manual is fine.');
  const result = await call({ query: 'Manual, MARKER!' });
  assert.deepEqual(found(result), ['a1']);
  const [hit] = result.results;
  assert.equal(hit.title, 'Release 1.28.1');
  assert.match(hit.date, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(hit.messages, 2);
  assert.ok(hit.excerpts.length >= 1 && hit.excerpts.length <= CHAT_SEARCH_LIMITS.EXCERPTS_PER_CHAT);
  assert.equal(hit.excerpts[0].message, 0);
  assert.equal(hit.excerpts[0].role, 'user');
  assert.match(hit.excerpts[0].text, /manual marker/);
  assert.ok(hit.excerpts[0].text.length <= CHAT_SEARCH_LIMITS.EXCERPT_CHARS + 2, 'an excerpt, not the message');
  // The title counts as part of the chat.
  assert.deepEqual(found(await call({ query: '1.28.1 marker' })), ['a1']);
  assert.ok((await call({ query: '  ' })).error, 'no words, no search');
  assert.ok((await call({ query: 'x', chat: 'a1' })).error, 'either search or read');
  assert.deepEqual(queryWords('„Release“ marker, release'), ['release', 'marker']);
});

test('newest first, and `more` when there are further chats beyond the limit', async (t) => {
  const { call, save, folderA } = await setup(t);
  for (const id of ['a1', 'a2', 'a3']) await save(id, folderA, 'deploy notes');
  const result = await call({ query: 'deploy', limit: 2 });
  assert.deepEqual(result.results.map((r) => r.chat), ['a3', 'a2']);
  assert.equal(result.more, true);
  assert.equal((await call({ query: 'deploy' })).more, undefined);
});

test('reading a chat goes on from `next` and stays within the size limit', async (t) => {
  const { call, chatHistory, folderA, open } = await setup(t);
  open(folderA);
  const long = 'x'.repeat(5000);
  const messages = [];
  for (let i = 0; i < 6; i += 1) messages.push({ role: i % 2 ? 'assistant' : 'user', content: `${i} ${long}` });
  await chatHistory.saveSession({ id: 'big', workspaceRoot: folderA, title: 'Big', messages });

  const first = await call({ chat: 'big' });
  assert.equal(first.total, 6);
  const size = first.messages.reduce((sum, m) => sum + m.text.length, 0);
  assert.ok(size <= CHAT_SEARCH_LIMITS.READ_CHARS + 10, `${size} characters`);
  assert.ok(Number.isInteger(first.next));
  const second = await call({ chat: 'big', from: first.next });
  assert.equal(second.messages[0].index, first.next);
  assert.ok(second.messages[0].text.startsWith(`${first.next} `));
});

test('a new chat is local from its first save and cloud for good from its first cloud turn', async (t) => {
  const { store, chatHistory, save, folderA } = await setup(t);
  await save('a1', folderA, 'local talk');
  assert.equal((await store.getSessionMeta('a1')).locality, 'local');
  assert.equal(await chatHistory.markCloudTurn('a1'), true);
  assert.equal((await store.getSessionMeta('a1')).locality, 'cloud');
  // A later save by the renderer cannot take it back, nor set it.
  await chatHistory.saveSession({ id: 'a1', workspaceRoot: folderA, locality: 'local', messages: [{ role: 'user', content: 'more' }] });
  assert.equal((await store.getSessionMeta('a1')).locality, 'cloud');
  await chatHistory.saveSession({ id: 'a2', workspaceRoot: folderA, locality: 'cloud', messages: [{ role: 'user', content: 'x' }] });
  assert.equal((await store.getSessionMeta('a2')).locality, 'local');
  // A first turn on a cloud model that ends before the first save: the save takes it along.
  await chatHistory.markCloudTurn('fresh');
  await save('fresh', folderA, 'first words to the cloud');
  assert.equal((await store.getSessionMeta('fresh')).locality, 'cloud');
});

test('from a chat on a cloud model, local chats are not found at all — and nothing counts them', async (t) => {
  const { call, chatHistory, save, folderA } = await setup(t);
  await save('cloud1', folderA, 'budget plan for the release');
  await chatHistory.markCloudTurn('cloud1');
  await save('asker', folderA, 'what was the budget?');
  await chatHistory.markCloudTurn('asker');
  const withoutLocal = await call({ query: 'budget release' }, { chatId: 'asker', runsLocally: false });

  await save('local1', folderA, 'private budget plan for the release, salaries included');
  const fromCloud = await call({ query: 'budget release' }, { chatId: 'asker', runsLocally: false });
  assert.deepEqual(found(fromCloud), ['cloud1']);
  assert.deepEqual(fromCloud, withoutLocal, 'the answer is the same as if the local chat did not exist');
  assert.equal(JSON.stringify(fromCloud).includes('salaries'), false);
  assert.deepEqual(await call({ chat: 'local1' }, { chatId: 'asker' }), await call({ chat: 'nope' }, { chatId: 'asker' }));

  // Only local chats match: an empty answer, worded as if there were none.
  const onlyLocal = await call({ query: 'salaries' }, { chatId: 'asker', runsLocally: false });
  assert.deepEqual(onlyLocal, await call({ query: 'nothingmatchesthis' }, { chatId: 'asker', runsLocally: false }));
});

test('from a local chat, everything in the folder is found', async (t) => {
  const { call, chatHistory, save, folderA } = await setup(t);
  await save('cloud1', folderA, 'budget in the cloud');
  await chatHistory.markCloudTurn('cloud1');
  await save('local1', folderA, 'budget kept local');
  await save('asker', folderA, 'question');
  assert.deepEqual(found(await call({ query: 'budget' }, { chatId: 'asker', runsLocally: true })), ['cloud1', 'local1']);
  assert.equal((await call({ chat: 'local1' }, { chatId: 'asker', runsLocally: true })).chat, 'local1');
});

test('a local turn in a chat that went to the cloud before is not a local chat', async (t) => {
  const { call, chatHistory, save, folderA } = await setup(t);
  await save('local1', folderA, 'budget kept local');
  await save('asker', folderA, 'question');
  await chatHistory.markCloudTurn('asker');
  assert.deepEqual(found(await call({ query: 'budget' }, { chatId: 'asker', runsLocally: true })), []);
});

test('a chat from before the marker counts as local when its current model is local', async (t) => {
  const { call, store, save, described, folderA } = await setup(t);
  await save('old-local', folderA, 'budget from the old days');
  await save('old-cloud', folderA, 'budget from the cloud days');
  await save('old-unknown', folderA, 'budget with a model that is gone');
  // As saved before #1315: no marker, only the chat's model.
  await store.patchSession('old-local', { locality: undefined, modelPresetId: 'ollama' });
  await store.patchSession('old-cloud', { locality: undefined, modelPresetId: 'openai' });
  await store.patchSession('old-unknown', { locality: undefined, modelPresetId: 'removed' });
  assert.equal((await store.getSessionMeta('old-local')).locality, undefined);

  assert.deepEqual(found(await call({ query: 'budget' }, { runsLocally: false })), ['old-cloud'],
    'a local or unresolvable model hides the chat from a cloud turn');
  assert.deepEqual(described.sort(), ['ollama', 'openai', 'removed'], 'each model looked up once');
  assert.deepEqual(found(await call({ query: 'budget' }, { runsLocally: true })), ['old-cloud', 'old-local', 'old-unknown']);
});

test('its results pass the secret protection and the sensitive-content check like any other', async (t) => {
  const { registry, save, folderA } = await setup(t);
  await save('a1', folderA, 'the key was sk-own-provider-key-123456, do not share');
  await save('a2', folderA, 'config line: aws AKIAABCDEFGHIJKLMNOP for the deploy');
  const adapter = createWorkspaceToolAdapter(registry, { readOwnSecrets: async () => ['sk-own-provider-key-123456'] });
  const context = { workspaceRoot: folderA, chatId: 'asker', runsLocally: true, approved: true };
  const own = await adapter.execute('search_chats', { query: 'key share' }, context);
  assert.deepEqual(own.hardLimit, { reason: 'own_secret' });
  assert.equal(own.output.includes('sk-own-provider-key-123456'), false);
  const sensitive = await adapter.execute('search_chats', { query: 'config line' }, context);
  assert.equal(sensitive.sensitive, true, 'escalated to read-sensitive like a file read');
});
