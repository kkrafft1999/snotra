// Back and forward through the files the preview showed (#822), in the real
// app: a link in a Markdown document and back again, the place the reader
// left, the tree following along, and the shortcut that main matches by the
// physical key.
//
// Playwright's keyboard never reaches `before-input-event` (see
// e2e/hidden-files.test.mjs); the test hands the window the input Electron
// produces for the real key — on a Mac with a German layout, the key in the
// place of `[` types `ü`. Which inputs count is covered in
// test/preview-history-main.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

/** The shortcut as Electron reports it; true when the window swallowed it. */
const pressShortcut = (app, direction) => app.evaluate(({ BrowserWindow }, { platform, direction }) => {
  const mac = platform === 'darwin';
  const back = direction === 'back';
  const input = {
    type: 'keyDown',
    code: mac ? (back ? 'BracketLeft' : 'BracketRight') : (back ? 'ArrowLeft' : 'ArrowRight'),
    key: mac ? (back ? 'ü' : '+') : (back ? 'ArrowLeft' : 'ArrowRight'),
    meta: mac, alt: !mac, control: false, shift: false, isAutoRepeat: false,
  };
  let prevented = false;
  BrowserWindow.getAllWindows()[0].webContents.emit(
    'before-input-event', { preventDefault: () => { prevented = true; } }, input
  );
  return prevented;
}, { platform: process.platform, direction });

const state = (page) => page.evaluate(() => {
  const button = (direction) => document.querySelector(`.preview-history__button[data-direction="${direction}"]`);
  return {
    file: document.getElementById('file-preview').classList.contains('hidden')
      ? null
      : document.getElementById('preview-filename').textContent,
    selected: document.querySelector('#tree-container .tree-item.active')?.dataset.path ?? null,
    scrollTop: document.querySelector('.md-view')?.scrollTop ?? null,
    back: button('back') ? { disabled: button('back').disabled, label: button('back').getAttribute('aria-label') } : null,
    forward: button('forward') ? { disabled: button('forward').disabled, label: button('forward').getAttribute('aria-label') } : null,
  };
});

test('a Markdown link and back again, with the place kept and the tree in step', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-history-');
  const userDataDir = await makeTempDir('snotra-history-userdata-');
  const filler = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}, there to scroll past.`).join('\n\n');
  await mkdir(path.join(workspace, 'docs'));
  await writeFile(path.join(workspace, 'README.md'), `# Garden\n\n${filler}\n\nSee [the setup](docs/setup.md).\n`);
  await writeFile(path.join(workspace, 'docs', 'setup.md'), '# Setup\n\nThen open [the config](../config.json).\n');
  await writeFile(path.join(workspace, 'config.json'), '{ "region": "Lake" }\n');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page } = snotra;
  const waitFor = (what, check) => poll(async () => {
    const s = await state(page);
    return check(s) ? s : null;
  }, { what });

  // The folder opens with its README (#351): the first entry, nowhere to go yet.
  let s = await waitFor('README shown', (x) => x.file === 'README.md' && x.back);
  assert.deepEqual([s.back.disabled, s.forward.disabled], [true, true]);

  // Scrolled down to the link, then followed.
  await page.evaluate(() => {
    const view = document.querySelector('.md-view');
    view.scrollTop = view.scrollHeight;
  });
  const scrolledTo = (await state(page)).scrollTop;
  assert.ok(scrolledTo > 200, `the README scrolls (${scrolledTo})`);
  await page.evaluate(() => document.querySelector('.md-doc a[data-link-kind="file"]').click());
  s = await waitFor('setup.md through the link', (x) => x.file === 'setup.md' && x.back && !x.back.disabled);
  assert.equal(s.selected, path.join(workspace, 'docs', 'setup.md'));
  // The label names the file it leads to, in whichever language the app runs.
  assert.match(s.back.label, / README\.md$/);
  assert.equal(s.forward.disabled, true);

  // ‹ goes back to the README, where the reader left it, and selects it.
  await page.evaluate(() => document.querySelector('.preview-history__button[data-direction="back"]').click());
  s = await waitFor('README again', (x) => x.file === 'README.md' && x.forward && !x.forward.disabled);
  assert.equal(s.selected, path.join(workspace, 'README.md'));
  assert.equal(s.back.disabled, true);
  assert.match(s.forward.label, / setup\.md$/);
  s = await waitFor('the place in the README kept', (x) => Math.abs(x.scrollTop - scrolledTo) <= 2);

  // The shortcut, matched by main on the physical key, goes forward again.
  assert.equal(await pressShortcut(snotra.app, 'forward'), true, 'the window takes the key');
  s = await waitFor('setup.md by the shortcut', (x) => x.file === 'setup.md');
  assert.equal(s.selected, path.join(workspace, 'docs', 'setup.md'));

  // On to the config through the next link; back twice, then a click in the
  // tree cuts off what lay ahead.
  await page.evaluate(() => document.querySelector('.md-doc a[data-link-kind="file"]').click());
  await waitFor('config.json through the link', (x) => x.file === 'config.json');
  assert.equal(await pressShortcut(snotra.app, 'back'), true);
  await waitFor('setup.md by the shortcut back', (x) => x.file === 'setup.md');
  await page.evaluate(() => document.querySelector('.preview-history__button[data-direction="back"]').click());
  await waitFor('README by the button', (x) => x.file === 'README.md' && !x.forward.disabled);
  await page.evaluate((target) => {
    document.querySelector(`#tree-container .tree-item[data-path="${CSS.escape(target)}"]`).click();
  }, path.join(workspace, 'config.json'));
  s = await waitFor('config.json from the tree', (x) => x.file === 'config.json');
  assert.equal(s.forward.disabled, true, 'a new step drops what lay ahead');
  assert.match(s.back.label, / README\.md$/);
});
