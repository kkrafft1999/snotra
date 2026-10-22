// The output limit of an OpenAI-compatible entry (#931), through the real
// dialog: a wrong value is refused with a visible message and keeps the
// dialog open, a valid one reaches the server as `max_tokens`, and clearing
// the field sends nothing again. Which field each API style uses, the
// fallback and the `extraBody` precedence are covered by the unit tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function editOnlyEntry(page) {
  await page.click('#pref-model-list .settings-icon-edit');
  await poll(() => shown(page, 'add-model-overlay'), { what: 'open edit-model dialog' });
  await poll(() => shown(page, 'provider-max-output-tokens-row'), { what: 'output limit row' });
}

async function applyAndSave(page) {
  await page.click('#btn-add-preset-row');
  await poll(async () => !(await shown(page, 'add-model-overlay')), { what: 'edit-model dialog closed' });
  await page.click('#btn-settings-save');
  await poll(async () => !(await shown(page, 'modal-settings')), { what: 'settings dialog closed' });
}

const fieldState = (page) => page.evaluate(() => {
  const input = document.getElementById('input-max-output-tokens');
  const error = document.getElementById('provider-max-output-tokens-error');
  return {
    invalid: input.getAttribute('aria-invalid'),
    error: error.classList.contains('hidden') ? null : error.textContent,
    focused: document.activeElement === input,
  };
});

test('the output limit is validated in the dialog and sent with the request', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-max-tokens-');
  const userDataDir = await makeTempDir('snotra-max-tokens-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

  const snotra = await launchApp({ userDataDir, mainPreload: fileURLToPath(new URL('./helpers/diag-preload.cjs', import.meta.url)) });
  t.after(() => t.diagnostic(snotra.mainOutput().split('\n').filter((l) => l.startsWith('[diag')).join('\n')));
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page, app } = snotra;
  await waitForFolderChat(page);

  await openSettings(app, page);
  await editOnlyEntry(page);
  assert.equal(await page.inputValue('#input-max-output-tokens'), '', 'empty by default');

  // While typing nothing is called wrong; leaving the field is.
  await page.fill('#input-max-output-tokens', '8.5');
  assert.deepEqual(await fieldState(page), { invalid: 'false', error: null, focused: true });
  await page.focus('#input-model');
  const refused = await fieldState(page);
  assert.equal(refused.invalid, 'true');
  assert.equal(refused.error, 'Enter a whole number from 1 to 1,000,000, or leave the field empty.');

  // Apply keeps the dialog open and puts the focus back on the field.
  await page.click('#btn-add-preset-row');
  assert.equal(await shown(page, 'add-model-overlay'), true, 'a wrong value blocks Apply');
  assert.equal((await fieldState(page)).focused, true);

  // A fix clears the message at once.
  await page.fill('#input-max-output-tokens', '4,096');
  assert.deepEqual(await fieldState(page), { invalid: 'false', error: null, focused: true });
  await applyAndSave(page);

  const stored = JSON.parse(await readFile(path.join(userDataDir, 'llm-config.json'), 'utf8'));
  assert.equal(stored.presets[0].connection.maxOutputTokens, 4096);

  await app.evaluate(() => globalThis.__diag('MARK before send LIMIT-ON'));
  await sendChat(page, 'LIMIT-ON', { t });
  await app.evaluate(() => globalThis.__diag('MARK send taken LIMIT-ON'));
  const withLimit = await poll(() => model.requestFor('LIMIT-ON'), { what: 'request with limit', explain: () => model.describeRequests() });
  await app.evaluate(() => globalThis.__diag('MARK request seen LIMIT-ON'));
  assert.equal(withLimit.body.max_tokens, 4096);

  // Clearing the field removes the limit again.
  await openSettings(app, page);
  await editOnlyEntry(page);
  assert.equal(await page.inputValue('#input-max-output-tokens'), '4096');
  await page.fill('#input-max-output-tokens', '');
  await applyAndSave(page);

  const cleared = JSON.parse(await readFile(path.join(userDataDir, 'llm-config.json'), 'utf8'));
  assert.equal('maxOutputTokens' in cleared.presets[0].connection, false);

  await poll(() => page.evaluate(() => {
    const button = document.getElementById('btn-chat-send');
    return !button.disabled && !button.classList.contains('chat-send--stop');
  }), { what: 'first run finished' });
  await sendChat(page, 'LIMIT-OFF', { t });
  const withoutLimit = await poll(() => model.requestFor('LIMIT-OFF'), { what: 'request without limit' });
  assert.equal('max_tokens' in withoutLimit.body, false);
});
