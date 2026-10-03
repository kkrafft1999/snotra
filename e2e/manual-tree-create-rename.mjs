// Look instead of trust (#349): starts the real app and creates and renames
// in the tree — from the header's buttons, with F2 and from the context menu
// (main's real menu, clicked from here instead of shown). Photographs the
// name field, a refused name, a long name, a read-only folder and a narrow
// sidebar, light and dark, and checks what landed on disk. Not a test — a look.
//
//   node e2e/manual-tree-create-rename.mjs [en|de]
//
// Result: out/mockup/tree-create-rename-<locale>-<state>-{light,dark}.png

import { mkdir, writeFile, readdir, chmod } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const pause = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-tree-create-');
const userDataDir = await makeTempDir('snotra-tree-create-userdata-');
await mkdir(SHOTS, { recursive: true });

for (const dir of ['docs/guide', 'src', 'locked']) await mkdir(path.join(workspace, dir), { recursive: true });
const files = {
  'README.md': '# Example\n',
  'package.json': '{}\n',
  'docs/index.md': '# Docs\n',
  'src/app.js': 'console.log(1);\n',
  'locked/kept.md': 'kept\n',
};
for (const [rel, content] of Object.entries(files)) {
  await writeFile(path.join(workspace, rel), content, 'utf8');
}
await chmod(path.join(workspace, 'locked'), 0o555);

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

async function shoot(state, { height = 380 } = {}) {
  const box = await page.locator('#sidebar').boundingBox();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause();
    await page.screenshot({
      path: path.join(SHOTS, `tree-create-rename-${locale}-${state}-${theme}.png`),
      clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, height) },
    });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const row = (rel) => page.locator(`#tree-container .tree-item[data-path="${path.join(workspace, rel)}"]`);
const fieldState = () => page.evaluate(() => {
  const input = document.querySelector('.tree-name-input');
  const message = document.querySelector('.tree-name-error');
  return input ? {
    value: input.value,
    selection: [input.selectionStart, input.selectionEnd],
    focused: document.activeElement === input,
    label: input.getAttribute('aria-label'),
    message: message && !message.hidden ? message.textContent : null,
  } : null;
});
const log = async (label) => console.log(label.padEnd(18), JSON.stringify(await fieldState()));

/** Clicks an entry of main's context menu for a path, as the user would. */
async function menuClick(rel, label) {
  await row(rel).click({ button: 'right' });
  await poll(() => app.evaluate(() => Boolean(globalThis.__lastMenu)), { what: 'menu built' });
  const labels = await app.evaluate(({}, wanted) => {
    const menu = globalThis.__lastMenu;
    globalThis.__lastMenu = null;
    menu.items.find((item) => item.label === wanted).click();
    return menu.items.map((item) => item.label || '—');
  }, label);
  console.log('menu'.padEnd(18), labels.join(' | '));
  await pause(300);
}

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function popup() { globalThis.__lastMenu = this; };
  });
  await shoot('header');

  // F2 on a file: the name without its extension is selected.
  await row('README.md').focus();
  await page.keyboard.press('F2');
  await pause();
  await log('F2 README.md');
  await shoot('rename-field');

  // Typing replaces the selected part only: the extension stays.
  await page.keyboard.type('NOTES');
  await pause();
  await log('typed NOTES');
  // A name that is there already.
  await page.keyboard.press('Meta+A');
  await page.keyboard.type('docs');
  await pause();
  await log('typed docs');
  await shoot('rename-exists');
  await page.keyboard.press('Escape');
  await pause();

  // Case-only rename, for real on disk.
  await row('README.md').focus();
  await page.keyboard.press('F2');
  await page.keyboard.press('Meta+A');
  await page.keyboard.type('Readme.md');
  await page.keyboard.press('Enter');
  await pause(500);
  console.log('disk after case'.padEnd(18), (await readdir(workspace)).join(', '));

  // New file in the selected folder, from the header.
  await row('docs').click();
  await pause();
  await page.click('#btn-tree-actions');
  await page.click('#tree-actions-menu [data-action="new-file"]');
  await pause();
  await log('new file in docs');
  await shoot('create-field');
  await page.keyboard.type('Übersicht März 2026 – Planung für das zweite Halbjahr mit allen Terminen.md');
  await pause();
  await shoot('create-long');
  await page.keyboard.press('Enter');
  await pause(600);
  console.log('docs on disk'.padEnd(18), (await readdir(path.join(workspace, 'docs'))).join(', '));
  console.log('selected'.padEnd(18), await page.evaluate(() =>
    document.querySelector('#tree-container [aria-selected="true"]')?.getAttribute('aria-label')));
  await shoot('created-long');

  // New folder from the context menu of a file: next to it.
  await row('src').click();
  await pause();
  await menuClick('src/app.js', locale === 'de' ? 'Neuer Ordner…' : 'New Folder…');
  await log('menu new folder');
  await page.keyboard.type('components');
  await page.keyboard.press('Enter');
  await pause(500);
  console.log('src on disk'.padEnd(18), (await readdir(path.join(workspace, 'src'))).join(', '));

  // A read-only folder: main says why.
  await menuClick('locked', locale === 'de' ? 'Neue Datei…' : 'New File…');
  await page.keyboard.type('new.md');
  await page.keyboard.press('Enter');
  await pause(400);
  await log('read-only');
  await shoot('read-only');
  await page.keyboard.press('Escape');

  // The open folder's own menu, from the empty space.
  await page.locator('#tree-container').click({ button: 'right', position: { x: 60, y: 360 } });
  await poll(() => app.evaluate(() => Boolean(globalThis.__lastMenu)), { what: 'root menu' });
  console.log('root menu'.padEnd(18), (await app.evaluate(() => {
    const menu = globalThis.__lastMenu;
    globalThis.__lastMenu = null;
    return menu.items.map((item) => item.label || '—');
  })).join(' | '));

  // The narrowest sidebar the resizer allows.
  await page.evaluate(() => {
    const sidebar = document.getElementById('sidebar');
    sidebar.style.width = '180px';
  });
  await pause();
  await shoot('narrow');
  console.log('header fits'.padEnd(18), JSON.stringify(await page.evaluate(() => {
    const header = document.getElementById('tree-header').getBoundingClientRect();
    const actions = document.getElementById('btn-tree-actions').getBoundingClientRect();
    return { header: Math.round(header.right), actions: Math.round(actions.right) };
  })));
} finally {
  await chmod(path.join(workspace, 'locked'), 0o755).catch(() => {});
  await snotra.stop().catch(() => {});
  await model.close();
}
