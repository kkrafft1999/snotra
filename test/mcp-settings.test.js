'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMcpSettings } = require('../src/main/services/mcp-settings');
const { MASK_TEXT } = require('../src/shared/runtime/sensitive-content');

const SECRET = 'ghp_mcp_token_1234567';

function setup({
  runtimeServers = async () => [{ id: 'gh' }],
  connect = async () => null,
  savedServers = [{ id: 'gh' }],
  updateUIPrefs = async () => ({}),
} = {}) {
  const calls = { setServers: [], connect: [] };
  const mcpService = {
    setServers: (servers) => calls.setServers.push(servers),
    connect: async (id) => {
      calls.connect.push(id);
      return connect(id);
    },
    describeConnections: () => [{ id: 'gh', state: 'error', error: `failed with ${SECRET}`, stderr: '' }],
  };
  const settings = createMcpSettings({
    mcpService,
    mcpAdapter: { describeSkippedTools: () => ['skipped'] },
    mcpConfigStore: {
      readMcpServers: async () => savedServers,
      saveMcpServer: async (input) => ({ saved: input }),
      deleteMcpServer: async (id) => ({ deleted: id }),
      clearMcpServerDisabledTools: async () => {},
    },
    mcpSecrets: { getMcpServersForRuntime: runtimeServers },
    ownSecrets: { readMcpSecrets: async () => [SECRET] },
    uiPrefsStore: { updateUIPrefs },
    log: { warn() {}, info() {} },
  });
  return { settings, calls };
}

test('reload hands the decrypted servers to the service', async () => {
  const { settings, calls } = setup();
  await settings.reload();
  assert.deepEqual(calls.setServers, [[{ id: 'gh' }]]);
  assert.equal(settings.hasLoadFailed(), false);
});

test('a failed reload is remembered until one gets through (#1002)', async () => {
  let fail = true;
  const { settings, calls } = setup({
    runtimeServers: async () => {
      if (fail) throw new Error('cannot decrypt');
      return [];
    },
  });
  await assert.rejects(settings.reload(), /cannot decrypt/);
  assert.equal(settings.hasLoadFailed(), true);
  assert.deepEqual(calls.setServers, [], 'the service keeps what it had');

  fail = false;
  await settings.reload();
  assert.equal(settings.hasLoadFailed(), false);
});

test('the test reloads the saved servers first, then connects the one asked for, masked', async () => {
  const { settings, calls } = setup({
    connect: async (id) => ({ id, state: 'error', error: `env TOKEN=${SECRET}`, stderr: SECRET, toolNames: ['a', 'b'] }),
  });

  const result = await settings.test('gh');

  assert.equal(calls.setServers.length, 1, 'tested is what is saved, not what the window sent');
  assert.deepEqual(calls.connect, ['gh']);
  assert.equal(result.status.error, `env TOKEN=${MASK_TEXT}`);
  assert.equal(result.status.stderr, MASK_TEXT);
  assert.deepEqual(result.tools, ['a', 'b']);
});

test('the test of a server the service does not know names it', async () => {
  const { settings } = setup();
  const result = await settings.test('nope');
  assert.equal(result.status, null);
  assert.equal(result.error.key, 'settings.error.mcp.unknownServer');
  assert.deepEqual(result.error.params, { id: 'nope' });
});

test('the connections go out masked', async () => {
  const { settings } = setup();
  const [status] = await settings.describeConnections();
  assert.equal(status.error, `failed with ${MASK_TEXT}`);
});

test('the store and the adapter are passed through', async () => {
  const { settings } = setup();
  assert.deepEqual(await settings.listServers(), [{ id: 'gh' }]);
  assert.deepEqual(await settings.save({ id: 'x' }), { saved: { id: 'x' } });
  assert.deepEqual(await settings.remove('x'), { deleted: 'x' });
  assert.deepEqual(settings.describeSkippedTools(), ['skipped']);
});

test('start moves the tools deselected per server to the one switch, then takes the servers over (#449)', async () => {
  let prefs = { disabledTools: [] };
  const { settings, calls } = setup({
    savedServers: [{ id: 'gh', disabledTools: ['create_issue'] }],
    updateUIPrefs: async (update) => {
      prefs = update(prefs);
    },
  });
  await settings.start();
  assert.equal(prefs.disabledTools.length, 1);
  assert.equal(calls.setServers.length, 1);
});

test('start takes the saved servers over even when that move fails', async () => {
  const { settings, calls } = setup({
    savedServers: [{ id: 'gh', disabledTools: ['create_issue'] }],
    updateUIPrefs: async () => {
      throw new Error('read-only');
    },
  });
  await settings.start();
  assert.equal(calls.setServers.length, 1);
});
