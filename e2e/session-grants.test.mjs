// Session approvals one by one in the running app (#447): "Allow for this
// session" on a card puts the approval into Settings › Permissions, a second
// identical call runs without a card, revoking it there makes the next
// identical call ask again.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const PENDING = '#chat-messages .chat-approval-card[data-state="pending"]';
const state = (page) => page.evaluate(() => window.electronAPI.getToolPermissionState());

function ask(page, question) {
  return page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, question);
}

async function idle(page) {
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 60_000 });
}

async function answerCard(page, response) {
  await poll(() => page.evaluate(({ selector, response }) => {
    const button = [...document.querySelectorAll(selector)].at(-1)?.querySelector(`button[data-response="${response}"]`);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, { selector: PENDING, response }), { what: `card with "${response}"`, timeoutMs: 30_000 });
}

function edit(from, to) {
  return [{ name: 'edit_file', arguments: { relative_path: 'README.md', old_string: from, new_string: to } }];
}

test('a session approval is listed, used, and revoked one by one', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-grants-'));
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-grants-userdata-'));
  await writeFile(path.join(workspace, 'README.md'), 'one\n', 'utf8');
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
  await poll(async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
    { what: 'drawn tree' });
  await poll(async () => (await state(page))?.workspaceRoot, { what: 'permission state with a workspace' });

  // 1. The card is answered with "Allow for this session".
  model.queueAnswer({ match: 'First change', toolCalls: edit('one', 'two') });
  await ask(page, 'First change please.');
  await answerCard(page, 'allow-session');
  await idle(page);
  const granted = (await state(page)).sessionGrants;
  assert.equal(granted.length, 1);
  assert.equal(granted[0].tool, 'edit_file');
  assert.equal(granted[0].current, true);
  assert.equal(granted[0].scope?.key, 'approval.sessionScope.targets');

  // 2. The same file again: the approval covers it. Nobody answers a card
  // here, so the run can only finish — and the file only change — without one.
  model.queueAnswer({ match: 'Second change', toolCalls: edit('two', 'three') });
  await ask(page, 'Second change please.');
  await idle(page);
  assert.equal(await readFile(path.join(workspace, 'README.md'), 'utf8'), 'three\n', 'ran without a card');

  // 3. Settings › Permissions lists it; "Revoke" drops it.
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings dialog' });
  await page.evaluate(() => document.getElementById('tab-settings-permissions').click());
  const row = await poll(() => page.evaluate(() => {
    const el = document.querySelector('#settings-grants .settings-grant');
    return el ? el.textContent.replace(/\s+/g, ' ') : null;
  }), { what: 'session approval in the list' });
  assert.match(row, /edit_file/);
  assert.match(row, /README\.md/);
  await page.evaluate(() => document.querySelector('#settings-grants button[data-grant-id]').click());
  await poll(async () => (await state(page)).sessionGrants.length === 0, { what: 'approval revoked in main' });
  await poll(() => page.evaluate(() => !document.getElementById('settings-grants-empty').classList.contains('hidden')),
    { what: 'empty hint' });
  await page.keyboard.press('Escape');
  await poll(() => page.evaluate(() => document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings closed' });

  // 4. The next identical call asks again: a pending card, answered "deny".
  model.queueAnswer({ match: 'Third change', toolCalls: edit('three', 'four') });
  await ask(page, 'Third change please.');
  await answerCard(page, 'deny');
  await idle(page);
  assert.equal(await readFile(path.join(workspace, 'README.md'), 'utf8'), 'three\n', 'denied, unchanged');
});
