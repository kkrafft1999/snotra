'use strict';

// The indicator at the composer asks main for the open chat's skills and
// tools (#773). The folder is main's own; the renderer only names the skills
// its chat invoked with "/name".

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerChatConfigurationHandlers } = require('../src/main/ipc/chat-configuration-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

function setup({ getChatOverrides } = {}) {
  const ipcMain = createMockIpcMain();
  const asked = [];
  registerChatConfigurationHandlers({
    ipcMain,
    REQ,
    getActiveWorkspaceRoot: () => '/project',
    ...(getChatOverrides ? { getChatOverrides } : {}),
    chatConfiguration: { describe: async (input) => { asked.push(input); return { skills: [], tools: [] }; } },
  });
  return { ipcMain, asked };
}

test('the active folder and the invoked skills go to the service', async () => {
  const { ipcMain, asked } = setup();
  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_GET_CONFIGURATION, { invokedSkills: ['release'] }), { skills: [], tools: [] });
  assert.deepEqual(asked, [{ workspaceRoot: '/project', chatSkillNames: ['release'], overrides: null }]);
});

// What the chat on screen switched on a card (#774) is main's to know; a
// renderer that sends overrides of its own is not listened to.
test('the chat\'s own overrides come from main, never from the request', async () => {
  const overrides = { tools: { on: ['fetch_url'] } };
  const { ipcMain, asked } = setup({ getChatOverrides: async () => overrides });
  await ipcMain.invoke(REQ.CHAT_GET_CONFIGURATION, { invokedSkills: [], overrides: { tools: { on: ['shell_execute'] } } });
  assert.deepEqual(asked[0].overrides, overrides);

  const broken = setup({ getChatOverrides: async () => { throw new Error('history unreadable'); } });
  await broken.ipcMain.invoke(REQ.CHAT_GET_CONFIGURATION, {});
  assert.equal(broken.asked[0].overrides, null);
});

test('a request without a list, or with something else, invokes nothing', async () => {
  const { ipcMain, asked } = setup();
  await ipcMain.invoke(REQ.CHAT_GET_CONFIGURATION);
  await ipcMain.invoke(REQ.CHAT_GET_CONFIGURATION, { invokedSkills: 'release' });
  assert.deepEqual(asked.map((input) => input.chatSkillNames), [[], []]);
});
