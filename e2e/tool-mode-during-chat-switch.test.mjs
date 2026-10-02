// A mode chosen while a chat switch is still on its way (#564). The renderer
// shows the new chat at once; main applies that chat's stored mode a moment
// later. A choice made in between belongs to the new chat and has to survive
// the switch — before the fix, the switch put the chat back at the folder's
// default and the choice was gone without a word.
//
// The switch is slowed down in main so that the gap is wide enough to hit on
// every machine; on a slow Windows runner it opened by itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const ACTIVATE = 'chatHistory:activate';
const pillMode = (page) => page.evaluate(() => document.getElementById('chat-tool-mode-wrap').dataset.mode);

test('a mode chosen during a chat switch is the one the chat keeps', { timeout: 120000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-mode-switch-'));
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-mode-switch-userdata-'));
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  });
  const { page, app } = snotra;
  await poll(async () => (await page.evaluate(() => window.electronAPI.getToolPermissionState()))?.workspaceRoot,
    { what: 'permission state with a workspace' });

  // Every activation from here on takes a while, and main counts the finished ones.
  const slowed = await app.evaluate(({ ipcMain }, channel) => {
    // Electron keeps invoke handlers in this map; without it the test cannot slow the switch.
    const handlers = ipcMain._invokeHandlers;
    const original = handlers?.get(channel);
    if (typeof original !== 'function') return false;
    globalThis.__snotraActivationsDone = 0;
    handlers.set(channel, async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        return await original(...args);
      } finally {
        globalThis.__snotraActivationsDone += 1;
      }
    });
    return true;
  }, ACTIVATE);
  assert.equal(slowed, true, `no invoke handler for ${ACTIVATE} to slow down`);
  // The start-up's own activation may still be held up; it has to be through first.
  await poll(async () => (await pillMode(page)) === 'smart', { what: 'chat at "Smart"' });

  // A new chat: the switch is on its way while "Always ask" is chosen.
  await page.evaluate(() => document.getElementById('btn-chat-new').click());
  await page.click('#btn-chat-tool-mode');
  await page.click('.chat-tool-mode-option[data-mode="ask-all"]');
  await poll(() => app.evaluate(() => globalThis.__snotraActivationsDone >= 1), { what: 'switch finished' });

  await poll(async () => (await pillMode(page)) === 'ask-all', { what: 'chat at "Always ask"' });
  const state = await page.evaluate(() => window.electronAPI.getToolPermissionState());
  assert.equal(state.mode, 'ask-all', 'main holds the choice, not the folder default');
});
