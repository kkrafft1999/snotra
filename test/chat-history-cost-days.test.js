const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStorageService } = require('../src/main/services/storage-service');
const { createChatHistoryStorePort } = require('../src/main/adapters/persistence-store-adapters');
const { createChatHistoryService } = require('../src/main/services/chat-history-service');
const { createUsageReportService } = require('../src/main/services/usage-report-service');
const { createMockProviderCatalog } = require('./helpers/provider-ports');
const { removeTempDir } = require('./helpers/temp-dir');

// A turn's cost is booked on the day it ended (#1258), in main, and a sum from
// before that keeps the day the chat was last used.

const NOON = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

async function setup(t, { maxChatSessions = 10 } = {}) {
  let clock = NOON(2026, 10, 1);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-cost-days-'));
  t.after(() => removeTempDir(tmpDir));
  const storage = createStorageService({
    userDataPath: tmpDir,
    secretStore: { isEncryptionAvailable: () => false },
    fs,
    path,
    providerCatalog: createMockProviderCatalog(() => null),
    maxChatSessions,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
  });
  const chatHistoryStore = createChatHistoryStorePort(storage);
  const chatHistory = createChatHistoryService({
    chatHistoryStore,
    getActiveWorkspaceRoot: () => '/work/a',
    now: () => clock,
  });
  const usageReport = createUsageReportService({
    chatHistoryStore,
    providerName: (id) => (id === 'openai' ? 'OpenAI' : null),
  });
  return { chatHistory, chatHistoryStore, usageReport, setClock: (ms) => { clock = ms; } };
}

const turn = (text) => [{ role: 'user', content: text }, { role: 'assistant', content: `re: ${text}` }];

const turnCost = (rounds = 1, model = 'gpt-x') => ({
  models: [{
    providerId: 'openai',
    model,
    tokens: { input: 1000 * rounds, cacheRead: 0, cacheWrite: 0, output: 100 * rounds, reasoning: 0 },
    usd: { input: 0.001 * rounds, cacheRead: 0, cacheWrite: 0, output: 0.0002 * rounds },
    priceSource: 'table',
    rounds,
    unpricedRounds: 0,
  }],
  priceTable: { date: '2026-10-15', origin: 'bundled' },
});

const daysOf = (cost) => (cost?.days || []).map((d) => [d.date, d.model, d.rounds]);

test('each turn is booked on the day it ended, and the totals stay as they were', async (t) => {
  const { chatHistory, chatHistoryStore, setClock } = await setup(t);
  await chatHistory.saveSession({ id: 'c1', title: 'One', messages: turn('hi') });
  setClock(NOON(2026, 10, 3));
  await chatHistory.addCost('c1', turnCost(2));
  setClock(NOON(2026, 10, 3) + 3600_000);
  await chatHistory.addCost('c1', turnCost(1));
  setClock(NOON(2026, 10, 9));
  const cost = await chatHistory.addCost('c1', turnCost(1, 'gpt-y'));
  assert.deepEqual(daysOf(cost), [['2026-10-03', 'gpt-x', 3], ['2026-10-09', 'gpt-y', 1]]);
  assert.deepEqual(cost.models.map((m) => [m.model, m.rounds]), [['gpt-x', 3], ['gpt-y', 1]]);
  // In the index, where the report reads it.
  assert.deepEqual(daysOf((await chatHistoryStore.getSessionMeta('c1')).cost), daysOf(cost));
});

test('a sum from before #1258 is pinned to the last use before the new turn is added', async (t) => {
  const { chatHistory, chatHistoryStore, setClock } = await setup(t);
  setClock(NOON(2026, 9, 12));
  await chatHistory.saveSession({ id: 'old', title: 'Old', messages: turn('hi') });
  // What an older release left: a total without days.
  await chatHistoryStore.patchSession('old', { cost: turnCost(4) });
  assert.equal((await chatHistoryStore.getSessionMeta('old')).cost.days, undefined);

  setClock(NOON(2026, 10, 20));
  const cost = await chatHistory.addCost('old', turnCost(1));
  assert.deepEqual(daysOf(cost), [['2026-09-12', 'gpt-x', 4], ['2026-10-20', 'gpt-x', 1]]);
  assert.equal(cost.models[0].rounds, 5);
});

test('the cost of a chat not yet saved waits with its day and arrives with the first save', async (t) => {
  const { chatHistory, chatHistoryStore, setClock } = await setup(t);
  setClock(NOON(2026, 10, 4));
  await chatHistory.addCost('fresh', turnCost(1));
  await chatHistory.saveSession({ id: 'fresh', title: 'Fresh', messages: turn('hi') });
  assert.deepEqual(daysOf((await chatHistoryStore.getSessionMeta('fresh')).cost), [['2026-10-04', 'gpt-x', 1]]);
});

test('the history list carries the sum without the days', async (t) => {
  const { chatHistory, setClock } = await setup(t);
  await chatHistory.saveSession({ id: 'c1', title: 'One', messages: turn('hi') });
  setClock(NOON(2026, 10, 3));
  await chatHistory.addCost('c1', turnCost(1));
  const { sessions } = await chatHistory.listForActiveFolder();
  assert.equal(sessions[0].cost.models[0].rounds, 1);
  assert.equal('days' in sessions[0].cost, false);
});

test('the report reads the index, names the providers and forgets a deleted chat', async (t) => {
  const { chatHistory, usageReport, setClock } = await setup(t);
  await chatHistory.saveSession({ id: 'a', title: 'A', messages: turn('a') });
  await chatHistory.saveSession({ id: 'b', title: 'B', messages: turn('b') });
  setClock(NOON(2026, 10, 5));
  await chatHistory.addCost('a', turnCost(1));
  await chatHistory.addCost('b', turnCost(2, 'other'));

  let report = await usageReport.report({ from: '2026-10-01', to: '2026-10-31' });
  assert.equal(report.totals.chats, 2);
  assert.deepEqual(report.models.map((m) => [m.model, m.providerName]), [['other', 'OpenAI'], ['gpt-x', 'OpenAI']]);
  assert.equal(report.chats[0].models[0].providerName, 'OpenAI');
  assert.equal(report.workspaces[0].workspaceRoot, path.resolve('/work/a'));
  assert.equal(report.historyFull, false);

  await chatHistory.deleteSession('b');
  report = await usageReport.report({ from: null, to: null });
  assert.deepEqual(report.chats.map((c) => c.id), ['a']);
  assert.equal(report.totals.rounds, 1);
});
