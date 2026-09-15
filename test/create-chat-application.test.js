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
      workspaceRoot: '/tmp/snotra-project',
    },
  });

  assert.equal(result.content, 'done');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, 'test-model');
  assert.equal(calls[0].config.apiKey, 'sk-test');
  assert.equal(calls[1].messages.find((m) => m.role === 'tool').tool_call_id, 'call_1');
  assert.equal(result.rawExchanges, undefined);
});

test('createChatApplication reicht die eingeschalteten Skills bis in den Systemprompt', async () => {
  const calls = [];
  const skillQueries = [];
  const provider = {
    id: 'test',
    name: 'Test',
    defaultModel: 'test-model',
    fields: {},
    async streamChatRound(args) {
      calls.push(args);
      return assistantText('ok');
    },
  };

  const { engine } = createChatApplication({
    llmConfigStore: {
      readLLMConfig: async () => ({}),
      resolveChatModelTarget: () => ({ providerId: 'test', model: 'test-model' }),
    },
    providerRuntime: { getProvider: () => provider },
    providerSecrets: {
      getEffectiveProviderConfig: async () => ({ apiKey: 'sk-test', model: 'test-model' }),
    },
    uiPrefsStore: { readUIPrefs: async () => ({ activeSkills: ['snotra-capabilities'] }) },
    toolRegistry: {
      getTools: () => [],
      buildSystemPrompt: () => '',
      execute: async () => '{}',
    },
    skillsService: {
      async getActiveSkills(options) {
        skillQueries.push(options);
        return [
          {
            name: 'snotra-capabilities',
            description: 'Auskunft über die App',
            source: 'system',
            path: '/app/system-skills/snotra-capabilities',
            body: 'Snotra hat keine Shell.',
          },
        ];
      },
    },
    path,
    maxToolRounds: 2,
  });

  await engine.send({
    sessionId: 's-1',
    payload: { messages: [{ role: 'user', content: 'Was kannst du?' }] },
  });

  assert.deepEqual(skillQueries, [
    { workspaceRoot: null, activeSkills: ['snotra-capabilities'], invokedSkills: [] },
  ]);
  const system = calls[0].messages.find((m) => m.role === 'system');
  assert.match(system.content, /## Skill: snotra-capabilities/);
  assert.match(system.content, /keine Shell/);

  // Ein „/name“ in der Nutzernachricht reist als Aufruf mit (Issue #124),
  // eines in einer Assistenz-Antwort dagegen nicht.
  await engine.send({
    sessionId: 's-2',
    payload: {
      messages: [
        { role: 'user', content: 'Bitte /release vorbereiten' },
        { role: 'assistant', content: 'Soll ich /install auch anwerfen?' },
        { role: 'user', content: 'ja' },
      ],
    },
  });
  assert.deepEqual(skillQueries[1].invokedSkills, ['release']);
});

test('createChatApplication kommt ohne Skill-Service aus', async () => {
  const { engine, skills } = createChatApplication({
    llmConfigStore: {
      readLLMConfig: async () => ({}),
      resolveChatModelTarget: () => ({ providerId: 'test', model: 'test-model' }),
    },
    providerRuntime: {
      getProvider: () => ({
        id: 'test',
        fields: {},
        async streamChatRound() {
          return assistantText('ok');
        },
      }),
    },
    providerSecrets: { getEffectiveProviderConfig: async () => ({ apiKey: 'k', model: 'm' }) },
    uiPrefsStore: { readUIPrefs: async () => ({}) },
    toolRegistry: { getTools: () => [], buildSystemPrompt: () => '', execute: async () => '{}' },
    path,
    maxToolRounds: 2,
  });

  assert.equal(skills, null);
  const result = await engine.send({
    sessionId: 's-2',
    payload: { messages: [{ role: 'user', content: 'Hi' }] },
  });
  assert.equal(result.content, 'ok');
});

/* ── Umgebungsangaben im Systemprompt (Issue #138) ───────────────────────── */

function environmentHarness({ uiPrefs = {}, environment } = {}) {
  const calls = [];
  const engine = createChatApplication({
    llmConfigStore: {
      readLLMConfig: async () => ({}),
      resolveChatModelTarget: () => ({ providerId: 'test', model: 'test-model' }),
    },
    providerRuntime: {
      getProvider: () => ({
        id: 'test',
        fields: {},
        async streamChatRound(args) {
          calls.push(args);
          return assistantText('ok');
        },
      }),
    },
    providerSecrets: { getEffectiveProviderConfig: async () => ({ apiKey: 'k', model: 'm' }) },
    uiPrefsStore: { readUIPrefs: async () => uiPrefs },
    toolRegistry: { getTools: () => [], buildSystemPrompt: () => '', execute: async () => '{}' },
    environment,
    path,
    maxToolRounds: 2,
  }).engine;
  return { engine, calls, system: () => calls[0].messages.find((m) => m.role === 'system')?.content || '' };
}

const FIXED_ENVIRONMENT = {
  async describe({ workspaceRoot }) {
    return {
      appName: 'Snotra AI',
      appVersion: '1.5.3',
      workspaceRoot,
      isGitRepository: true,
      platform: 'darwin',
      osVersion: 'Darwin 27.0.0',
      shell: 'zsh',
      now: new Date(2026, 8, 15, 9, 0),
    };
  },
};

test('Umgebungsangaben stehen im Systemprompt und kennen den offenen Ordner', async () => {
  const seen = [];
  const { engine, system } = environmentHarness({
    environment: {
      describe: async (options) => {
        seen.push(options);
        return FIXED_ENVIRONMENT.describe(options);
      },
    },
  });
  await engine.send({
    sessionId: 'env-1',
    payload: { messages: [{ role: 'user', content: 'hi' }], workspaceRoot: '/tmp/snotra-project' },
  });
  assert.deepEqual(seen, [{ workspaceRoot: path.resolve('/tmp/snotra-project') }]);
  assert.match(system(), /Umgebung, in der du gerade läufst \(Snotra AI 1\.5\.3\):/);
  assert.match(system(), /- Arbeitsverzeichnis: /);
  assert.match(system(), /- Plattform: darwin \(macOS\)/);
  assert.match(system(), /- Heutiges Datum: Dienstag, 2026-09-15/);
  // Der Ordnerkontext bleibt daneben bestehen — er nennt den Ordner im Satz.
  assert.match(system(), /geöffneten Ordner/);
});

test('der Schalter „Umgebungsinformationen" schaltet den Block ab', async () => {
  let asked = false;
  const { engine, system } = environmentHarness({
    uiPrefs: { environmentInfoEnabled: false },
    environment: {
      describe: async (options) => {
        asked = true;
        return FIXED_ENVIRONMENT.describe(options);
      },
    },
  });
  await engine.send({
    sessionId: 'env-2',
    payload: { messages: [{ role: 'user', content: 'hi' }], workspaceRoot: '/tmp/snotra-project' },
  });
  assert.equal(asked, false, 'abgeschaltet wird gar nicht erst gefragt');
  assert.ok(!system().includes('Umgebung, in der du gerade läufst'));
  assert.match(system(), /geöffneten Ordner/);
});

test('ohne Environment-Port und bei einer werfenden Quelle läuft der Chat weiter', async () => {
  for (const environment of [null, { describe: async () => { throw new Error('kaputt'); } }]) {
    const { engine, system } = environmentHarness({ environment });
    const result = await engine.send({
      sessionId: 'env-3',
      payload: { messages: [{ role: 'user', content: 'hi' }], workspaceRoot: '/tmp/snotra-project' },
    });
    assert.equal(result.content, 'ok');
    assert.ok(!system().includes('Umgebung, in der du gerade läufst'));
  }
});
