// The open file follows the disk while its folder is collapsed (#1018).
//
// A collapsed folder has no rows to compare, so before the fix the watcher's
// report about it never reached the preview: the pane kept the old text, and
// a deleted file stayed on show. Real watcher, a write and a delete from
// outside the app.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const treePaths = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#tree-container .tree-item')].map((row) => row.dataset.path));

const isOpen = (page, dirPath) => page.evaluate((p) =>
  document.querySelector(`#tree-container .tree-item[data-path="${CSS.escape(p)}"]`)
    ?.getAttribute('aria-expanded') === 'true', dirPath);

const clickRow = (page, rowPath) => page.evaluate((p) =>
  document.querySelector(`#tree-container .tree-item[data-path="${CSS.escape(p)}"]`)?.click(), rowPath);

const paneText = (page) => page.evaluate(() =>
  document.querySelector('#preview-body > .file-view')?.textContent ?? null);

const previewShown = (page) => page.evaluate(() =>
  !document.getElementById('file-preview').classList.contains('hidden'));

test('the open file reloads and closes while its folder is collapsed', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-collapsed-open-');
  const userDataDir = await makeTempDir('snotra-collapsed-open-userdata-');
  t.after(() => model.close());

  const docs = path.join(workspace, 'docs');
  const notes = path.join(docs, 'notes.txt');
  await mkdir(docs, { recursive: true });
  await writeFile(notes, 'old text\n', 'utf8');

  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  const snotra = await launchApp({ userDataDir });
  t.after(() => snotra.stop().catch(() => {}));
  const { page } = snotra;

  await poll(async () => (await treePaths(page)).includes(docs), { what: 'the tree' });
  await clickRow(page, docs);
  await poll(async () => (await treePaths(page)).includes(notes), { what: 'docs listed' });
  await clickRow(page, notes);
  await poll(async () => (await paneText(page))?.includes('old text'), { what: 'notes.txt on show' });

  await clickRow(page, docs);
  await poll(async () => !(await isOpen(page, docs)), { what: 'docs collapsed' });

  await writeFile(notes, 'new text\n', 'utf8');
  await poll(async () => (await paneText(page))?.includes('new text'),
    { what: 'the preview reloaded with docs collapsed' });
  assert.equal(await isOpen(page, docs), false, 'the folder stays collapsed');

  await rm(notes);
  await poll(async () => !(await previewShown(page)), { what: 'the preview closed after the delete' });
});
