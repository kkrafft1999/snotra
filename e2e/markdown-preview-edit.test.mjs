// Editing a Markdown file in its preview (#1422), in the real app: the
// browser's editing commands behind the toolbar and the keys, Chromium's own
// ways with them — a heading put inside its paragraph, an inserted element
// merged into the text after it — and what reaches the disk. The states
// around it are covered in test/markdown-preview-edit-dom.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const NOTE = [
  '# Crop rotation',
  '',
  'Each bed changes its family every year.',
  'The south bed gets {==beans==}{>>Ada, 2026-11-14: or peas?<<} next.',
  '',
  '<!-- keep me -->',
  '',
  '* lettuce',
  '* tomatoes',
  '',
  '| Bed | Plant |',
  '|---|---|',
  '| north | lettuce |',
  '',
  'Order seeds soon.',
  '',
].join('\n');

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const saveState = (page) => page.evaluate(() => document.querySelector('.file-edit-status')?.dataset.state ?? null);

/** Puts the caret after `needle`, or selects it, in the first element under `selector` that holds it. */
function caret(page, selector, needle, { select = false, end = false } = {}) {
  return page.evaluate(({ selector, needle, select, end }) => {
    for (const el of document.querySelectorAll(selector)) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.indexOf(needle);
        if (at === -1) continue;
        const range = document.createRange();
        range.setStart(node, select ? at : (end ? at + needle.length : at));
        if (select) range.setEnd(node, at + needle.length);
        else range.collapse(true);
        document.querySelector('.md-doc').focus();
        document.getSelection().removeAllRanges();
        document.getSelection().addRange(range);
        return true;
      }
    }
    throw new Error(`"${needle}" not found in ${selector}`);
  }, { selector, needle, select, end });
}

test('a Markdown file is edited and formatted in its preview, and only the changed blocks are written', { timeout: 240000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-md-edit-');
  const userDataDir = await makeTempDir('snotra-md-edit-userdata-');
  const file = path.join(workspace, 'rotation.md');
  await writeFile(file, NOTE);
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page } = snotra;
  const disk = () => readFile(file, 'utf8');
  const saved = async (what) => {
    await page.keyboard.press(`${mod}+KeyS`);
    await poll(async () => (await saveState(page)) === 'saved', { what, timeoutMs: 10000 });
    return disk();
  };

  await poll(() => page.evaluate(() => {
    const row = [...document.querySelectorAll('#tree-container .tree-item')]
      .find((item) => item.getAttribute('aria-label') === 'rotation.md');
    row?.click();
    return Boolean(row);
  }), { what: 'tree row rotation.md' });
  await poll(() => page.evaluate(() => Boolean(document.querySelector('.md-doc h1'))), { what: 'preview' });
  await page.click('#preview-tools .file-edit-toggle');
  await poll(() => page.evaluate(() => Boolean(document.querySelector('.md-format-bar'))
    && document.querySelector('.md-doc').getAttribute('contenteditable') === 'true'), { what: 'editing' });
  assert.equal(await page.evaluate(() => document.querySelector('.md-table-frame').getAttribute('contenteditable')), 'false');

  // Typing, and bold from the toolbar.
  await caret(page, '.md-doc p', 'every year', { end: true });
  await page.keyboard.type(', at least');
  await caret(page, '.md-doc p', 'south bed', { select: true });
  await page.click('.md-format-bar__button[data-format="bold"]');
  assert.equal(await page.evaluate(() => document.querySelector('.md-format-bar__button[data-format="bold"]').getAttribute('aria-pressed')), 'true');
  // Inside the commented passage: the comment stays.
  await caret(page, '.md-doc mark', 'beans', { end: true });
  await page.keyboard.type(' and peas');
  let text = await saved('first save');
  assert.equal(text, NOTE
    .replace('every year.', 'every year, at least.')
    .replace('The south bed', 'The **south bed**')
    .replace('{==beans==}', '{==beans and peas==}'));

  // A new paragraph, made a heading through the select; code by its key.
  await caret(page, '.md-doc p', 'Order seeds soon.', { end: true });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Next year');
  await page.selectOption('.md-format-bar__block', 'h2');
  await caret(page, '.md-doc p', 'seeds', { select: true });
  await page.keyboard.press(`${mod}+KeyE`);
  text = await saved('heading and code');
  assert.ok(text.endsWith('Order `seeds` soon.\n\n## Next year\n'), text);

  // A list item more, italics by key, and the list made a checklist.
  await caret(page, '.md-doc ul', 'tomatoes', { end: true });
  await page.keyboard.press('Enter');
  await page.keyboard.type('beans');
  await caret(page, '.md-doc ul', 'lettuce', { select: true });
  await page.keyboard.press(`${mod}+KeyI`);
  await page.click('.md-format-bar__button[data-format="tasks"]');
  text = await saved('checklist');
  assert.ok(text.includes('* [ ] *lettuce*\n* [ ] tomatoes\n* [ ] beans\n'), text);

  // A link through the form.
  await caret(page, '.md-doc h1', 'rotation', { select: true });
  await page.keyboard.press(`${mod}+KeyK`);
  await poll(() => page.evaluate(() => document.activeElement?.classList.contains('md-link-popover__field')), { what: 'link form' });
  await page.keyboard.type('https://example.com/rotation');
  await page.keyboard.press('Enter');
  text = await saved('link');
  assert.ok(text.startsWith('# Crop [rotation](https://example.com/rotation)\n'), text);

  // What was not touched is as it was.
  assert.ok(text.includes('\n\n<!-- keep me -->\n\n'));
  assert.ok(text.includes('| Bed | Plant |\n|---|---|\n| north | lettuce |\n'));

  // Esc ends editing; the preview renders the file anew.
  await page.keyboard.press('Escape');
  await poll(() => page.evaluate(() => !document.querySelector('.md-format-bar')
    && !document.querySelector('.md-doc').hasAttribute('contenteditable')
    && document.querySelector('.md-doc h2')?.textContent === 'Next year'), { what: 'read-only again' });
  assert.equal(await disk(), text, 'leaving wrote nothing more');
});
