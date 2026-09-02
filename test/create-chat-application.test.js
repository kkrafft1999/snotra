const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createChatApplication } = require('../src/main/composition/create-chat-application');

function assistantToolCall(id, name, args) {
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
    finishReason: 'tool_calls',
    usage: null,
  };
}

function assistantText(content) {
  return { message: { role: 'assistant', content }, finishReason: 'stop', usage: null };
}

test('createChatApplication wires provider rounds and tools end-to-end', async () => {
  let round = 0;
  const calls = [];
  const provider = {
    id: 'test',
    name: 'Test',
    defaultModel: 'test-model',
    fields: {},
    async streamChatRound(args) {
      calls.push(args);
      args.callbacks?.onTextDelta('hi');
      round += 1;
      if (round === 1) {
        return assistantToolCall('call_1', 'list_directory', { relative_path: '.' });
      }
      return assistantText('done');
    },
  };

  const llmConfigStore = {
    readLLMConfig: async () => ({}),
    resolveChatModelTarget: () => ({ providerId: 'test', model: 'test-model' }),
  };
  const providerSecrets = {
    getEffectiveProviderConfig: async () => ({ apiKey: 'sk-test', model: 'test-model' }),
  };

  const toolRegistry = {
    getTools: () => [{ type: 'function', function: { name: 'list_directory' } }],
    buildSystemPrompt: () => 'Tools: list_directory',
    execute: async () => JSON.stringify({ ok: true }),
  };

  const { engine } = createChatApplication({
    llmConfigStore,
    providerRuntime: { getProvider: () => provider },
    providerSecrets,
    uiPrefsStore: { readUIPrefs: async () => ({}) },
    toolRegistry,
    path,
    maxToolRounds: 3,
  });

  const result = await engine.send({
    sessionId: 'e2e-1',
    payload: {
      messages: [{ role: 'user', content: 'Liste' }],
      workspaceRoot: '/tmp/weyouze-project',
    },
  });

  assert.equal(result.content, 'done');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, 'test-model');
  assert.equal(calls[0].config.apiKey, 'sk-test');
  assert.equal(calls[1].messages.find((m) => m.role === 'tool').tool_call_id, 'call_1');
  assert.equal(result.rawExchanges, undefined);
});
