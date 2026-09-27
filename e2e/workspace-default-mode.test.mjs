// The default mode per workspace in the running app (#413): the checkbox under
// the mode pill's menu stores the default in main, a new chat starts with it,
// and it is still there after a restart — with "Auto" as the default, "Auto"
// itself survives the restart.
//
// "Auto" as a default needs safeStorage. Where the system has none (a Linux
// runner without a keyring, say), the restart is checked with "Always ask",
// which needs no encryption.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

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

test('workspace default mode: remembered from the menu, used by a new chat, kept across a restart', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-ws-mode-'));
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-ws-mode-userdata-'));
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

  let snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  });
  let { page } = snotra;
  await confirmDialogs(snotra.app);
  await waitForTree(page);
  await poll(async () => (await state(page))?.workspaceRoot, { what: 'permission state with a workspace' });

  // Nothing to remember while the chat and the folder are at "Smart".
  assert.equal(await pillMode(page), 'smart');
  await page.click('#btn-chat-tool-mode');
  assert.equal(await page.evaluate(() => document.getElementById('chat-tool-mode-footer').hidden), true);
  await page.keyboard.press('Escape');

  // The chat switches to "Always ask"; the checkbox offers it for the folder.
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('ask-all'));
  await poll(async () => (await pillMode(page)) === 'ask-all', { what: 'chat at "Always ask"' });
  await page.click('#btn-chat-tool-mode');
  const offer = await page.evaluate(() => ({
    hidden: document.getElementById('chat-tool-mode-footer').hidden,
    label: document.getElementById('chat-tool-mode-remember-label').textContent,
    checked: document.getElementById('chat-tool-mode-remember').checked,
  }));
  assert.deepEqual(offer, {
    hidden: false,
    label: `“Always ask” for new chats in ${path.basename(workspace)} too`,
    checked: false,
  });
  await page.click('#chat-tool-mode-remember');
  await poll(async () => (await state(page)).workspaceMode === 'ask-all', { what: 'default stored in main' });
  await poll(() => page.evaluate(() =>
    document.querySelector('.chat-tool-mode-option[data-mode="ask-all"] .chat-tool-mode-default-tag')?.textContent || null),
  { what: 'tag on the default' });
  await page.keyboard.press('Escape');

  // Back to "Smart" in this chat; a new chat starts with the folder's default.
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('smart'));
  await poll(async () => (await pillMode(page)) === 'smart', { what: 'chat back at "Smart"' });
  await page.evaluate(() => document.getElementById('btn-chat-new').click());
  await poll(async () => (await pillMode(page)) === 'ask-all', { what: 'new chat at the default' });

  // With encrypted storage, "Auto" as the default — and the next start keeps it.
  const canAuto = (await state(page)).encryptionAvailable === true;
  let expected = 'ask-all';
  if (canAuto) {
    const set = await page.evaluate(() => window.electronAPI.setWorkspaceMode('auto'));
    assert.equal(set.ok, true);
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
