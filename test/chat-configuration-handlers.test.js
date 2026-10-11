'use strict';

// The indicator at the composer asks main for the open chat's skills and
// tools (#773). The folder is main's own; the renderer only names the skills
// its chat invoked with "/name".

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerChatConfigurationHandlers } = require('../src/main/ipc/chat-configuration-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

function setup() {
  const ipcMain = createMockIpcMain();
  const asked = [];
  registerChatConfigurationHandlers({
    ipcMain,
    REQ,
    getActiveWorkspaceRoot: () => '/project',
    chatConfiguration: { describe: async (input) => { asked.push(input); return { skills: [], tools: [] }; } },
  });
  return { ipcMain, asked };
}

test('the active folder and the invoked skills go to the service', async () => {
  const { ipcMain, asked } = setup();
  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_GET_CONFIGURATION, { invokedSkills: ['release'] }), { skills: [], tools: [] });
  assert.deepEqual(asked, [{ workspaceRoot: '/project', chatSkillNames: ['release'] }]);
});

test('a request without a list, or with something else, invokes nothing', async () => {
  const { ipcMain, asked } = setup();
  await ipcMain.invoke(REQ.CHAT_GET_CONFIGURATION);
  await ipcMain.invoke(REQ.CHAT_GET_CONFIGURATION, { invokedSkills: 'release' });
  assert.deepEqual(asked.map((input) => input.chatSkillNames), [[], []]);
});
