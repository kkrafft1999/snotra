// Look instead of trust (#436): starts the real app on a folder with hidden
// files and photographs the top of the sidebar — hidden files off, on with a
// hidden folder open and a hidden file selected, and the header's `⋯` menu
// with its entry checked (#676) — light and dark. Not a test — a look.
//
//   node e2e/manual-hidden-files.mjs [en|de]
//
// Result: out/mockup/hidden-files-<locale>-<state>-{light,dark}.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-hidden-look-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-hidden-look-userdata-'));
await mkdir(SHOTS, { recursive: true });

for (const dir of ['.claude', '.github/workflows', '.git', 'docs', 'src']) {
  await mkdir(path.join(workspace, dir), { recursive: true });
}
const files = {
  '.github/workflows/ci.yml': 'on: push\n',
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.editorconfig': 'root = true\n',
  '.env': 'API_URL=http://localhost:8080\n',
  '.gitignore': 'node_modules/\n',
  '.DS_Store': 'noise',
  'package.json': '{}\n',
  'README.md': '# Example\n',
};
for (const [rel, content] of Object.entries(files)) {
  await writeFile(path.join(workspace, rel), content, 'utf8');
}

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

const rowSelector = (name) => `#tree-container .tree-item[data-path$="${path.sep}${name}"]`;

async function shoot(state) {
  const box = await page.locator('#sidebar').boundingBox();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({
      path: path.join(SHOTS, `hidden-files-${locale}-${state}-${theme}.png`),
      clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 400) },
    });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

// Since #676 the switch is a check box in the tree header's `⋯` menu.
const describe = () => page.evaluate(() => {
  const item = document.querySelector('#tree-actions-menu [data-action="hidden-files"]');
  return {
    checked: item.getAttribute('aria-checked'),
    label: item.querySelector('.tree-actions-label').textContent,
    shortcut: item.querySelector('.tree-actions-shortcut').textContent,
    rows: [...document.querySelectorAll('#tree-container .tree-item')].map((row) =>
      `${row.classList.contains('tree-item--hidden') ? '~' : ' '}${row.querySelector('.label').textContent}`),
  };
});

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  console.log('off', await describe());
  await shoot('off');

  await page.click('#btn-tree-actions');
  await page.click('#tree-actions-menu [data-action="hidden-files"]');
  await poll(() => page.evaluate(() => Boolean(document.querySelector('.tree-item--hidden'))),
    { what: 'hidden rows' });
  await page.click(rowSelector('.github'));
  await poll(() => page.evaluate(() => Boolean(document.querySelector('.tree-item[data-path$="workflows"]'))),
    { what: '.github open' });
  await page.click(rowSelector('.env'));
  await page.mouse.move(0, 0);
  await new Promise((r) => setTimeout(r, 300));
  console.log('on', await describe());
  await shoot('on');

  // The menu, opened from the keyboard, with the entry checked.
  await page.focus('#btn-tree-actions');
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  console.log('focus on', await page.evaluate(() => document.activeElement?.dataset.action));
  await shoot('menu');
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
