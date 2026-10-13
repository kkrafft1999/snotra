// Look instead of trust (#923): the title bar with the folder on the left and
// the wordmark and version on the right, directly before the column switches
// — wide and narrow, light and dark. Prints what was measured. Not a test — a
// look.
//
//   node e2e/manual-titlebar.mjs [en|de]
//
// Result: out/mockup/titlebar-<locale>-<width>-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const pause = (ms = 300) => new Promise((r) => setTimeout(r, ms));

const model = await startFakeModel();
const parent = await makeTempDir('snotra-titlebar-');
const workspace = path.join(parent, 'Geschäftsführer - Allgemeines');
const userDataDir = await makeTempDir('snotra-titlebar-userdata-');
await mkdir(SHOTS, { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

const measure = () => page.evaluate(() => {
  const box = (sel) => document.querySelector(sel).getBoundingClientRect();
  const name = document.getElementById('titlebar-workspace-name');
  return {
    window: window.innerWidth,
    folderRight: Math.round(box('#titlebar-workspace').right),
    folderTruncated: name.scrollWidth > name.clientWidth,
    brandLeft: Math.round(box('.titlebar-app').left),
    brandRight: Math.round(box('.titlebar-app').right),
    switchesLeft: Math.round(box('#btn-toggle-chat-panel').left),
    version: document.getElementById('app-version').textContent,
  };
});

try {
  await poll(() => page.evaluate(() => !document.getElementById('titlebar-workspace').hidden
    && !document.getElementById('app-version').hidden), { what: 'workspace and version in the title bar' });

  for (const width of [1200, 900]) {
    await app.evaluate(({ BrowserWindow }, w) => {
      BrowserWindow.getAllWindows()[0].setSize(w, 700);
    }, width);
    await pause(500);
    console.log(width, JSON.stringify(await measure()));
    const actual = await page.evaluate(() => window.innerWidth);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await pause();
      await page.screenshot({
        path: path.join(SHOTS, `titlebar-${locale}-${width}-${theme}.png`),
        clip: { x: 0, y: 0, width: actual, height: 60 },
      });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  }
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
