// Look instead of trust (#350): starts the real app, filters the file tree with
// the real keyboard — Cmd/Ctrl+P from the chat, typing, the arrows, Enter,
// Escape, typing into the focused tree — and photographs every state, light
// and dark: the empty field, matches, no match, the capped count, a very long
// path, a file that appears while the filter is open, and the tree afterwards.
// Not a test — a look.
//
//   node e2e/manual-tree-filter.mjs [en|de]
//
// Result: out/mockup/tree-filter-<locale>-<state>-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-tree-filter-');
const userDataDir = await makeTempDir('snotra-tree-filter-userdata-');
await mkdir(SHOTS, { recursive: true });

const LONG = 'packages/very-long-package-name-for-testing/src/components/deeply/nested/structure';
for (const dir of ['docs/guide', 'src/renderer/chat', 'src/renderer/components', 'test', 'gen', LONG]) {
  await mkdir(path.join(workspace, dir), { recursive: true });
}
const files = {
  'README.md': '# Example\n',
  'package.json': '{}\n',
  '.env.example': 'KEY=\n',
  'docs/guide/intro.md': '# Intro\n',
  'docs/index.md': '# Docs\n',
  'src/renderer/chat/mentionAutocomplete.js': 'export {};\n',
  'src/renderer/components/MentionAutocomplete.js': 'export {};\n',
  'test/mentions.test.js': '// test\n',
  [`${LONG}/AnExtraordinarilyLongComponentFileNameThatGoesOnAndOn.tsx`]: 'export {};\n',
};
for (let i = 0; i < 320; i += 1) files[`gen/record-${String(i).padStart(3, '0')}.json`] = '{}\n';
for (const [rel, content] of Object.entries(files)) {
  await writeFile(path.join(workspace, rel), content, 'utf8');
}

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;
const pause = (ms = 250) => new Promise((r) => setTimeout(r, ms));

async function shoot(state) {
  const box = await page.locator('#sidebar').boundingBox();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause();
    await page.screenshot({
      path: path.join(SHOTS, `tree-filter-${locale}-${state}-${theme}.png`),
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const state = () => page.evaluate(() => {
  const active = document.activeElement;
  const row = active?.closest?.('.tree-item');
  return {
    focus: row ? `row:${row.querySelector('.label').textContent}` : (active?.id || active?.tagName),
    open: !document.getElementById('tree-filter').hidden,
    query: document.getElementById('tree-filter-input').value,
    shown: document.querySelectorAll('.tree-filter-option').length,
    selected: document.querySelector('.tree-filter-option[aria-selected="true"]')?.dataset.path ?? null,
    status: document.getElementById('tree-filter-status').hidden ? null : document.getElementById('tree-filter-status').textContent,
    message: document.querySelector('.tree-filter-message')?.textContent ?? null,
    treeHidden: document.getElementById('tree-container').hidden,
    preview: document.querySelector('#content-pane .file-view-name, #content-pane [data-file-name]')?.textContent ?? null,
  };
});

async function log(label) {
  console.log(label.padEnd(16), JSON.stringify(await state()));
}

async function type(text) {
  await page.keyboard.type(text, { delay: 30 });
  await pause(400);
}

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  await shoot('closed');

  // Cmd/Ctrl+P from the chat input. Synthetic keys may not reach the menu's
  // key equivalents; then the menu item is clicked the way the menu would.
  await page.focus('#chat-input');
  await page.keyboard.press(`${MOD}+P`);
  await pause(400);
  let opened = await page.evaluate(() => !document.getElementById('tree-filter').hidden);
  if (!opened) {
    console.log('(shortcut did not reach the menu; clicking its item)');
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const find = (items) => {
        for (const item of items) {
          if (item.accelerator === 'CmdOrCtrl+P') return item;
          const inner = item.submenu && find(item.submenu.items);
          if (inner) return inner;
        }
        return null;
      };
      find(Menu.getApplicationMenu().items).click(undefined, BrowserWindow.getAllWindows()[0]);
    });
    await pause(400);
    opened = await page.evaluate(() => !document.getElementById('tree-filter').hidden);
  }
  await log('Cmd/Ctrl+P');
  await shoot('empty');

  await type('mention');
  await log('typed mention');
  await shoot('matches');

  await page.keyboard.press('ArrowDown');
  await pause();
  await page.keyboard.press('Enter');
  await pause(600);
  await log('Enter (file)');
  await shoot('opened');

  await page.keyboard.press(`${MOD}+A`);
  await type('zzqx');
  await log('no match');
  await shoot('no-match');

  await page.keyboard.press(`${MOD}+A`);
  await type('record');
  await log('capped');
  await shoot('capped');

  await page.keyboard.press(`${MOD}+A`);
  await type('extraordinarily');
  await log('long path');
  await shoot('long-path');

  // A file appears while the filter is open.
  await page.keyboard.press(`${MOD}+A`);
  await type('intro');
  await log('before write');
  await writeFile(path.join(workspace, 'docs/introduction-notes.md'), '# New\n', 'utf8');
  await poll(() => page.evaluate(() =>
    Boolean(document.querySelector('.tree-filter-option[data-path="docs/introduction-notes.md"]'))),
  { what: 'new file in the list', timeoutMs: 8000 });
  await log('after write');
  await shoot('appeared');

  await page.keyboard.press('Escape');
  await pause(400);
  await log('Escape');
  await shoot('after-escape');

  // Typing into the focused tree.
  await page.focus('#tree-container .tree-item[tabindex="0"]');
  await page.keyboard.press('d');
  await pause(400);
  await log('type-ahead d');
  await type('ocs/');
  await log('docs/');
  await page.keyboard.press('Enter');
  await pause(600);
  await log('Enter (folder)');
  await shoot('folder');
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
