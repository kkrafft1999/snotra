// Look instead of trust: comments in the Markdown preview (#1388), every
// state in the real app, light and dark. Not a test — the smoke test checks
// what must hold; this one produces the pictures for the pull request and
// prints what a picture cannot show (the file on disk, focus, positions).
//
//   node e2e/manual-markdown-comments.mjs [label] [locale]
//
// Result: out/mockup/md-comments-<label>-<state>-<theme>.png, label defaults
// to "current", locale to "en".

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const label = process.argv[2] || 'current';
const locale = process.argv[3] || 'en';
const SHOTS = path.resolve('out/mockup');

const CONCEPT = [
  '# Release concept',
  '',
  'The release goes through a pull request, and the tag starts the pipeline.',
  'Every artifact is signed before it is {==published to GitHub==}{>>Grace Hopper, 2026-11-12: Also on the website?<<}.',
  '',
  '## Open points',
  '',
  '- Decide on **the version scheme** for the beta channel.',
  '- Write the release notes in [both languages](./notes.md).',
  '',
  '| Platform | Signed |',
  '|---|---|',
  '| macOS | yes |',
  '| Windows | since 1.27 |',
  '',
  'Run `npm run release` to start.',
  '',
].join('\n');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-md-comments-');
const userDataDir = await makeTempDir('snotra-md-comments-userdata-');
await mkdir(SHOTS, { recursive: true });
const conceptPath = path.join(workspace, 'concept.md');
await writeFile(conceptPath, CONCEPT);

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'),
  JSON.stringify({ appLocale: locale, commentAuthor: 'Ada Lovelace' }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

async function shoot(state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => {
      if (th === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
    }, theme);
    await new Promise((r) => setTimeout(r, 150));
    await page.locator('#content').screenshot({ path: path.join(SHOTS, `md-comments-${label}-${state}-${theme}.png`) });
  }
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
}

/** Selects `text` inside the first element matching `selector`, as a mouse would. */
async function select(selector, text) {
  await page.evaluate(({ sel, needle }) => {
    const el = document.querySelector(sel);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(needle);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      document.querySelector('.md-view').focus();
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`not found: ${needle}`);
  }, { sel: selector, needle: text });
  await poll(async () => page.evaluate(() => document.querySelector('.md-comment-action')?.hidden === false), { what: 'comment button' });
}

try {
  await poll(
    async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
    { what: 'tree' }
  );
  await page.setViewportSize?.({ width: 1440, height: 900 });
  await page.evaluate(() => {
    [...document.querySelectorAll('#tree-container .tree-item')]
      .find((el) => el.querySelector('.label')?.textContent === 'concept.md')?.click();
  });
  await poll(async () => page.evaluate(() => Boolean(document.querySelector('.md-doc mark.md-comment'))), { what: 'preview' });
  await shoot('existing');
  console.log('blocks traced:', await page.evaluate(() => document.querySelectorAll('.md-doc [data-md-range]').length));

  // The comment that is there, opened by keyboard.
  await page.focus('.md-comment-marker');
  await page.keyboard.press('Enter');
  await poll(async () => page.evaluate(() => Boolean(document.querySelector('.md-comment-popover--view'))), { what: 'comment popover' });
  await shoot('view');
  console.log('focus in view:', await page.evaluate(() => document.activeElement?.className));
  await page.keyboard.press('Escape');
  console.log('focus after Escape:', await page.evaluate(() => document.activeElement?.className));

  // A selection, the button, the form.
  await select('.md-doc li', 'the version scheme');
  await shoot('action');
  console.log('button vs selection:', await page.evaluate(() => {
    const button = document.querySelector('.md-comment-action').getBoundingClientRect();
    const range = document.getSelection().getRangeAt(0).getBoundingClientRect();
    return { buttonTop: Math.round(button.top), selectionBottom: Math.round(range.bottom), buttonRight: Math.round(button.right), selectionRight: Math.round(range.right) };
  }));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+KeyM' : 'Control+Alt+KeyM');
  await poll(async () => page.evaluate(() => Boolean(document.querySelector('.md-comment-popover--compose'))), { what: 'form by shortcut' });
  await page.keyboard.type('Semantic versioning, or a date?');
  await shoot('compose');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await poll(async () => (await readFile(conceptPath, 'utf8')).includes('Semantic versioning'), { what: 'file written' });
  await poll(async () => page.evaluate(() => document.querySelectorAll('.md-doc mark.md-comment').length === 2), { what: 'second comment rendered' });
  await shoot('saved');
  const written = await readFile(conceptPath, 'utf8');
  console.log('line on disk:', written.split('\n').find((line) => line.includes('Semantic')));

  // A table cell, then something that is refused.
  await select('.md-doc tbody tr:last-child td:last-child', 'since 1.27');
  await page.click('.md-comment-action');
  await poll(async () => page.evaluate(() => Boolean(document.querySelector('.md-comment-popover--compose'))), { what: 'form in table' });
  await page.keyboard.type('Check the date');
  await page.click('.md-comment-popover button[type="submit"]');
  await poll(async () => (await readFile(conceptPath, 'utf8')).includes('Check the date'), { what: 'table comment written' });
  console.log('table row on disk:', (await readFile(conceptPath, 'utf8')).split('\n').find((line) => line.includes('Check the date')));

  await select('.md-doc p code', 'npm run release');
  await page.click('.md-comment-action');
  await new Promise((r) => setTimeout(r, 200));
  await shoot('refused');
  console.log('notice:', await page.evaluate(() => document.querySelector('.md-notice').textContent));
} catch (err) {
  console.error('FAILED:', err.message);
  console.log('notice at failure:', await page.evaluate(() => document.querySelector('.md-notice')?.textContent).catch(() => null));
  process.exitCode = 1;
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
