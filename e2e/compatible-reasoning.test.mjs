// Reasoning levels on an OpenAI-compatible entry (#1148), through the real
// dialog and the real model menu: with the entry's switch off the menu has no
// reasoning section and the request carries no level; switched on, the menu
// offers low, medium and high and the chosen one reaches the server as
// `reasoning_effort`. The Responses style, the fallback and the explained
// rejection are covered by the unit tests of the provider.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat, waitForFolderChat } from './helpers/app.mjs';

const shown = (page, id) => page.evaluate((id) => !document.getElementById(id).classList.contains('hidden'), id);

async function openSettings(app, page) {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /^Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => shown(page, 'modal-settings'), { what: 'open settings dialog' });
  await poll(() => page.evaluate(() => !document.getElementById('btn-settings-save').disabled),
    { what: 'settings loaded' });
}

async function openMenu(page) {
  await page.evaluate(() => {
    if (document.getElementById('chat-model-menu').classList.contains('hidden')) {
      document.getElementById('btn-chat-model-picker').click();
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('chat-model-menu').classList.contains('hidden')),
    { what: 'open model menu' });
}

const levels = (page) => page.evaluate(() => (document.getElementById('chat-reasoning').hidden
  ? null
  : [...document.querySelectorAll('#chat-reasoning-levels input')].map((i) => (i.checked ? `[${i.value}]` : i.value))));

const runFinished = (page) => poll(() => page.evaluate(() => {
  const button = document.getElementById('btn-chat-send');
  return !button.disabled && !button.classList.contains('chat-send--stop');
}), { what: 'run finished' });

test('an OpenAI-compatible entry offers and sends a reasoning level only with its switch on', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-compat-reasoning-');
  const userDataDir = await makeTempDir('snotra-compat-reasoning-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page, app } = snotra;
  await waitForFolderChat(page);

  // Off by default: no section, no field.
  await openMenu(page);
  assert.equal(await levels(page), null);
  await page.keyboard.press('Escape');
  await sendChat(page, 'REASONING-OFF', { t });
  const without = await poll(() => model.requestFor('REASONING-OFF'), { what: 'request without a level' });
  assert.equal('reasoning_effort' in without.body, false);
  await runFinished(page);

  // Switch it on in the entry's dialog.
  await openSettings(app, page);
  await page.click('#pref-model-list .settings-icon-edit');
  await poll(() => shown(page, 'add-model-overlay'), { what: 'open edit-model dialog' });
  await poll(() => shown(page, 'provider-supports-reasoning-row'), { what: 'reasoning switch' });
  assert.equal(await page.isChecked('#input-supports-reasoning'), false);
  await page.check('#input-supports-reasoning');
  await page.click('#btn-add-preset-row');
  await poll(async () => !(await shown(page, 'add-model-overlay')), { what: 'edit-model dialog closed' });
  await page.click('#btn-settings-save');
  await poll(async () => !(await shown(page, 'modal-settings')), { what: 'settings dialog closed' });

  const stored = JSON.parse(await readFile(path.join(userDataDir, 'llm-config.json'), 'utf8'));
  assert.equal(stored.presets[0].connection.supportsReasoning, true);

  await openMenu(page);
  await poll(async () => (await levels(page)) !== null, { what: 'reasoning section' });
  assert.deepEqual(await levels(page), ['low', '[medium]', 'high']);
  await page.click('#chat-reasoning-levels label:has(input[value="high"])');
  await poll(() => page.evaluate(() =>
    document.getElementById('chat-model-pill-label').textContent.endsWith('high')),
  { what: 'pill shows high' });

  await sendChat(page, 'REASONING-ON', { t });
  const withLevel = await poll(() => model.requestFor('REASONING-ON'), { what: 'request with a level' });
  assert.equal(withLevel.body.reasoning_effort, 'high');
});
