// Look instead of trust: every state of the content pane in the real app,
// light and dark (#225). Not a test — a look, and a before/after comparison:
// run it once on `main` and once on the branch, and the screenshots of the
// middle column have to match.
//
//   node e2e/manual-file-views.mjs [label]
//
// Result: out/mockup/file-views-<label>-<state>-<theme>.png, label defaults to
// "current". The file dates are pinned, so the info card reads the same on
// every run.

import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const label = process.argv[2] || 'current';
const SHOTS = path.resolve('out/mockup');
const PINNED = new Date('2026-09-20T14:32:00');

const README = [
  '# Example project',
  '',
  'A short README, the way most workspaces have one.',
  '',
  '- one',
  '- two',
  '',
].join('\n');
const LONG = Array.from({ length: 80 }, (_, i) =>
  `${String(i + 1).padStart(3, '0')} ${'filler text without a single line break '.repeat(12)}`
).join('\n');

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-file-views-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-file-views-userdata-'));
await mkdir(SHOTS, { recursive: true });

const files = {
  'README.md': README,
  'empty.txt': '',
  'long-lines.txt': LONG,
  'big.log': 'x'.repeat(1024 * 1024 + 1),
  'photo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};
for (const [name, content] of Object.entries(files)) {
  const file = path.join(workspace, name);
  await writeFile(file, content);
  await utimes(file, PINNED, PINNED);
}

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

const pane = () =>
  page.evaluate(() => ({
    preview: !document.getElementById('file-preview').classList.contains('hidden'),
    info: !document.getElementById('file-info').classList.contains('hidden'),
    name: document.getElementById('preview-filename').textContent,
    size: document.getElementById('info-size').textContent,
    text: document.getElementById('preview-content')?.textContent ?? null,
  }));

async function open(name, expect) {
  await page.evaluate((fileName) => {
    [...document.querySelectorAll('#tree-container .tree-item')]
      .find((el) => el.querySelector('.label')?.textContent === fileName)
      ?.click();
  }, name);
  await poll(async () => expect(await pane()), { what: `pane for ${name}` });
  await new Promise((r) => setTimeout(r, 200));
}

async function shoot(state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => {
      if (th === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
    }, theme);
    await new Promise((r) => setTimeout(r, 150));
    await page.locator('#content').screenshot({ path: path.join(SHOTS, `file-views-${label}-${state}-${theme}.png`) });
  }
}

try {
  await poll(
    async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
    { what: 'tree' }
  );

  await open('README.md', (s) => s.preview && s.name === 'README.md' && s.text === README);
  await shoot('text');

  await open('long-lines.txt', (s) => s.preview && s.name === 'long-lines.txt');
  await shoot('long-lines');
  // Scroll the long file, then switch: the next file must start at the top.
  await page.evaluate(() => {
    const pre = document.getElementById('preview-content');
    pre.scrollTop = 400;
    pre.scrollLeft = 300;
  });

  await open('empty.txt', (s) => s.preview && s.name === 'empty.txt');
  await shoot('empty');

  await open('big.log', (s) => s.info && s.size !== '' && s.size !== '1.0 MB');
  await shoot('too-large');
  console.log('too large:', (await pane()).size);

  await open('photo.png', (s) => s.info && s.size === '8 B');
  await shoot('binary');

  await open('long-lines.txt', (s) => s.preview && s.name === 'long-lines.txt');
  console.log('scroll after switching back:', await page.evaluate(() => {
    const pre = document.getElementById('preview-content');
    return { top: pre.scrollTop, left: pre.scrollLeft };
  }));

  // Written from outside while open — the watcher path of #158 / #73.
  await open('README.md', (s) => s.preview && s.name === 'README.md');
  await writeFile(path.join(workspace, 'README.md'), `${README}- three, written from outside\n`);
  await poll(async () => (await pane()).text?.includes('three'), { what: 'README reloaded' });
  await shoot('rewritten');

  // Grows past the limit while open: until now the old text simply stayed.
  await writeFile(path.join(workspace, 'README.md'), 'y'.repeat(1024 * 1024 + 1));
  await poll(async () => (await pane()).info, { what: 'README too large now' }).catch(() => {});
  console.log('grown past the limit:', await pane());
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
