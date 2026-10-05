const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_REASONING_LEVEL,
  normalizeReasoningLevel,
  reasoningLevelsFor,
  resolveReasoningLevel,
} = require('../src/shared/contracts/reasoning');
const openai = require('../src/main/providers/openai');
const ollama = require('../src/main/providers/ollama');
const {
  normalizeSessionForStore,
  normalizeSessionForLoad,
} = require('../src/main/services/chat-history-normalization');

// The reasoning level belongs to the chat (#725).

test('a level is a short lower-case word', () => {
  assert.equal(normalizeReasoningLevel(' high '), 'high');
  for (const bad of ['', 'HIGH', 'x'.repeat(17), 'low;', 'medium high', 3, null, undefined]) {
    assert.equal(normalizeReasoningLevel(bad), undefined, String(bad));
  }
});

test('OpenAI offers its levels for GPT-5 and newer only; other providers offer none', () => {
  assert.deepEqual(reasoningLevelsFor(openai, 'gpt-5-mini'), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(reasoningLevelsFor(openai, 'gpt-4o-mini'), []);
  assert.deepEqual(reasoningLevelsFor(ollama, 'llama3.2'), []);
  assert.deepEqual(reasoningLevelsFor(null, 'gpt-5'), []);
  assert.equal(openai.reasoning.defaultLevel, DEFAULT_REASONING_LEVEL);
});

test('the round runs with the chat\'s level, else the entry\'s, else the default', () => {
  const levels = ['low', 'medium', 'high'];
  assert.equal(resolveReasoningLevel({ levels, own: 'high', fromEntry: 'low', defaultLevel: 'medium' }), 'high');
  assert.equal(resolveReasoningLevel({ levels, own: null, fromEntry: 'low', defaultLevel: 'medium' }), 'low');
  assert.equal(resolveReasoningLevel({ levels, own: 'max', fromEntry: 'ultra', defaultLevel: 'medium' }), 'medium');
  assert.equal(resolveReasoningLevel({ levels: ['high'], own: null }), 'high');
  assert.equal(resolveReasoningLevel({ levels: [], own: 'high' }), undefined);
});

test('the history keeps a valid level and drops anything else', () => {
  const row = { id: 'a', title: 'A', updatedAt: 1, messages: [{ role: 'user', content: 'Hi' }] };
  assert.equal(normalizeSessionForStore({ ...row, reasoningEffort: 'xhigh' }).reasoningEffort, 'xhigh');
  assert.equal('reasoningEffort' in normalizeSessionForStore({ ...row, reasoningEffort: 'X; rm' }), false);
  assert.equal(normalizeSessionForLoad({ ...row, reasoningEffort: 'low' }).reasoningEffort, 'low');
  assert.equal('reasoningEffort' in normalizeSessionForLoad(row), false);
});
