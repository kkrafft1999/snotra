// Hidden files in the running app (#436): the shortcut switches them on, the
// rows are dimmed, system noise stays out, a dot file opens as text, the View
// menu ticks along, and the switch is still on after a restart. The entry in
// the tree header's `⋯` menu (#676) switches them off again.
//
// Playwright's keyboard goes through the DevTools protocol and never reaches
// `before-input-event` — not even a plain letter (checked 2026-09-28). The
// test therefore hands the window the input Electron produces for the real
// key, with the colon a German keyboard types for Shift+period. Which inputs
// count is covered key by key in test/hidden-files.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

/** The shortcut as Electron reports it; true when the window swallowed it. */
const pressShortcut = (app) => app.evaluate(({ BrowserWindow }, platform) => {
  const input = {
    type: 'keyDown', code: 'Period', key: ':', shift: true, alt: false, isAutoRepeat: false,
    meta: platform === 'darwin', control: platform !== 'darwin',
  };
  let prevented = false;
  BrowserWindow.getAllWindows()[0].webContents.emit(
    'before-input-event', { preventDefault: () => { prevented = true; } }, input
  );
  return prevented;
}, process.platform);

const topLabels = (page) => page.evaluate(() => [...document.getElementById('tree-container').children]
  .filter((el) => el.classList.contains('tree-item'))
  .map((row) => row.querySelector('.label').textContent));

// Since #676 a check box in the tree header's `⋯` menu.
const pressed = (page) => page.evaluate(() =>
  document.querySelector('#tree-actions-menu [data-action="hidden-files"]').getAttribute('aria-checked'));

const menuChecked = (app) => app.evaluate(({ Menu }) =>
  Menu.getApplicationMenu()?.getMenuItemById('view.showHiddenFiles')?.checked ?? null);

async function waitForLabels(page, expected, what) {
  await poll(async () => JSON.stringify(await topLabels(page)) === JSON.stringify(expected), { what });
}

test('hidden files: shortcut, dimmed rows, text preview, menu and restart', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-hidden-');
  const userDataDir = await makeTempDir('snotra-hidden-userdata-');
  await mkdir(path.join(workspace, '.github', 'workflows'), { recursive: true });
  await mkdir(path.join(workspace, '.git'), { recursive: true });
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, '.github', 'workflows', 'ci.yml'), 'on: push\n', 'utf8');
  await writeFile(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await writeFile(path.join(workspace, '.env'), 'API_URL=http://localhost:8080\n', 'utf8');
  await writeFile(path.join(workspace, '.DS_Store'), 'noise', 'utf8');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await writeFile(path.join(workspace, 'src', 'app.js'), 'export {};\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

  let snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  let { page, app } = snotra;

  await waitForLabels(page, ['src', 'README.md'], 'tree without hidden files');
  assert.equal(await pressed(page), 'false');
  assert.equal(await menuChecked(app), false);

  // Names of one level line up, and a folder's children sit one level in
  // (#639). Measured here, with the real stylesheet: a file row once lost its
  // arrow's slot, and `app.js` stood where `src` did.
  await page.evaluate(() => [...document.querySelectorAll('#tree-container .tree-item')]
    .find((row) => row.querySelector('.label').textContent === 'src').click());
  await poll(() => page.evaluate(() => Boolean(document.querySelector('.tree-children.expanded .tree-item'))),
    { what: 'src opened' });
  const nameLeft = await page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('#tree-container .tree-item')].map((row) => {
      const label = row.querySelector('.label');
      return [label.textContent, label.getBoundingClientRect().left];
    })));
  assert.equal(nameLeft['README.md'], nameLeft.src, 'a file and a folder of one level');
  assert.equal(nameLeft['app.js'] - nameLeft.src, 16, 'a child one level in');

  // The shortcut: swallowed by the window, so page and menu never see it.
  assert.equal(await pressShortcut(app), true);
  await waitForLabels(page, ['.github', 'src', '.env', 'README.md'], 'tree with hidden files');
  assert.equal(await pressed(page), 'true');
  await poll(async () => (await menuChecked(app)) === true, { what: 'ticked View menu item' });

  // Dimmed: the hidden rows carry the class, and their names are lighter.
  const rows = await page.evaluate(() => [...document.querySelectorAll('#tree-container .tree-item')]
    .map((row) => ({
      name: row.querySelector('.label').textContent,
      hidden: row.classList.contains('tree-item--hidden'),
      colour: getComputedStyle(row.querySelector('.label')).color,
    })));
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
  assert.equal(byName['.github'].hidden, true);
  assert.equal(byName['.env'].hidden, true);
  assert.equal(byName['README.md'].hidden, false);
  assert.notEqual(byName['.env'].colour, byName['README.md'].colour, 'hidden rows are dimmed');

  // A dot file is text: it opens in the preview, not on the info card.
  await page.click('.tree-item[data-path$=".env"]');
  await poll(async () => (await page.evaluate(() => document.getElementById('preview-body')?.textContent ?? ''))
    .includes('API_URL=http://localhost:8080'), { what: '.env in the text preview' });

  // The switch survives a restart.
  const stored = JSON.parse(await readFile(path.join(userDataDir, 'ui-preferences.json'), 'utf8'));
  assert.equal(stored.showHiddenFiles, true);
  await snotra.stop();
  snotra = await launchApp({ userDataDir });
  ({ page, app } = snotra);
  await waitForLabels(page, ['.github', 'src', '.env', 'README.md'], 'hidden files after the restart');
  assert.equal(await pressed(page), 'true');
  await poll(async () => (await menuChecked(app)) === true, { what: 'ticked View menu item after the restart' });

  // The entry in the header's menu switches them off again, and the View
  // menu follows.
  await page.click('#btn-tree-actions');
  await page.click('#tree-actions-menu [data-action="hidden-files"]');
  await waitForLabels(page, ['src', 'README.md'], 'tree without hidden files again');
  assert.equal(await pressed(page), 'false');
  await poll(async () => (await menuChecked(app)) === false, { what: 'unticked View menu item' });
});
