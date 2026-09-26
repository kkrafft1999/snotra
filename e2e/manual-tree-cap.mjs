// Look instead of trust (#76): starts the real app on a folder with more
// entries than the file tree lists, opens it and photographs the note at the
// end of the cut-off list, light and dark. Not a test — a look.
//
//   node e2e/manual-tree-cap.mjs [en|de]
//
// Result: out/mockup/tree-cap-<locale>-{light,dark}.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const EXTRA = 12345;
// READ_DIRECTORY_MAX_ENTRIES in src/main/services/fs-service.js
const CAP = 2000;

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-tree-cap-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-tree-cap-userdata-'));
await mkdir(SHOTS, { recursive: true });

await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
await mkdir(path.join(workspace, 'node_modules'));
const names = Array.from({ length: CAP + EXTRA }, (_, i) => `module-${String(i).padStart(5, '0')}.js`);
for (let i = 0; i < names.length; i += 500) {
  await Promise.all(names.slice(i, i + 500).map((name) =>
    writeFile(path.join(workspace, 'node_modules', name), '', 'utf8')));
}

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  await page.evaluate(() => {
    [...document.querySelectorAll('#tree-container .tree-item')]
      .find((el) => el.querySelector('.label')?.textContent === 'node_modules')
      ?.click();
  });
  await poll(() => page.evaluate(() => Boolean(document.querySelector('.tree-hidden-entries'))),
    { what: 'note under node_modules' });
  const info = await page.evaluate(() => {
    const container = document.getElementById('tree-container');
    container.scrollTop = container.scrollHeight;
    const note = document.querySelector('.tree-hidden-entries');
    return {
      rows: document.querySelectorAll('.tree-children .tree-item').length,
      note: note.textContent,
      color: getComputedStyle(note).color,
      // Both should match: the note lines up with the file names.
      noteTextLeft: (() => { const r = document.createRange(); r.selectNodeContents(note); return r.getBoundingClientRect().left; })(),
      labelLeft: document.querySelector('.tree-children .tree-item .label').getBoundingClientRect().left,
      noteHeight: note.getBoundingClientRect().height,
    };
  });
  console.log(info);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 200));
    await page.locator('#sidebar').screenshot({ path: path.join(SHOTS, `tree-cap-${locale}-${theme}.png`) });
  }
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
