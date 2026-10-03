// Look instead of trust (#74): starts the real app, walks the file tree with
// the real keyboard — Shift+Tab in from the chat, the arrows, Enter — and
// photographs the focus ring, light and dark. The context menu is asked for
// with Shift+F10; main records where it would open instead of opening it, and
// that is compared with the row on screen. Not a test — a look.
//
//   node e2e/manual-tree-keyboard.mjs [en|de]
//
// Result: out/mockup/tree-keyboard-<locale>-<state>-{light,dark}.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-tree-keys-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-tree-keys-userdata-'));
await mkdir(SHOTS, { recursive: true });

for (const dir of ['docs/guide', 'src']) await mkdir(path.join(workspace, dir), { recursive: true });
const files = {
  'README.md': '# Example\n',
  'package.json': '{}\n',
  'docs/guide/intro.md': '# Intro\n',
  'docs/index.md': '# Docs\n',
  'src/app.js': 'console.log(1);\n',
};
for (const [rel, content] of Object.entries(files)) {
  await writeFile(path.join(workspace, rel), content, 'utf8');
}

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

async function shoot(state) {
  const box = await page.locator('#sidebar').boundingBox();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({
      path: path.join(SHOTS, `tree-keyboard-${locale}-${state}-${theme}.png`),
      clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 380) },
    });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const state = () => page.evaluate(() => {
  const active = document.activeElement;
  const row = active?.closest?.('.tree-item');
  return {
    focus: row ? row.querySelector('.label').textContent : (active?.id || active?.tagName),
    focusVisible: row ? row.matches(':focus-visible') : false,
    ring: row ? getComputedStyle(row).outlineStyle + ' ' + getComputedStyle(row).outlineOffset : null,
    tabStops: [...document.querySelectorAll('#tree-container [tabindex="0"]')]
      .map((el) => el.querySelector('.label')?.textContent ?? el.tagName),
    expanded: row?.getAttribute('aria-expanded') ?? null,
    selected: [...document.querySelectorAll('#tree-container [aria-selected="true"]')]
      .map((el) => el.querySelector('.label').textContent),
  };
});

async function key(name, label = name) {
  await page.keyboard.press(name);
  await new Promise((r) => setTimeout(r, 200));
  console.log(label.padEnd(12), JSON.stringify(await state()));
}

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });

  // Main writes down where the menu would go and opens none.
  await app.evaluate(({ Menu }) => {
    globalThis.__menuPopups = [];
    Menu.prototype.popup = function popup(options = {}) {
      globalThis.__menuPopups.push({ x: options.x, y: options.y });
    };
  });

  await page.focus('#chat-input');
  // Shift+Tab walks back from the chat until the tree takes the focus.
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Shift+Tab');
    const inTree = await page.evaluate(() =>
      document.getElementById('tree-container').contains(document.activeElement));
    if (inTree) break;
  }
  console.log('entered'.padEnd(12), JSON.stringify(await state()));
  await shoot('entered');

  await key('ArrowDown');
  await key('ArrowUp');
  await key('ArrowRight', 'Right (open)');
  await key('ArrowRight', 'Right (in)');
  await shoot('inside');
  await key('ArrowDown');
  await key('Enter', 'Enter (file)');
  await shoot('opened');
  await key('ArrowLeft', 'Left (up)');
  await key('ArrowLeft', 'Left (close)');
  await key('End');
  await key('Home');

  await key('Tab', 'Tab (out)');
  await key('Shift+Tab', 'Shift+Tab');

  await key('End');
  await page.keyboard.press('Shift+F10');
  await poll(() => app.evaluate(() => globalThis.__menuPopups.length > 0), { what: 'menu asked for' });
  const [popup] = await app.evaluate(() => globalThis.__menuPopups);
  const label = await page.evaluate(() => {
    const row = document.activeElement.closest('.tree-item');
    const l = row.querySelector('.label').getBoundingClientRect();
    return { x: Math.round(l.left), bottom: Math.round(row.getBoundingClientRect().bottom) };
  });
  console.log('menu at', JSON.stringify(popup), 'row label', JSON.stringify(label));

  // With the zoom at 125 % the menu still goes below the row.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25));
  await new Promise((r) => setTimeout(r, 300));
  await page.keyboard.press('Shift+F10');
  await poll(() => app.evaluate(() => globalThis.__menuPopups.length > 1), { what: 'second menu' });
  const zoomed = (await app.evaluate(() => globalThis.__menuPopups))[1];
  const zoomedLabel = await page.evaluate(() => {
    const row = document.activeElement.closest('.tree-item');
    const l = row.querySelector('.label').getBoundingClientRect();
    return { x: Math.round(l.left * 1.25), bottom: Math.round(row.getBoundingClientRect().bottom * 1.25) };
  });
  console.log('zoomed menu', JSON.stringify(zoomed), 'expected about', JSON.stringify(zoomedLabel));
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
