'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerSkillSuggestionHandlers } = require('../src/main/ipc/skill-suggestion-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { SKILL_SUGGESTION_MODES } = require('../src/shared/contracts/enums');
const { createMockIpcMain } = require('./helpers/mock-ipc');

function setup({ mode = SKILL_SUGGESTION_MODES.MODEL, suggest = async () => ({ name: 'pdf' }) } = {}) {
  const ipcMain = createMockIpcMain();
  const asked = [];
  registerSkillSuggestionHandlers({
    ipcMain,
    REQ,
    uiPrefsStore: { readUIPrefs: async () => ({ skillSuggestionMode: mode }) },
    skillSuggestionService: { suggest: async (text) => { asked.push(text); return suggest(text); } },
  });
  return { ipcMain, asked };
}

test('in the model mode the suggestion comes from the service', async () => {
  const { ipcMain, asked } = setup();
  assert.deepEqual(await ipcMain.invoke(REQ.SKILLS_SUGGEST, 'make a pdf'), { name: 'pdf' });
  assert.deepEqual(asked, ['make a pdf']);
});

test('outside the model mode the provider is never asked, whatever the renderer sends', async () => {
  const { ipcMain, asked } = setup({ mode: SKILL_SUGGESTION_MODES.LEXICAL });
  assert.deepEqual(await ipcMain.invoke(REQ.SKILLS_SUGGEST, 'make a pdf'), { name: '' });
  assert.deepEqual(asked, []);
});

test('a failure or no match ends as "no suggestion"', async () => {
  const failing = setup({ suggest: async () => { throw new Error('provider down'); } });
  assert.deepEqual(await failing.ipcMain.invoke(REQ.SKILLS_SUGGEST, 'x'), { name: '' });
  const empty = setup({ suggest: async () => null });
  assert.deepEqual(await empty.ipcMain.invoke(REQ.SKILLS_SUGGEST, 'x'), { name: '' });
});

test('anything but text reaches the service as an empty string', async () => {
  const { ipcMain, asked } = setup();
  await ipcMain.invoke(REQ.SKILLS_SUGGEST, { not: 'text' });
  assert.deepEqual(asked, ['']);
});
