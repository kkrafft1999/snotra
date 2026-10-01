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

function makeApplication(t, { getMainWindow, updates, env = {} } = {}) {
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
      env,
    });

    return { app, ipcMain, disposed };
  };
}

test('createApplication exposes lifecycle API only', async (t) => {
  const build = await makeApplication(t)();
  const { app } = build;

  assert.deepEqual(
    Object.keys(app).sort(),
    ['dispose', 'getAppLocale', 'getShowHiddenFiles', 'getValidatedLastFolder', 'initToolRuntimes', 'runUpdateCheck'].sort(),
  );
  assert.equal(typeof app.runUpdateCheck, 'function');
  assert.equal(typeof app.dispose, 'function');
  assert.equal(typeof app.getValidatedLastFolder, 'function');
  // Sucht beim Start den Python-Interpreter und uebernimmt den Stand der
  // Tool-Einstellungen (Issues #63, #86).
  assert.equal(typeof app.initToolRuntimes, 'function');
});

test('createApplication registers IPC handlers and disposes provider runtime', async (t) => {
  const build = await makeApplication(t)();
  const { app, ipcMain, disposed } = build;

  assert.ok(ipcMain.handlers.has(REQ.SETTINGS_GET_UI_PREFS));
  assert.ok(ipcMain.handlers.has(REQ.SETTINGS_REMOVE_FOLDER_FROM_HISTORY));
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

// The flow itself is tested in update-check.test.js; this checks the wiring.
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

test('createApplication wires the skill catalog channels', async (t) => {
  const { ipcMain } = await makeApplication(t)();

  // Ohne app.getAppPath() (Test-Fake) gibt es keine System-Skills, der Kanal
  // muss trotzdem antworten statt zu fehlen.
  const catalog = await ipcMain.invoke(REQ.SETTINGS_GET_SKILL_CATALOG, null);
  assert.ok(Array.isArray(catalog.skills));
  const reloaded = await ipcMain.invoke(REQ.SETTINGS_RELOAD_SKILLS, null);
  assert.ok(Array.isArray(reloaded.skills));
});

test('a folder switch drops the cached skill scans, so a folder that comes back is read afresh (#578)', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-app-rescan-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const a = path.join(tmpDir, 'a');
  const b = path.join(tmpDir, 'b');
  const skillDir = path.join(a, '.agents', 'skills', 'gone-soon');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(b);
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: gone-soon\ndescription: d\n---\nbody\n');

  let root = null;
  let next = null;
  const ipcMain = createMockIpcMain();
  createApplication({
    app: { getPath: () => tmpDir, getVersion: () => '9.9.9', getAppPath: () => path.join(tmpDir, 'no-app') },
    ipcMain,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [next] }) },
    safeStorage: { isEncryptionAvailable: () => false },
    fs,
    path,
    os: { homedir: () => path.join(tmpDir, 'no-home') },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    providersModule: makeProvidersModule({ called: false }),
    workspaceState: { getActiveWorkspaceRoot: () => root, setActiveWorkspaceRoot: (value) => { root = value; } },
    getMainWindow: () => null,
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
  });
  const open = async (folder) => {
    next = folder;
    await ipcMain.invoke(REQ.DIALOG_OPEN_FOLDER);
  };
  const names = async () => (await ipcMain.invoke(REQ.SETTINGS_GET_SKILL_CATALOG)).skills.map((s) => s.name);

  await open(a);
  assert.deepEqual(await names(), ['gone-soon']);
  await open(b);
  // Deleted while another folder is open — nothing watches `a` now.
  await fs.rm(skillDir, { recursive: true, force: true });
  await open(a);
  assert.deepEqual(await names(), []);
});

test('createApplication findet System-Skills unter app.getAppPath()/system-skills', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-app-skills-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const skillDir = path.join(tmpDir, 'system-skills', 'demo-system-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: demo-system-skill\ndescription: Test\n---\nAnweisung.\n',
    'utf8'
  );

  const ipcMain = createMockIpcMain();
  createApplication({
    app: { getPath: () => tmpDir, getVersion: () => '9.9.9', getAppPath: () => tmpDir },
    ipcMain,
    dialog: {},
    safeStorage: { isEncryptionAvailable: () => false },
    fs,
    path,
    os: { homedir: () => path.join(tmpDir, 'kein-home') },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    providersModule: makeProvidersModule({ called: false }),
    workspaceState: { getActiveWorkspaceRoot: () => null, setActiveWorkspaceRoot: () => {} },
    getMainWindow: () => null,
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
  });

  const catalog = await ipcMain.invoke(REQ.SETTINGS_GET_SKILL_CATALOG, null);
  assert.deepEqual(
    catalog.skills.map((skill) => [skill.name, skill.source, skill.status]),
    [['demo-system-skill', 'system', 'active']]
  );
});
