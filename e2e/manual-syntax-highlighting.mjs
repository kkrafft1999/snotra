// Look instead of trust: syntax highlighting in the file preview (#745), in
// the real app, light and dark. Not a test — screenshots of the middle column
// for a few typical languages, plus the Source mode of a Markdown file and a
// large file that is coloured after the first paint.
//
//   node e2e/manual-syntax-highlighting.mjs
//
// Result: out/mockup/syntax-<file>-<theme>.png, and on the console how long
// the large file stayed plain before its colours came.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');

const FILES = {
  'cart.ts': [
    '// Totals for the cart, in cents (#745 sample).',
    'export interface Item { name: string; price: number; tags?: string[] }',
    '',
    'export function total(items: Item[], discount = 0): number {',
    '  const sum = items.reduce((acc, item) => acc + item.price, 0);',
    '  if (sum < 0) throw new RangeError(`negative total: ${sum}`);',
    '  return Math.round(sum * (1 - discount));',
    '}',
    '',
  ].join('\n'),
  'settings.json': '{\n  "theme": "dark",\n  "fontSize": 14,\n  "autosave": true,\n  "recent": ["notes.md", null]\n}\n',
  'ci.yml': '# Required checks\nname: CI\non:\n  pull_request:\n    branches: [main]\njobs:\n  test:\n    runs-on: ${{ matrix.os }}\n    timeout-minutes: 30\n',
  'budget.py': [
    'from dataclasses import dataclass',
    '',
    '@dataclass(frozen=True)',
    'class Line:',
    '    item: str',
    '    amount: float = 0.0',
    '',
    '    def label(self) -> str:',
    '        return f"{self.item}: {self.amount:.2f} €"  # rounded',
    '',
  ].join('\n'),
  'release.sh': '#!/usr/bin/env bash\nset -euo pipefail\nVERSION=$(node -p "require(\'./package.json\').version")\nfor f in dist/*; do\n  echo "upload $f for v${VERSION}"\ndone\n',
  'page.html': '<!doctype html>\n<section class="card" data-id="7">\n  <h1>Preview &amp; Source</h1>\n  <script>const n = 42;</script>\n  <style>.card { padding: 12px; }</style>\n</section>\n',
  'notes.md': '# Release notes\n\nA **local** assistant. Run `npm ci`, then:\n\n```js\nconst app = await import("./main.js");\n```\n\n- [Docs](https://github.com/kkrafft1999/snotra)\n',
};
const BIG_LINE = 'export function add(a, b) { return a + b; } // sum of two numbers\n';
FILES['big.js'] = BIG_LINE.repeat(Math.ceil((300 * 1024) / BIG_LINE.length));

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-syntax-');
const userDataDir = await makeTempDir('snotra-syntax-userdata-');
await mkdir(SHOTS, { recursive: true });
for (const [name, content] of Object.entries(FILES)) await writeFile(path.join(workspace, name), content);

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

async function open(name) {
  await page.evaluate((fileName) => {
    [...document.querySelectorAll('#tree-container .tree-item')]
      .find((el) => el.querySelector('.label')?.textContent === fileName)
      ?.click();
  }, name);
  await poll(() => page.evaluate((fileName) => document.getElementById('preview-filename').textContent === fileName
    && !!document.querySelector('#preview-body > .file-view'), name), { what: `preview of ${name}` });
}

async function shoot(label) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => {
      if (th === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
    }, theme);
    await new Promise((r) => setTimeout(r, 150));
    await page.locator('#content').screenshot({ path: path.join(SHOTS, `syntax-${label}-${theme}.png`) });
  }
}

try {
  await poll(async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
    { what: 'tree' });

  for (const name of ['cart.ts', 'settings.json', 'ci.yml', 'budget.py', 'release.sh']) {
    await open(name);
    await poll(() => page.evaluate(() => document.getElementById('preview-content')?.dataset.highlighted === 'true'),
      { what: `${name} coloured` });
    await shoot(name.replace('.', '-'));
  }

  // Markdown and HTML open rendered; their Source mode is the coloured text.
  for (const name of ['notes.md', 'page.html']) {
    await open(name);
    await poll(() => page.evaluate(() => {
      const source = document.querySelector('#preview-tools input[value="source"]');
      source?.click();
      return document.getElementById('preview-content')?.dataset.highlighted === 'true';
    }), { what: `${name} source coloured` });
    await shoot(`${name.replace('.', '-')}-source`);
  }

  // How long the large file stayed plain, measured in the page itself.
  const timing = await page.evaluate((fileName) => new Promise((resolve) => {
    const started = performance.now();
    let plainSeen = false;
    const check = () => {
      const pre = document.getElementById('preview-content');
      const shown = document.getElementById('preview-filename').textContent === fileName && pre;
      if (shown && pre.dataset.highlighted === 'false') plainSeen = true;
      if (shown && pre.dataset.highlighted === 'true') {
        resolve({ plainSeen, colouredAfterMs: Math.round(performance.now() - started) });
        return;
      }
      requestAnimationFrame(check);
    };
    [...document.querySelectorAll('#tree-container .tree-item')]
      .find((el) => el.querySelector('.label')?.textContent === fileName)?.click();
    check();
  }), 'big.js');
  console.log(`big.js (${Math.round(FILES['big.js'].length / 1024)} KB): plain first: ${timing.plainSeen}, coloured ${timing.colouredAfterMs} ms after the click`);
  await shoot('big-js');
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
