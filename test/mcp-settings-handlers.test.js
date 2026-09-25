// IPC-Kanäle für die MCP-Konfiguration (Issue #108).
//
// Zwei Teile: erst die Kanäle gegen eine Attrappe, dann ein echter Durchstich
// durch die Composition mit einem Server, der beim Scheitern seinen Token auf
// stderr ausgibt. Der zweite Teil ist der eigentliche Beweis für den
// DoD-Punkt „Secret-Werte erscheinen in keiner Fehlermeldung".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const { registerSettingsHandlers } = require('../src/main/ipc/settings-handlers');
const { createApplication } = require('../src/main/composition/create-application');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');
const { MCP_CONNECTION_STATES } = require('../src/shared/contracts/mcp');

const TOKEN = 'ghp_streng_geheim_1234567890';
const FAKE_SERVER = path.join(__dirname, 'helpers', 'fake-mcp-server.js');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf) => {
      const text = buf.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('fremder Schlüssel');
      return text.slice(4);
    },
  };
}

// --- Teil 1: die Kanäle ---

function makeHandlers(mcpSettings) {
  const ipcMain = createMockIpcMain();
  registerSettingsHandlers({
    ipcMain,
    safeStorage: { isEncryptionAvailable: () => true },
    llmConfigStore: {},
    uiPrefsStore: { readUIPrefs: async () => ({}) },
    workspaceFolderStore: {},
    providerCatalog: {},
    providerModels: {},
    REQ,
    presentation: { buildLlmStateDto: () => ({}) },
    toolCatalog: { listCatalog: () => [] },
    mcpSettings,
  });
  return ipcMain;
}

function fakeMcpSettings(overrides = {}) {
  const calls = [];
  return {
    calls,
    listServers: async () => [{ id: 'github', label: 'GitHub', env: [{ key: 'T', secret: true, hasValue: true }] }],
    describeConnections: () => [{ serverId: 'github', state: MCP_CONNECTION_STATES.READY, toolCount: 2 }],
    describeSkippedTools: () => [],
    save: async (input) => { calls.push(['save', input]); return { ok: true, errors: [] }; },
    remove: async (id) => { calls.push(['remove', id]); return { ok: true, errors: [] }; },
    reload: async () => { calls.push(['reload']); },
    test: async (id) => { calls.push(['test', id]); return { status: { serverId: id, state: 'ready' }, tools: ['echo'] }; },
    ...overrides,
  };
}

test('der Katalog liefert Server, Verbindungen und ausgelassene Tools', async () => {
  const ipcMain = makeHandlers(fakeMcpSettings());
  const result = await ipcMain.handlers.get(REQ.SETTINGS_GET_MCP_CATALOG)({});
  assert.deepEqual(result.servers.map((s) => s.id), ['github']);
  assert.equal(result.connections[0].toolCount, 2);
  assert.deepEqual(result.skippedTools, []);
});

test('Speichern übernimmt die Änderung sofort in den laufenden Dienst', async () => {
  const settings = fakeMcpSettings();
  const ipcMain = makeHandlers(settings);
  const result = await ipcMain.handlers.get(REQ.SETTINGS_SAVE_MCP_SERVER)({}, { id: 'github', command: 'npx' });

  assert.equal(result.ok, true);
  assert.deepEqual(settings.calls.map((c) => c[0]), ['save', 'reload']);
  // Der frische Katalog kommt gleich mit — die Oberfläche muss nicht nachfragen.
  assert.ok(Array.isArray(result.servers));
});

test('ein abgelehntes Speichern meldet die Gründe und lädt nicht neu', async () => {
  const settings = fakeMcpSettings({ save: async () => ({ ok: false, errors: ['Es fehlt das Kommando.'] }) });
  const ipcMain = makeHandlers(settings);
  const result = await ipcMain.handlers.get(REQ.SETTINGS_SAVE_MCP_SERVER)({}, { id: 'x' });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['Es fehlt das Kommando.']);
  assert.equal(settings.calls.some((c) => c[0] === 'reload'), false);
});

test('Löschen und Neuladen übernehmen ebenfalls sofort', async () => {
  const settings = fakeMcpSettings();
  const ipcMain = makeHandlers(settings);

  assert.equal((await ipcMain.handlers.get(REQ.SETTINGS_DELETE_MCP_SERVER)({}, 'github')).ok, true);
  assert.equal((await ipcMain.handlers.get(REQ.SETTINGS_RELOAD_MCP_SERVERS)({})).ok, true);
  assert.deepEqual(settings.calls.map((c) => c[0]), ['remove', 'reload', 'reload']);
});

test('der Verbindungstest liefert Status und Tool-Liste', async () => {
  const ipcMain = makeHandlers(fakeMcpSettings());
  const result = await ipcMain.handlers.get(REQ.SETTINGS_TEST_MCP_SERVER)({}, 'github');
  assert.equal(result.ok, true);
  assert.equal(result.status.state, 'ready');
  assert.deepEqual(result.tools, ['echo']);
});

test('der Verbindungstest ohne Kennung scheitert verständlich', async () => {
  const ipcMain = makeHandlers(fakeMcpSettings());
  const result = await ipcMain.handlers.get(REQ.SETTINGS_TEST_MCP_SERVER)({}, '  ');
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, { key: 'settings.error.mcp.idMissing' });
});

test('ohne MCP-Einrichtung antworten die Kanäle statt zu werfen', async () => {
  const ipcMain = makeHandlers(null);
  assert.deepEqual(await ipcMain.handlers.get(REQ.SETTINGS_GET_MCP_CATALOG)({}), {
    servers: [], connections: [], skippedTools: [],
  });
  assert.equal((await ipcMain.handlers.get(REQ.SETTINGS_SAVE_MCP_SERVER)({}, {})).ok, false);
});

// --- Teil 2: Durchstich durch die Composition ---

async function makeApp(t) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-mcp-app-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const ipcMain = createMockIpcMain();
  const app = createApplication({
    app: { getPath: () => tmpDir, getVersion: () => '9.9.9' },
    ipcMain,
    dialog: {},
    safeStorage: fakeSafeStorage(),
    fs,
    path,
    childProcess,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    providersModule: {
      getProvider: () => null,
      listProviderMeta: () => [],
      disposeAll: () => {},
    },
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
  t.after(() => app.dispose());
  return { app, ipcMain, tmpDir };
}

test('ein Server wird gespeichert, neu geladen und getestet — ohne App-Neustart', async (t) => {
  const { ipcMain } = await makeApp(t);

  const saved = await ipcMain.handlers.get(REQ.SETTINGS_SAVE_MCP_SERVER)({}, {
    id: 'fake',
    label: 'Fake',
    command: process.execPath,
    args: [FAKE_SERVER, 'ok'],
    env: { GITHUB_TOKEN: { value: TOKEN } },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));

  const result = await ipcMain.handlers.get(REQ.SETTINGS_TEST_MCP_SERVER)({}, 'fake');
  assert.equal(result.ok, true);
  assert.equal(result.status.state, MCP_CONNECTION_STATES.READY);
  assert.deepEqual(result.tools, ['echo', 'add']);
});

test('der Token taucht weder im Katalog noch in einer Fehlermeldung auf', async (t) => {
  const { ipcMain } = await makeApp(t);

  // Ein Server, der beim Scheitern seine Umgebung auf stderr ausgibt.
  await ipcMain.handlers.get(REQ.SETTINGS_SAVE_MCP_SERVER)({}, {
    id: 'leck',
    label: 'Leck',
    command: process.execPath,
    args: [FAKE_SERVER, 'leak-env'],
    env: { GITHUB_TOKEN: { value: TOKEN } },
  });

  const katalog = await ipcMain.handlers.get(REQ.SETTINGS_GET_MCP_CATALOG)({});
  assert.equal(JSON.stringify(katalog).includes(TOKEN), false, 'der Katalog darf den Token nicht enthalten');

  const test1 = await ipcMain.handlers.get(REQ.SETTINGS_TEST_MCP_SERVER)({}, 'leck');
  assert.equal(test1.status.state, MCP_CONNECTION_STATES.FAILED);
  // Der stderr-Auszug bleibt erklärend erhalten …
  assert.match(test1.status.stderr, /Start fehlgeschlagen/);
  // … nur der Token ist heraus.
  assert.equal(JSON.stringify(test1).includes(TOKEN), false, 'der Token darf nicht im Testergebnis stehen');
  assert.match(test1.status.stderr, /\[maskiert\]/);
});

test('a token inside a keyed status error is masked as well (#338)', async (t) => {
  const { ipcMain } = await makeApp(t);
  await ipcMain.handlers.get(REQ.SETTINGS_SAVE_MCP_SERVER)({}, {
    id: 'leck',
    label: 'Leck',
    command: process.execPath,
    args: [FAKE_SERVER, 'leak-init'],
    env: { GITHUB_TOKEN: { value: TOKEN } },
  });

  const result = await ipcMain.handlers.get(REQ.SETTINGS_TEST_MCP_SERVER)({}, 'leck');
  assert.equal(result.status.state, MCP_CONNECTION_STATES.FAILED);
  // The server's text travels as a parameter of the catalogue message …
  assert.equal(result.status.error.key, 'mcp.transport.serverErrorCode');
  assert.match(result.status.error.params.detail, /^bad credentials: GITHUB_TOKEN=\[maskiert\]$/);
  // … and the token is nowhere in the result.
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('die gespeicherte Konfiguration übersteht einen Neustart der Anwendung', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-mcp-restart-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const build = () => {
    const ipcMain = createMockIpcMain();
    const app = createApplication({
      app: { getPath: () => tmpDir, getVersion: () => '9.9.9' },
      ipcMain,
      dialog: {},
      safeStorage: fakeSafeStorage(),
      fs,
      path,
      childProcess,
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      providersModule: { getProvider: () => null, listProviderMeta: () => [], disposeAll: () => {} },
      workspaceState: { getActiveWorkspaceRoot: () => null, setActiveWorkspaceRoot: () => {} },
      getMainWindow: () => null,
      REQ,
      PUSH,
      LIMITS: {
        MAX_CHAT_SESSIONS: 5, MAX_FOLDER_HISTORY: 3, MAX_READ_FILE_BYTES: 1024,
        MAX_WRITE_FILE_BYTES: 1024, MAX_TOOL_ROUNDS: 3,
      },
      defaultProviderId: 'openai',
    });
    return { app, ipcMain };
  };

  const erste = build();
  await erste.ipcMain.handlers.get(REQ.SETTINGS_SAVE_MCP_SERVER)({}, {
    id: 'fake',
    label: 'Fake',
    command: process.execPath,
    args: [FAKE_SERVER, 'ok'],
    env: { GITHUB_TOKEN: { value: TOKEN } },
  });
  erste.app.dispose();

  // Neue Instanz auf demselben userData — wie ein App-Neustart.
  const zweite = build();
  t.after(() => zweite.app.dispose());
  await zweite.app.initToolRuntimes();

  const katalog = await zweite.ipcMain.handlers.get(REQ.SETTINGS_GET_MCP_CATALOG)({});
  assert.deepEqual(katalog.servers.map((s) => s.id), ['fake']);
  assert.deepEqual(katalog.servers[0].env, [{ key: 'GITHUB_TOKEN', secret: true, hasValue: true }]);

  // Und der Server ist wirklich benutzbar, der Token also korrekt entschlüsselt.
  const result = await zweite.ipcMain.handlers.get(REQ.SETTINGS_TEST_MCP_SERVER)({}, 'fake');
  assert.equal(result.status.state, MCP_CONNECTION_STATES.READY);
});
