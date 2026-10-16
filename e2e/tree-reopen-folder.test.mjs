// A folder that was opened and closed again catches up as it reopens (#1017).
//
// The case it was found by: a graphic committed in a worktree under
// `.claude/worktrees/`, then fast-forwarded into `main` in the main checkout
// while the app had that checkout open. The watcher reports the merge, but a
// report only reaches open folders — so the folder that was closed at that
// moment kept its old rows until the app was restarted. Real git, the real
// watcher: one folder open during the merge, one closed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

const treePaths = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#tree-container .tree-item')].map((row) => row.dataset.path));

const isOpen = (page, dirPath) => page.evaluate((p) =>
  document.querySelector(`#tree-container .tree-item[data-path="${CSS.escape(p)}"]`)
    ?.getAttribute('aria-expanded') === 'true', dirPath);

const clickRow = (page, rowPath) => page.evaluate((p) =>
  document.querySelector(`#tree-container .tree-item[data-path="${CSS.escape(p)}"]`)?.click(), rowPath);

test('a folder closed during a merge from a worktree shows the merged files when reopened', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-reopen-');
  const userDataDir = await makeTempDir('snotra-reopen-userdata-');
  t.after(() => model.close());

  git(workspace, 'init', '-q', '-b', 'main');
  git(workspace, 'config', 'user.email', 'e2e@example.invalid');
  git(workspace, 'config', 'user.name', 'e2e');
  git(workspace, 'config', 'commit.gpgsign', 'false');
  for (const dir of ['open', 'closed']) {
    await mkdir(path.join(workspace, dir, 'graphics'), { recursive: true });
    await writeFile(path.join(workspace, dir, 'graphics', 'old.svg'), '<svg/>\n', 'utf8');
  }
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'init');
  const worktree = path.join(workspace, '.claude', 'worktrees', 'feature');
  git(workspace, 'worktree', 'add', '-q', '-b', 'feature', worktree);

  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  const snotra = await launchApp({ userDataDir });
  t.after(() => snotra.stop().catch(() => {}));
  const { page } = snotra;

  const at = (...parts) => path.join(workspace, ...parts);
  await poll(async () => (await treePaths(page)).includes(at('open')), { what: 'the tree' });
  for (const dir of [['open'], ['open', 'graphics'], ['closed'], ['closed', 'graphics']]) {
    await clickRow(page, at(...dir));
    await poll(() => isOpen(page, at(...dir)), { what: `${dir.join('/')} open` });
  }
  await poll(async () => (await treePaths(page)).includes(at('closed', 'graphics', 'old.svg')),
    { what: 'closed/graphics listed' });
  // Loaded once, closed now: its rows stay in the page, out of view.
  await clickRow(page, at('closed', 'graphics'));
  await poll(async () => !(await isOpen(page, at('closed', 'graphics'))), { what: 'closed/graphics closed' });

  // When the watcher last reported, so the test can wait until it is done.
  await page.evaluate(() => {
    window.__lastTreeReport = 0;
    window.electronAPI.onFsTreeChanged(() => { window.__lastTreeReport = Date.now(); });
  });

  for (const dir of ['open', 'closed']) {
    await mkdir(path.join(worktree, dir, 'graphics', 'build'), { recursive: true });
    await writeFile(path.join(worktree, dir, 'graphics', 'new.svg'), '<svg>new</svg>\n', 'utf8');
    await writeFile(path.join(worktree, dir, 'graphics', 'build', 'make.py'), 'print(1)\n', 'utf8');
  }
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'graphic');
  git(workspace, 'merge', '--ff-only', '-q', 'feature');

  // The open folder shows the merge — proof that the report came and went.
  await poll(async () => (await treePaths(page)).includes(at('open', 'graphics', 'new.svg')),
    { what: 'open/graphics/new.svg after the merge' });
  assert.ok((await treePaths(page)).includes(at('open', 'graphics', 'build')));
  // The merge reports twice: its folders within half a second, and once more
  // about two seconds later with nothing to name (`complete: false`, measured
  // on macOS 2026-10-16). That second one checks every open folder, so if it
  // arrived after the reopening it would redraw the folder by itself and
  // hide the gap. Wait until the watcher has been quiet for three seconds:
  // in the case from #1017 the reports were long over when the folder was
  // opened again. A report later still makes this test prove less, never
  // fail; test/file-tree-dom.test.js covers the same without a watcher.
  await poll(() => page.evaluate(() => Date.now() - window.__lastTreeReport >= 3000),
    { what: 'the watcher quiet after the merge' });
  assert.equal(
    (await treePaths(page)).includes(at('closed', 'graphics', 'new.svg')), false,
    'closed, the folder still holds the rows it had'
  );

  await clickRow(page, at('closed', 'graphics'));
  await poll(async () => (await treePaths(page)).includes(at('closed', 'graphics', 'new.svg')),
    { what: 'closed/graphics/new.svg after reopening', timeoutMs: 5000 });
  const paths = await treePaths(page);
  assert.ok(paths.includes(at('closed', 'graphics', 'build')), 'the new folder too');
  assert.ok(paths.includes(at('closed', 'graphics', 'old.svg')), 'and what was there before');
  assert.equal(await isOpen(page, at('closed', 'graphics')), true);
});
