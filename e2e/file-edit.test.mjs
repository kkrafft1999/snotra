// Editing a text file in the preview (#863), in the real app: the Edit toggle,
// the autosave through main's write channel — whose hash of the text on disk
// has to match the renderer's — and a change by another program that is not
// overwritten. The states in between are covered in test/file-edit-dom.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const saveState = (page) => page.evaluate(() => document.querySelector('.file-edit-status')?.dataset.state ?? null);

test('a text file is edited in the preview and saved by itself', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-edit-');
  const userDataDir = await makeTempDir('snotra-edit-userdata-');
  const file = path.join(workspace, 'notes.txt');
  await writeFile(file, 'Sow carrots in April.\r\n');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page } = snotra;

  await poll(() => page.evaluate(() => {
    const row = [...document.querySelectorAll('#tree-container .tree-item')]
      .find((item) => item.getAttribute('aria-label') === 'notes.txt');
    row?.click();
    return Boolean(row);
  }), { what: 'tree row notes.txt' });
  await poll(() => page.evaluate(() => Boolean(document.querySelector('#preview-tools .file-edit-toggle'))), { what: 'Edit toggle' });
  await page.click('#preview-tools .file-edit-toggle');
  await poll(() => page.evaluate(() => document.activeElement?.classList.contains('text-editor')), { what: 'editor focused' });

  // Typed at the end of the line; saved a second later, without a click.
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('End');
  await page.keyboard.type(' And May.');
  await poll(async () => (await saveState(page)) === 'saved', { what: 'autosave', timeoutMs: 10000 });
  assert.equal(await readFile(file, 'utf8'), 'Sow carrots in April. And May.\r\n', 'saved with its own line ending');

  // Another program writes the file while the user types on: not overwritten.
  await writeFile(file, 'Written elsewhere.\n');
  await page.keyboard.type(' June?');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
  await poll(async () => (await saveState(page)) === 'conflict', { what: 'conflict', timeoutMs: 10000 });
  assert.equal(await readFile(file, 'utf8'), 'Written elsewhere.\n');

  // "Keep my version" writes it over the other one.
  await page.click('.file-edit-notice__action >> nth=0');
  await poll(async () => (await saveState(page)) === 'saved', { what: 'kept', timeoutMs: 10000 });
  assert.equal(await readFile(file, 'utf8'), 'Sow carrots in April. And May. June?\r\n');

  // Esc goes back to the read-only view, showing what was saved.
  await page.keyboard.press('Escape');
  await poll(() => page.evaluate(() => !document.querySelector('.text-editor')
    && document.getElementById('preview-content')?.textContent === 'Sow carrots in April. And May. June?\r\n'), { what: 'read-only again' });
});
