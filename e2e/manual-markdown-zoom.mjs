// Look instead of trust: the zoom of the Markdown preview (#829) in the real
// app, light and dark — at 100 % and 150 %, in a narrow column, and after a
// restart, which has to open at the size the user left. Prints where a long
// document stood before and after a zoom, which a picture does not show.
//
//   node e2e/manual-markdown-zoom.mjs [label]
//
// Result: out/mockup/markdown-zoom-<label>-<state>-<theme>.png, label
// defaults to "current".

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const label = process.argv[2] || 'current';
const SHOTS = path.resolve('out/mockup');

const GUIDE = [
  '# Release guide',
  '',
  'Every release goes through a pull request. The tag is pushed afterwards, and the pipeline builds the packages for all three platforms.',
  '',
  '## Steps',
  '',
  '1. Bump the version in `package.json`.',
  '2. Open the pull request and wait for the checks.',
  '3. Push the tag `vX.Y.Z`.',
  '',
  '| Platform | Artifact | Signed |',
  '| --- | --- | --- |',
  '| macOS | `.dmg` | yes |',
  '| Windows | `.exe` | yes |',
  '| Linux | `.AppImage` | no |',
  '',
  '```sh',
  'git tag v1.19.0 && git push origin v1.19.0',
  '```',
  '',
].join('\n');

const LONG = ['# A long document', '', ...Array.from({ length: 60 }, (_, i) =>
  `## Section ${i + 1}\n\nParagraph ${i + 1}, long enough to wrap in a column of ordinary width, so that a larger size changes where its lines break.\n`)].join('\n');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-md-zoom-');
const userDataDir = await makeTempDir('snotra-md-zoom-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'guide.md'), GUIDE);
await writeFile(path.join(workspace, 'long.md'), LONG);
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });

async function start() {
  const snotra = await launchApp({ userDataDir });
  const { page } = snotra;
  await poll(
    async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
    { what: 'tree' },
  );
  await page.setViewportSize?.({ width: 1440, height: 900 });
  return snotra;
}

async function open(page, name) {
  await page.evaluate((fileName) => {
    [...document.querySelectorAll('#tree-container .tree-item')]
      .find((el) => el.querySelector('.label')?.textContent === fileName)
      ?.click();
  }, name);
  await poll(async () => page.evaluate((fileName) =>
    document.getElementById('preview-filename').textContent === fileName && Boolean(document.querySelector('.md-doc h1')), name),
  { what: name });
  await new Promise((r) => setTimeout(r, 200));
}

const zoomValue = (page) => page.evaluate(() => document.querySelector('#preview-tools .pdf-tools__zoom')?.textContent ?? null);
const click = (page, which) => page.evaluate((sel) => document.querySelector(`#preview-tools ${sel}`).click(), which);

async function shoot(page, state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => {
      if (th === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
    }, theme);
    await new Promise((r) => setTimeout(r, 150));
    await page.locator('#content').screenshot({ path: path.join(SHOTS, `markdown-zoom-${label}-${state}-${theme}.png`) });
  }
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
}

/** The heading closest to the top edge of the preview. */
const topHeading = (page) => page.evaluate(() => {
  const view = document.querySelector('.md-view');
  const top = view.getBoundingClientRect().top;
  return [...view.querySelectorAll('h2')]
    .map((h) => [h.textContent, Math.abs(h.getBoundingClientRect().top - top)])
    .sort((a, b) => a[1] - b[1])[0]?.[0] ?? null;
});

let snotra = await start();
try {
  let { page } = snotra;
  await open(page, 'guide.md');
  console.log('opens at', await zoomValue(page));
  await shoot(page, '100');

  for (let i = 0; i < 3; i += 1) await click(page, '.pdf-tools__zoom-in');
  console.log('after three steps:', await zoomValue(page));
  await shoot(page, '150');

  // Keyboard: focus on the preview, ⌘− once.
  await page.focus('.md-view');
  await page.keyboard.press('Meta+Minus');
  console.log('after ⌘−:', await zoomValue(page), '— window zoom', await page.evaluate(() => window.devicePixelRatio));
  await page.keyboard.press('Meta+Equal');

  // A narrow content column: the header has to hold switch and zoom.
  await page.setViewportSize?.({ width: 980, height: 900 });
  await new Promise((r) => setTimeout(r, 300));
  console.log('narrow window:', await page.evaluate(() => {
    const header = document.getElementById('preview-header');
    const view = document.querySelector('.md-view');
    return {
      headerHeight: header.getBoundingClientRect().height,
      headerOverflow: header.scrollWidth - header.clientWidth,
      sideways: view.scrollWidth - view.clientWidth,
    };
  }));
  await shoot(page, 'narrow');
  await page.setViewportSize?.({ width: 1440, height: 900 });

  // Where a long document stands before and after a zoom.
  await open(page, 'long.md');
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll('.md-doc h2')].find((h) => h.textContent === 'Section 30');
    heading.scrollIntoView({ block: 'start' });
  });
  const before = await topHeading(page);
  await click(page, '.pdf-tools__zoom-out');
  await click(page, '.pdf-tools__zoom-out');
  console.log('long.md at the top:', before, '→', await topHeading(page), 'at', await zoomValue(page));

  const kept = await zoomValue(page);
  // The source has no zoom.
  await page.focus('.file-view-mode-switch input:checked');
  await page.keyboard.press('ArrowRight');
  console.log('zoom group in the source:', await page.evaluate(() => Boolean(document.querySelector('#preview-tools .md-zoom'))));
  await page.keyboard.press('ArrowLeft');

  await snotra.stop();
  snotra = await start();
  page = snotra.page;
  await open(page, 'guide.md');
  console.log('after a restart:', await zoomValue(page), '(left at', `${kept})`);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
