// Look instead of trust (#676): starts the real app on a folder called
// `snotra-promotion` and photographs where the workspace is named — title bar,
// switcher with its path, the `⋯` menu, the eraser next to it, a narrow
// sidebar and a hidden one — light and dark. Prints what was measured. Not a
// test — a look.
//
//   node e2e/manual-workspace-header.mjs [en|de]
//
// Result: out/mockup/workspace-header-<locale>-<state>-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const pause = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const model = await startFakeModel();
const parent = await makeTempDir('snotra-workspace-header-');
const workspace = path.join(parent, 'snotra-promotion');
const userDataDir = await makeTempDir('snotra-workspace-header-userdata-');
await mkdir(SHOTS, { recursive: true });
for (const dir of ['public', 'scripts', '.github']) await mkdir(path.join(workspace, dir), { recursive: true });
for (const file of ['index.html', 'firebase.json', 'README.md', '.firebaserc']) {
  await writeFile(path.join(workspace, file), '\n', 'utf8');
}

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

async function shoot(state, { width = 720, height = 260 } = {}) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause();
    await page.screenshot({
      path: path.join(SHOTS, `workspace-header-${locale}-${state}-${theme}.png`),
      clip: { x: 0, y: 0, width, height },
    });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const measure = () => page.evaluate(() => {
  const box = (id) => document.getElementById(id)?.getBoundingClientRect();
  const text = (id) => document.getElementById(id)?.textContent;
  const shown = (id) => {
    const el = document.getElementById(id);
    return Boolean(el) && el.getClientRects().length > 0;
  };
  return {
    title: document.title,
    titlebar: text('titlebar-workspace-name'),
    name: text('project-name'),
    path: shown('project-path') ? text('project-path') : `(narrow) ${text('project-path-narrow')}`,
    label: document.getElementById('btn-workspace').getAttribute('aria-label'),
    treeHeader: Math.round(box('tree-header').height),
    chatHeader: Math.round(box('chat-header')?.height ?? 0),
    switcher: `${Math.round(box('btn-workspace').width)}x${Math.round(box('btn-workspace').height)}`,
    actions: `${Math.round(box('btn-tree-actions').width)}x${Math.round(box('btn-tree-actions').height)}`,
  };
});
const log = async (label) => console.log(label.padEnd(14), JSON.stringify(await measure()));

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  await pause(500);
  console.log('window title'.padEnd(14), await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()));
  await log('default');
  await shoot('default');

  await page.click('#btn-workspace');
  await pause();
  await shoot('switcher-open', { height: 360 });
  await page.keyboard.press('Escape');

  await page.click('#btn-tree-actions');
  await pause();
  await shoot('actions-open', { height: 320 });
  await page.keyboard.press('Escape');

  // The shield (#398) stands once the sandbox state is known, which the fake
  // setup does not report; shown by hand, in its amber "not isolated" state.
  await page.evaluate(() => {
    const shield = document.getElementById('btn-tree-sandbox');
    shield.hidden = false;
    shield.dataset.unisolated = 'true';
  });
  await pause();
  await log('with shield');
  await shoot('shield');

  // The eraser stands only with marks of a run; shown by hand for the look.
  await page.evaluate(() => { document.getElementById('btn-tree-clear-marks').hidden = false; });
  await pause();
  await log('with eraser');
  await shoot('eraser');

  await page.evaluate(() => { document.getElementById('sidebar').style.width = '180px'; });
  await pause(400);
  await log('narrow+eraser');
  await shoot('narrow-eraser');
  await page.evaluate(() => { document.getElementById('btn-tree-clear-marks').hidden = true; });
  await pause(400);
  await log('narrow');
  await shoot('narrow');

  await page.focus('#btn-workspace');
  await page.keyboard.press('Enter');
  await pause();
  await shoot('narrow-switcher-open', { height: 360 });
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.getElementById('sidebar').style.width = ''; });

  await page.click('#btn-toggle-sidebar');
  await page.mouse.move(400, 300);
  await pause(500);
  await shoot('sidebar-hidden', { height: 120 });
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
