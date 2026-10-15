// Look instead of trust (#945): starts the real app on a folder with symbolic
// links — to a folder inside it, to a file, to a folder outside it and one
// whose target is gone — and photographs the sidebar, light and dark, with
// the linked folder open and the file link selected. Not a test — a look.
//
//   node e2e/manual-symlinks.mjs [en|de]
//
// Result: out/mockup/symlinks-<locale>-{light,dark}.png

import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-symlink-look-');
const elsewhere = await makeTempDir('snotra-symlink-look-elsewhere-');
const userDataDir = await makeTempDir('snotra-symlink-look-userdata-');
await mkdir(SHOTS, { recursive: true });

for (const dir of ['.agents/skills/release', '.claude', 'docs']) {
  await mkdir(path.join(workspace, dir), { recursive: true });
}
const files = {
  '.agents/skills/release/SKILL.md': '# Release\n',
  '.claude/settings.local.json': '{}\n',
  'AGENTS.md': '# Agents\n',
  'package.json': '{}\n',
};
for (const [rel, content] of Object.entries(files)) {
  await writeFile(path.join(workspace, rel), content, 'utf8');
}
const dirType = process.platform === 'win32' ? 'junction' : 'dir';
await symlink('../.agents/skills', path.join(workspace, '.claude/skills'), dirType);
await symlink('AGENTS.md', path.join(workspace, 'CLAUDE.md'), 'file');
await symlink('notes/old.md', path.join(workspace, 'old-notes.md'), 'file');
await symlink(elsewhere, path.join(workspace, 'shared'), dirType);

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

const rowSelector = (rel) => `#tree-container .tree-item[data-path$="${path.sep}${rel.split('/').join(path.sep)}"]`;

async function shoot() {
  const box = await page.locator('#sidebar').boundingBox();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({
      path: path.join(SHOTS, `symlinks-${locale}-${theme}.png`),
      clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 460) },
    });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const describe = () => page.evaluate(() =>
  [...document.querySelectorAll('#tree-container .tree-item')].map((row) => ({
    name: row.querySelector('.label').textContent,
    title: row.title,
    label: row.getAttribute('aria-label'),
    link: row.dataset.link || '',
    expandable: row.dataset.isDirectory,
  })));

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  await page.click('#btn-tree-actions');
  await page.click('#tree-actions-menu [data-action="hidden-files"]');
  await poll(() => page.evaluate(() => Boolean(document.querySelector('.tree-item--hidden'))),
    { what: 'hidden rows' });
  await page.click(rowSelector('.claude'));
  await poll(() => page.evaluate(() => Boolean(document.querySelector('.tree-item[data-link]'))),
    { what: '.claude open' });
  await page.click(rowSelector('.claude/skills'));
  await poll(() => page.evaluate(() => Boolean(document.querySelector('.tree-item[data-path$="release"]'))),
    { what: 'linked folder open' });
  await page.click(rowSelector('CLAUDE.md'));
  await page.hover(rowSelector('.claude/skills'));
  await new Promise((r) => setTimeout(r, 300));
  console.table(await describe());
  await shoot();
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
