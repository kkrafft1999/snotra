// First run (#670): a fresh profile comes with an OpenAI entry without a key.
// Adding a first working model through the settings dialog has to make the
// chat usable — without removing that default entry first — and the hint
// before it has to name the way to the settings that actually exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, poll } from './helpers/app.mjs';

const chrome = (page) => page.evaluate(() => ({
  hint: document.getElementById('chat-hint').classList.contains('hidden')
    ? null
    : document.getElementById('chat-hint').textContent,
  sendDisabled: document.getElementById('btn-chat-send').disabled,
  pill: document.getElementById('chat-model-picker-wrap')?.classList.contains('hidden')
    ? null
    : document.getElementById('chat-model-pill-label').textContent,
}));

test('first run: adding a model makes the chat usable next to the default entry', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-first-run-'));
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-first-run-userdata-'));
  const write = (name, data) => writeFile(path.join(userDataDir, name), JSON.stringify(data), 'utf8');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  // No llm-config.json: the app creates its default entry itself. The marker
  // keeps the one-off migration from an older install on this machine from
  // filling the profile (#670 was found that way).
  await write('migrated-from-weyouze.json', {});
  await write('last-folder.json', { path: workspace });
  await write('folder-history.json', { paths: [workspace] });
  await write('ui-preferences.json', { appLocale: 'en' });

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

  // Before: no usable model, and the hint names menu and shortcut.
  const before = await poll(async () => {
    const c = await chrome(page);
    return c.hint ? c : null;
  }, { what: 'hint without a model' });
  const expectedHint = process.platform === 'darwin'
    ? 'Set up a language model to start chatting: Snotra AI › Settings… (⌘,).'
    : 'Set up a language model to start chatting: View › Settings… (Ctrl+,).';
  assert.deepEqual(before, { hint: expectedHint, sendDisabled: true, pill: null });

  // Settings › Models › Add model — the way the hint describes, via the menu.
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /^Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() =>
    !document.getElementById('modal-settings').classList.contains('hidden')),
  { what: 'open settings dialog' });
  await poll(() => page.evaluate(() => !document.getElementById('btn-settings-save').disabled),
    { what: 'settings loaded' });

  await page.click('#btn-open-add-model');
  await poll(() => page.evaluate(() =>
    !document.getElementById('add-model-overlay').classList.contains('hidden')),
  { what: 'open add-model dialog' });
  await page.selectOption('#select-provider', 'openai-compatible');
  await page.fill('#input-display-name', 'Local server');
  await page.fill('#input-base-url', model.baseUrl);
  await page.fill('#input-model', 'fake-model');
  await page.click('#btn-add-preset-row');
  await poll(() => page.evaluate(() =>
    document.getElementById('add-model-overlay').classList.contains('hidden')),
  { what: 'add-model dialog closed' });

  await page.click('#btn-settings-save');
  await poll(() => page.evaluate(() =>
    document.getElementById('modal-settings').classList.contains('hidden')),
  { what: 'settings dialog closed after Apply' }).catch(async (error) => {
    const message = await page.evaluate(() => document.getElementById('modal-save-error')?.textContent);
    throw new Error(`${error.message} — dialog says: ${JSON.stringify(message)}`);
  });

  // After: the new entry is active, the default entry is still there.
  const after = await poll(async () => {
    const c = await chrome(page);
    return c.hint === null && !c.sendDisabled ? c : null;
  }, { what: 'usable chat after Apply' });
  assert.equal(after.pill, 'Local server · fake-model');

  const config = JSON.parse(await readFile(path.join(userDataDir, 'llm-config.json'), 'utf8'));
  assert.deepEqual(config.presets.map((p) => p.providerId), ['openai', 'openai-compatible']);
  assert.equal(config.activePresetId, config.presets[1].id);
});
