// The reasoning level belongs to the chat and is chosen in the model menu
// (#723, #727). A level chosen in one chat comes back with that chat — after
// a switch and after a restart — and a new chat starts with "medium".
//
// The OpenAI entry gets a key that is only stored, never sent: every message
// here goes to the fake model, and the model is switched only afterwards.
// That a round carries the level is covered by the unit tests of the LLM
// adapter, the engine and the OpenAI provider.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const pill = (page) => page.evaluate(() => document.getElementById('chat-model-pill-label').textContent);

async function openMenu(page) {
  await page.evaluate(() => {
    if (document.getElementById('chat-model-menu').classList.contains('hidden')) {
      document.getElementById('btn-chat-model-picker').click();
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('chat-model-menu').classList.contains('hidden')),
    { what: 'open model menu' });
}

// What closed the menu (#741): every event that can close it, and every
// change of its class, in the page's own clock. Read back on a failure.
async function recordMenuEvents(page) {
  await page.evaluate(() => {
    const log = [];
    window.__menuLog = log;
    const name = (el) => (el?.id ? `#${el.id}` : el?.className ? `.${String(el.className).split(' ')[0]}` : el?.nodeName || null);
    const at = () => Math.round(performance.now());
    for (const type of ['pointerdown', 'mousedown', 'click', 'keydown', 'focusin', 'focusout']) {
      document.addEventListener(type, (e) => {
        log.push({ at: at(), type, target: name(e.target), related: name(e.relatedTarget), key: e.key, hasFocus: document.hasFocus() });
      }, true);
    }
    window.addEventListener('blur', () => log.push({ at: at(), type: 'window-blur' }));
    window.addEventListener('focus', () => log.push({ at: at(), type: 'window-focus' }));
    const menu = document.getElementById('chat-model-menu');
    const bar = document.querySelector('.chat-composer-bar');
    new MutationObserver(() => log.push({
      at: at(), type: 'menu', hidden: menu.classList.contains('hidden'), active: name(document.activeElement),
      bar: Math.round(bar.getBoundingClientRect().width), stacked: bar.dataset.stacked === 'true',
    }))
      .observe(menu, { attributes: true, attributeFilter: ['class'] });
  });
}

const menuLog = (page) => page.evaluate(() => JSON.stringify(window.__menuLog || []));

async function waitForApp(page) {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });
  await poll(() => page.evaluate(() => !document.getElementById('btn-chat-model-picker').classList.contains('hidden')),
    { what: 'model pill' });
}

test('a chosen reasoning level stays with its chat, a new chat starts with medium', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-reasoning-');
  const userDataDir = await makeTempDir('snotra-reasoning-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');
  const configPath = path.join(userDataDir, 'llm-config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.presets.push({ id: 'gpt5', providerId: 'openai', model: 'gpt-5-mini', menuVisible: true });
  await writeFile(configPath, JSON.stringify(config), 'utf8');
  const fakeId = config.presets[0].id;

  let snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  let { page } = snotra;
  await waitForApp(page);

  const { encryptionAvailable } = await page.evaluate(() => window.electronAPI.getLLMState());
  if (!encryptionAvailable) {
    t.skip('no encrypted storage here (a Linux runner without a keyring): no key for the OpenAI entry');
    return;
  }
  const saved = await page.evaluate(({ rows, active }) => window.electronAPI.commitSettings({
    presets: rows,
    activePresetId: active,
    providerPatches: { openai: { apiKey: 'sk-e2e-never-sent' } },
  }), { rows: config.presets, active: fakeId });
  assert.equal(saved?.ok, true, `settings saved: ${JSON.stringify(saved)}`);
  await page.reload();
  await waitForApp(page);

  // A chat with a row of its own, answered by the fake model, title included.
  await page.evaluate(() => {
    if (document.getElementById('app').classList.contains('app--no-history')) {
      document.getElementById('btn-toggle-chat-history').click();
    }
  });
  model.queueAnswer({ match: 'first chat', text: 'Done.' });
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = 'This is the first chat.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  });
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')
    && document.querySelectorAll('#chat-messages .chat-msg.assistant').length > 0), { what: 'answer' });
  await poll(() => model.requests.some((r) => r.isTitleRequest), { what: 'title request to the fake model' });
  await poll(() => page.evaluate(() => document.querySelectorAll('.chat-history-row').length === 1),
    { what: 'history row' });
  assert.equal(await pill(page), 'fake-model', 'no levels for the fake model');

  // Switch this chat to the OpenAI entry and choose "high" in the menu.
  await recordMenuEvents(page);
  await openMenu(page);
  await page.click('.chat-model-menu-option[data-preset-id="gpt5"]', { timeout: 10000 }).catch(async (error) => {
    throw new Error(`${error.message.split('\n')[0]} — ${await menuLog(page)}`);
  });
  await poll(async () => (await pill(page)) === 'gpt-5-mini · medium', { what: 'pill at medium' });
  await openMenu(page);
  // With the mouse, on the word — a press there once closed the menu first.
  await page.click('#chat-reasoning-levels label:has(input[value="high"])');
  await poll(async () => (await pill(page)) === 'gpt-5-mini · high', { what: 'pill at high' }).catch(async (error) => {
    const seen = await page.evaluate(async () => ({
      checked: document.querySelector('#chat-reasoning-levels input:checked')?.value,
      status: document.getElementById('chat-reasoning-status').textContent,
      open: !document.getElementById('chat-model-menu').classList.contains('hidden'),
      reasoning: (await window.electronAPI.getLLMState()).reasoning,
    }));
    throw new Error(`${error.message} — ${JSON.stringify(seen)}`);
  });
  assert.equal(await page.evaluate(() => document.getElementById('chat-model-menu').classList.contains('hidden')), true,
    'the menu closes after a level (#737)');

  // The composer bar crossing 400 px moves the pills, open menu included, and
  // Chromium drops the focus on the way: the menu stays open all the same
  // (#741). Docked next to the README the bar is narrow here, so the test
  // sets the width both ways rather than relying on the layout.
  const setBar = async (width) => {
    await page.evaluate((w) => { document.querySelector('.chat-composer-bar').style.width = w; }, width);
    const stacked = parseInt(width, 10) < 400;
    await poll(() => page.evaluate((st) => (document.querySelector('.chat-composer-bar').dataset.stacked === 'true') === st, stacked),
      { what: `bar at ${width}` });
  };
  await setBar('600px');
  await openMenu(page);
  for (const width of ['360px', '600px']) {
    await setBar(width);
    assert.deepEqual(await page.evaluate(() => ({
      open: !document.getElementById('chat-model-menu').classList.contains('hidden'),
      focusInMenu: document.getElementById('chat-model-menu').contains(document.activeElement),
    })), { open: true, focusInMenu: true }, `menu after the bar went to ${width}`);
  }
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.querySelector('.chat-composer-bar').style.width = ''; });

  // A new chat runs with the same entry, but at medium.
  await page.evaluate(() => document.getElementById('btn-chat-new').click());
  await poll(async () => (await pill(page)) === 'gpt-5-mini · medium', { what: 'new chat at medium' });
  assert.equal((await page.evaluate(() => window.electronAPI.getLLMState())).reasoning.level, 'medium');

  // Back to the first chat: its level comes back with it.
  await page.click('.chat-history-row-main');
  await poll(async () => (await pill(page)) === 'gpt-5-mini · high', { what: 'first chat at high again' });

  // And after a restart, with the first chat restored.
  await snotra.stop();
  snotra = await launchApp({ userDataDir });
  page = snotra.page;
  await waitForApp(page);
  await poll(async () => (await pill(page)) === 'gpt-5-mini · high', { what: 'high after the restart' });

  // Nothing went anywhere but to the fake model.
  assert.ok(model.requests.length >= 2);
});
