// Look instead of trust (#1194, step 2c): starts the real app and shows the
// notice the desktop gets when the phone opened another folder — as main
// pushes it — light and dark. Not a test — a look.
//
//   node e2e/manual-remote-switch-notice.mjs [en|de]
//
// Result: out/mockup/remote-switch-notice-<locale>-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
await mkdir(SHOTS, { recursive: true });

const model = await startFakeModel();
const workspace = await makeTempDir('garden-planner-');
const userDataDir = await makeTempDir('snotra-switch-notice-userdata-');
await writeFile(path.join(workspace, 'README.md'), '# Garden Planner\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');

const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;
await page.setViewportSize({ width: 1280, height: 760 }).catch(() => {});

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'the tree' });
  const folder = path.basename(workspace);
  await app.evaluate(({ BrowserWindow }, notice) => {
    BrowserWindow.getAllWindows()[0].webContents.send('notices:posted', notice);
  }, { id: 'remote-workspace-switched', kind: 'remote-workspace-switched', folder, location: null, canReveal: false });
  await poll(() => page.evaluate(() => !!document.querySelector('.app-notice')), { what: 'the notice' });
  const shown = await page.evaluate(() => ({
    heading: document.querySelector('.app-notice-heading')?.textContent,
    text: document.querySelector('.app-notice-text')?.textContent,
    tone: document.querySelector('.app-notice')?.className,
    actions: document.querySelectorAll('.app-notice-actions').length,
  }));
  console.log(JSON.stringify(shown, null, 2));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `remote-switch-notice-${locale}-light.png`) });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `remote-switch-notice-${locale}-dark.png`) });
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
