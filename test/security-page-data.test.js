'use strict';

// What main reads for Settings › Security and the mode pill (#357, #447,
// #448). Moved out of the composition root with #508.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecurityPageData } = require('../src/main/services/security-page-data');

const SESSIONS = [
  { id: 'a', title: '  First chat ', workspaceRoot: '/ws', toolPermissionMode: 'auto' },
  { id: 'b', title: '', workspaceRoot: '/ws' },
  { id: 'c', title: 'Elsewhere', workspaceRoot: '/other', toolPermissionMode: 'ask' },
  null,
];

function makeData(overrides = {}) {
  const detections = [];
  const notified = [];
  const data = createSecurityPageData({
    chatHistoryStore: {
      readChatHistoryStore: async () => ({ sessions: SESSIONS }),
      normalizeWorkspaceRoot: (root) => root,
      sessionMatchesWorkspace: (session, root) => session.workspaceRoot === root,
    },
    uiPrefsStore: { readUIPrefs: async () => ({ disabledTools: ['read_file', 'shell_execute'], appLocale: 'en' }) },
    toolRegistry: {
      listRiskCatalog: () => [
        { name: 'read_file', riskClasses: ['read'] },
        { name: 'write_file', riskClasses: ['write'] },
      ],
    },
    mcpConfigStore: {
      readMcpServers: async () => [{ id: 'gh', label: 'GitHub', enabled: true, knownTools: ['issues'] }],
    },
    pythonRunner: { isAvailable: () => true },
    shellRunner: { isAvailable: () => true },
    sandboxService: {
      describe: () => ({ status: 'unknown' }),
      detect: async () => { detections.push(true); return { status: 'ready' }; },
    },
    onSandboxDetected: () => notified.push(true),
    ...overrides,
  });
  return { data, detections, notified };
}

test('describeChats gives the trimmed titles of the chats asked for', async () => {
  const { data } = makeData();
  const titles = await data.describeChats(['a', 'b', 'missing']);
  assert.deepEqual([...titles], [['a', 'First chat']]);
  assert.equal((await data.describeChats([])).size, 0);
});

test('describeWorkspaceChats lists the chats of one folder with their stored mode', async () => {
  const { data } = makeData();
  assert.deepEqual(await data.describeWorkspaceChats('/ws'), [
    { id: 'a', title: 'First chat', mode: 'auto' },
    { id: 'b', title: '', mode: null },
  ]);
});

test('describeTools marks what Settings › Tools switched off and adds remembered MCP tools (#464)', async () => {
  const { data } = makeData();
  const tools = await data.describeTools();
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.read_file.disabled, true);
  assert.equal(byName.write_file.disabled, false);
  const remembered = tools.find((tool) => tool.name !== 'read_file' && tool.name !== 'write_file');
  assert.ok(remembered, 'the remembered MCP tool is listed');
  assert.equal(remembered.disabled, false);
});

test('describeTools does without MCP servers when their file cannot be read', async () => {
  const { data } = makeData({ mcpConfigStore: { readMcpServers: async () => { throw new Error('unreadable'); } } });
  assert.deepEqual((await data.describeTools()).map((tool) => tool.name), ['read_file', 'write_file']);
});

test('describeExecutionTools leaves out a switched-off tool and starts the sandbox detection without waiting', async () => {
  const { data, detections, notified } = makeData();
  const result = await data.describeExecutionTools();
  assert.deepEqual(result, { active: ['run_python'], sandbox: { status: 'unknown' } });
  assert.equal(detections.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notified.length, 1, 'the renderer is told to read again');
});

test('describeExecutionTools detects nothing when no execution tool is offered', async () => {
  const { data, detections } = makeData({
    pythonRunner: { isAvailable: () => false },
    shellRunner: { isAvailable: () => false },
  });
  assert.deepEqual((await data.describeExecutionTools()).active, []);
  assert.equal(detections.length, 0);
});
