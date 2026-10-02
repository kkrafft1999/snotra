// Look instead of trust (#347): starts the real app, lets the fake model read
// two files and write three — one deep inside a closed folder, one with a long
// name — and photographs the tree: right after the run, with a changed file
// opened, under the pointer, and after "clear", light and dark. Not a test —
// a look.
//
//   node e2e/manual-agent-marks.mjs [en|de]
//
// Result: out/mockup/agent-marks-<locale>-<state>-{light,dark}.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const LONG = 'a-very-long-file-name-that-does-not-fit-into-the-sidebar.test.js';

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-marks-look-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-marks-look-userdata-'));
await mkdir(SHOTS, { recursive: true });

for (const dir of ['src', 'docs/guide']) await mkdir(path.join(workspace, dir), { recursive: true });
const files = {
  'README.md': '# Example\n',
  'package.json': '{}\n',
  'src/app.js': 'console.log(1);\n',
  'src/styles.css': 'body {}\n',
  'src/tokens.css': ':root {}\n',
  'docs/guide/intro.md': '# Intro\n',
};
for (const [rel, content] of Object.entries(files)) {
  await writeFile(path.join(workspace, rel), content, 'utf8');
}

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

const rowSelector = (rel) => `#tree-container .tree-item[data-path$="${path.sep}${rel.split('/').join(path.sep)}"]`;

async function shoot(state) {
  const box = await page.locator('#sidebar').boundingBox();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({
      path: path.join(SHOTS, `agent-marks-${locale}-${state}-${theme}.png`),
      clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 420) },
    });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const describe = () => page.evaluate(() => ({
  clearButton: !document.getElementById('btn-tree-clear-marks').hidden,
  rows: [...document.querySelectorAll('#tree-container .tree-item')].map((row) => {
    const mark = row.querySelector(':scope > .tree-mark');
    const visible = mark && getComputedStyle(mark).display !== 'none';
    return `${row.querySelector('.label').textContent}${visible ? ` [${mark.textContent}:${mark.dataset.mark}] ${mark.getAttribute('aria-label')}` : ''}`;
  }),
}));

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });

  model.queueAnswer({
    match: 'Look at the project',
    toolCalls: [
      { name: 'read_file_text', arguments: { relative_path: 'README.md' } },
      { name: 'read_file_text', arguments: { relative_path: 'src/styles.css' } },
      { name: 'write_file_text', arguments: { relative_path: 'src/app.js', content: 'console.log(2);\n' } },
      { name: 'write_file_text', arguments: { relative_path: 'docs/guide/intro.md', content: '# Intro, revised\n' } },
      { name: 'write_file_text', arguments: { relative_path: `src/${LONG}`, content: 'test();\n' } },
    ],
  });
  model.queueAnswer({ text: 'Done.' });
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = 'Look at the project and tidy it up.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  });

  // Approve every write as it asks, until the run is through.
  await poll(async () => {
    await page.evaluate(() => {
      const allow = document.querySelector('.chat-approval-card button[data-response="allow-once"]:not([disabled])');
      allow?.click();
    });
    return page.evaluate(() =>
      !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')
      && document.querySelectorAll('#tree-container .tree-mark').length >= 3);
  }, { what: 'run through with marks', timeoutMs: 30000 });

  await page.click(rowSelector('src'));
  await poll(() => page.evaluate((sel) => Boolean(document.querySelector(sel)), rowSelector('src/app.js')),
    { what: 'src open' });
  await page.mouse.move(0, 0);
  await new Promise((r) => setTimeout(r, 300));
  console.log('after run', JSON.stringify(await describe(), null, 2));
  await shoot('after-run');

  await page.click(rowSelector('src/app.js'));
  await page.mouse.move(0, 0);
  await new Promise((r) => setTimeout(r, 400));
  console.log('opened', JSON.stringify(await describe(), null, 2));
  await shoot('opened');

  await page.hover(rowSelector('README.md'));
  await new Promise((r) => setTimeout(r, 300));
  await shoot('hover');

  await page.click('#btn-tree-clear-marks');
  await page.mouse.move(0, 0);
  await new Promise((r) => setTimeout(r, 300));
  console.log('cleared', JSON.stringify(await describe(), null, 2), 'focus:', await page.evaluate(() => document.activeElement?.id));
  await shoot('cleared');
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
