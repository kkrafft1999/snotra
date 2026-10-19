'use strict';

// The core runs under plain Node (#983, AR-08): `createCore()` gets ports and
// plain values — no `app`, no `safeStorage`, no `ipcMain`, no window — and a
// chat turn with a tool call goes through it. This is what a second host, a
// CLI or a headless server, would build on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { createCore } = require('../src/main/composition/create-core');
const { PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const { removeTempDir } = require('./helpers/temp-dir');

const LIMITS = {
  MAX_CHAT_SESSIONS: 5,
  MAX_FOLDER_HISTORY: 3,
  MAX_READ_FILE_BYTES: 64 * 1024,
  MAX_WRITE_FILE_BYTES: 64 * 1024,
  MAX_TOOL_ROUNDS: 3,
};

/** A local provider that needs no key: first it lists the folder, then it answers. */
function scriptedProviders() {
  const rounds = [];
  const provider = {
    id: 'local',
    name: 'Local',
    defaultModel: 'm',
    fields: {},
    presentation: {},
    async streamChatRound({ messages, tools }) {
      rounds.push({ messages, tools });
      if (rounds.length === 1) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'list_directory', arguments: '{"relative_path":"."}' } }],
          },
          finishReason: 'tool_calls',
        };
      }
      return { message: { role: 'assistant', content: 'The folder holds notes.txt.' }, finishReason: 'stop' };
    },
    async listModels() { return { models: [] }; },
  };
  return {
    rounds,
    module: {
      getProvider: (id) => (id === 'local' ? provider : null),
      listProviderMeta: () => [{ id: 'local', name: 'Local' }],
      disposeAll() {},
    },
  };
}

/** A host without a keyring: the stores keep what they can without one. */
const NO_KEYRING = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('no keyring'); },
  decryptString: () => { throw new Error('no keyring'); },
};

async function makeCore(t) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-core-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-core-ws-'));
  t.after(() => removeTempDir(userDataPath));
  t.after(() => removeTempDir(workspace));
  await fs.writeFile(path.join(workspace, 'notes.txt'), 'hello\n');
  const pushed = [];
  const providers = scriptedProviders();
  let root = null;
  const core = createCore({
    fs,
    path,
    fetchImpl: async () => { throw new Error('no network in this test'); },
    providersModule: providers.module,
    workspaceState: { getActiveWorkspaceRoot: () => root, setActiveWorkspaceRoot: (folder) => { root = folder; } },
    PUSH,
    LIMITS,
    userDataPath,
    secretStore: NO_KEYRING,
    eventPush: { push: (channel, payload) => { pushed.push({ channel, payload }); return true; } },
    defaultProviderId: 'local',
    env: {},
  });
  t.after(() => core.dispose());
  return { core, workspace, providers, pushed };
}

test('createCore builds the application from ports and plain values, without Electron', async (t) => {
  const { core } = await makeCore(t);
  for (const name of ['chatEngine', 'toolRegistry', 'chatSessionSettings', 'skillsService', 'toolPolicyStore', 'storage']) {
    assert.ok(core[name], `${name} is built`);
  }
  const electron = `${path.sep}node_modules${path.sep}electron${path.sep}`;
  assert.deepEqual(Object.keys(require.cache).filter((file) => file.includes(electron)), [], 'nothing loaded Electron');
  // Without a confirmation adapter nothing can be loosened (#980).
  assert.equal(core.confirmations.presence, 'none');
  assert.equal(typeof (await core.toolPolicyStore.read()).mode, 'string', 'the policy store reads its file');
});

test('one chat turn with one tool call runs through the core', async (t) => {
  const { core, workspace, providers } = await makeCore(t);
  const events = [];
  const result = await core.chatEngine.send({
    sessionId: 'cli',
    payload: { messages: [{ role: 'user', content: 'What is in this folder?' }], workspaceRoot: workspace, chatId: 'chat-1' },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.content, 'The folder holds notes.txt.');
  assert.equal(providers.rounds.length, 2, 'one round with the call, one with the answer');
  assert.ok(providers.rounds[0].tools.some((tool) => tool.function?.name === 'list_directory'), 'the registry offered the tool');
  const toolMessage = providers.rounds[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage, 'the tool result went back to the model');
  assert.match(String(toolMessage.content), /notes\.txt/);
});

test('the pushes of the core go through the event-push port', async (t) => {
  const { core, pushed } = await makeCore(t);
  core.notifyToolPermissionsChanged();
  assert.deepEqual(pushed.map((entry) => entry.channel), [PUSH.TOOL_PERMISSIONS_CHANGED]);
});
