const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createApplication } = require('../src/main/composition/create-application');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

function makeProvidersModule(disposeTracker) {
  return {
    getProvider(id) {
      if (id === 'openai') {
        return {
          id: 'openai',
          name: 'OpenAI',
          defaultModel: 'gpt-4o',
          fields: { apiKey: true },
          presentation: {},
          async streamChatRound() {
            return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
          },
          async listModels() {
            return { models: [] };
          },
        };
      }
      return null;
    },
    listProviderMeta() {
      return [{ id: 'openai', name: 'OpenAI' }];
    },
    disposeAll() {
      disposeTracker.called = true;
    },
  };
}

function makeApplication(t, { getMainWindow, updates } = {}) {
  return async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-app-'));
    t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
    const disposed = { called: false };
    const ipcMain = createMockIpcMain();
    const workspaceState = {
      getActiveWorkspaceRoot: () => null,
      setActiveWorkspaceRoot: () => {},
    };

    const app = createApplication({
      app: {
        getPath: () => tmpDir,
        getVersion: () => '9.9.9',
      },
      ipcMain,
      dialog: {},
      safeStorage: { isEncryptionAvailable: () => false },
      fs,
      path,
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      providersModule: makeProvidersModule(disposed),
      workspaceState,
      getMainWindow: getMainWindow || (() => null),
      REQ,
      PUSH,
      LIMITS: {
        MAX_CHAT_SESSIONS: 5,
        MAX_FOLDER_HISTORY: 3,
        MAX_READ_FILE_BYTES: 1024,
        MAX_WRITE_FILE_BYTES: 1024,
        MAX_TOOL_ROUNDS: 3,
      },
      defaultProviderId: 'openai',
      updates,
    });

    return { app, ipcMain, disposed };
  };
}

test('createApplication exposes lifecycle API only', async (t) => {
  const build = await makeApplication(t)();
  const { app } = build;

  assert.deepEqual(Object.keys(app).sort(), ['dispose', 'getValidatedLastFolder', 'runUpdateCheck'].sort());
  assert.equal(typeof app.runUpdateCheck, 'function');
  assert.equal(typeof app.dispose, 'function');
  assert.equal(typeof app.getValidatedLastFolder, 'function');
});

test('createApplication registers IPC handlers and disposes provider runtime', async (t) => {
  const build = await makeApplication(t)();
  const { app, ipcMain, disposed } = build;

  assert.ok(ipcMain.handlers.has(REQ.SETTINGS_GET_UI_PREFS));
  assert.ok(ipcMain.handlers.has(REQ.CHAT_HISTORY_GET));
  assert.ok(ipcMain.handlers.has(REQ.FS_READ_DIRECTORY));
  assert.ok(ipcMain.handlers.has(REQ.WHISPER_TRANSCRIBE));
  assert.ok(ipcMain.handlers.has(REQ.UPDATE_GET_VERSION));
  assert.ok(ipcMain.handlers.has(REQ.CHAT_SEND));

  const prefs = await ipcMain.invoke(REQ.SETTINGS_GET_UI_PREFS);
  assert.equal(typeof prefs, 'object');

  app.dispose();
  assert.equal(disposed.called, true);
});

test('runUpdateCheck silent mode suppresses push when no update is available', async (t) => {
  const sent = [];
  const build = await makeApplication(t, {
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    }),
    updates: {
      getCurrentVersion: () => '1.0.0',
      checkForUpdate: async () => ({
        updateAvailable: false,
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
      }),
      ignoreVersion: async () => ({ ok: true }),
    },
  })();
  const { app } = build;

  await app.runUpdateCheck({ silent: true });
  assert.equal(sent.length, 0);
});

test('runUpdateCheck silent mode pushes when an update is available', async (t) => {
  const sent = [];
  const build = await makeApplication(t, {
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    }),
    updates: {
      getCurrentVersion: () => '1.0.0',
      checkForUpdate: async () => ({
        updateAvailable: true,
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        releaseUrl: 'https://example.test/release',
      }),
      ignoreVersion: async () => ({ ok: true }),
    },
  })();
  const { app } = build;

  await app.runUpdateCheck({ silent: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, PUSH.UPDATE_AVAILABLE);
  assert.equal(sent[0].payload.manual, false);
  assert.equal(sent[0].payload.updateAvailable, true);
});

test('runUpdateCheck manual mode always pushes even when up to date', async (t) => {
  const sent = [];
  const build = await makeApplication(t, {
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    }),
    updates: {
      getCurrentVersion: () => '1.0.0',
      checkForUpdate: async () => ({
        updateAvailable: false,
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
      }),
      ignoreVersion: async () => ({ ok: true }),
    },
  })();
  const { app } = build;

  await app.runUpdateCheck({ silent: false });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, PUSH.UPDATE_AVAILABLE);
  assert.equal(sent[0].payload.manual, true);
  assert.equal(sent[0].payload.updateAvailable, false);
});
