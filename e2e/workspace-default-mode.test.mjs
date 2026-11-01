// The default mode per workspace in the running app (#413): a pick in the mode
// pill's menu stores it in main as well (#1337), a new chat starts with it,
// and it is still there after a restart — with "Auto" as the default, "Auto"
// itself survives the restart.
//
// "Auto" needs safeStorage. Without it (a Linux runner without a keyring,
// say) "Auto" is not offered, and the restart is checked with "Always ask",
// which the fail-safe keeps (#419).

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const pillMode = (page) => page.evaluate(() => document.getElementById('chat-tool-mode-wrap').dataset.mode);
const state = (page) => page.evaluate(() => window.electronAPI.getToolPermissionState());

async function confirmDialogs(app) {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
  });
}

async function waitForTree(page) {
  await poll(async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
    { what: 'drawn tree' });
}

test('workspace default mode: picked in the menu, used by a new chat, kept across a restart', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-ws-mode-');
  const userDataDir = await makeTempDir('snotra-ws-mode-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

  let snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  let { page } = snotra;
  await confirmDialogs(snotra.app);
  await waitForTree(page);
  await poll(async () => (await state(page))?.workspaceRoot, { what: 'permission state with a workspace' });

  const tagOn = () => page.evaluate(() => [...document.querySelectorAll('.chat-tool-mode-default-tag')]
    .map((tag) => tag.closest('.chat-tool-mode-option').dataset.mode));
  const pick = async (mode) => {
    if (!(await page.evaluate(() => !document.getElementById('chat-tool-mode-menu').classList.contains('hidden')))) {
      await page.click('#btn-chat-tool-mode');
    }
    await page.click(`.chat-tool-mode-option[data-mode="${mode}"]`);
    await poll(async () => (await pillMode(page)) === mode, { what: `chat at "${mode}"` });
  };

  // A folder that never had a pick: "Smart", tagged as its default.
  assert.equal(await pillMode(page), 'smart');
  assert.equal((await state(page)).workspaceMode, 'smart');
  await page.click('#btn-chat-tool-mode');
  assert.deepEqual(await tagOn(), ['smart']);
  await page.keyboard.press('Escape');

  // The chat switches to "Always ask" from the menu, and the folder with it.
  // Through the menu, not the bare API: the menu waits for the start-up's chat
  // switch, which would otherwise put the chat back at the folder's "Smart" a
  // moment later (#564).
  await pick('ask-all');
  await poll(async () => (await state(page)).workspaceMode === 'ask-all', { what: 'default stored in main' })
    .catch(async (error) => {
      // What the menu said about it, so that a failure explains itself.
      const status = await page.evaluate(() => document.getElementById('chat-tool-mode-status').textContent);
      throw new Error(`${error.message} — menu status: ${JSON.stringify(status)}`);
    });
  assert.equal(await page.evaluate(() => document.getElementById('chat-tool-mode-status').textContent),
    `Permission mode: Always ask, also for new chats in ${path.basename(workspace)}`);
  await page.click('#btn-chat-tool-mode');
  assert.deepEqual(await tagOn(), ['ask-all']);
  await page.keyboard.press('Escape');

  // A new chat starts with the folder's default.
  await page.evaluate(() => document.getElementById('btn-chat-new').click());
  await poll(async () => (await pillMode(page)) === 'ask-all', { what: 'new chat at the default' });

  // With encrypted storage, "Auto" picked in the chat is the default too — and
  // the next start keeps it.
  let expected = 'ask-all';
  if ((await state(page)).platformCapabilities?.secureStorage === true) {
    await pick('auto');
    await poll(async () => (await state(page)).workspaceMode === 'auto', { what: '"Auto" as the default' });
    expected = 'auto';
  } else {
    t.diagnostic('no encrypted storage here: the restart is checked with "Always ask"');
  }

  await snotra.stop();
  snotra = await launchApp({ userDataDir });
  page = snotra.page;
  await waitForTree(page);
  await poll(async () => (await state(page))?.workspaceMode === expected, { what: 'default after the restart' });
  await poll(async () => (await pillMode(page)) === expected, { what: `chat at "${expected}" after the restart` });
});
