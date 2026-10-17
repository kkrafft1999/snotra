// Look instead of trust (#978): starts the real app, throws on purpose in the
// window and in main, and photographs the background-error notice, light and
// dark. Then copies the diagnostics from the notice and from the Help menu,
// reads the log file, and crashes the window's page to see the reload offer.
// Not a test — a look.
//
//   node e2e/manual-background-error.mjs [en|de]
//
// Result: out/mockup/background-error-<locale>-{light,dark,narrow,copied}.png
// and what the run saw on the console.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
await mkdir(SHOTS, { recursive: true });

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-bg-error-look-');
const userDataDir = await makeTempDir('snotra-bg-error-look-userdata-');
await writeFile(path.join(workspace, 'README.md'), '# Garden Planner\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');

const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;
await page.setViewportSize({ width: 1280, height: 760 }).catch(() => {});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const noticeText = () => page.evaluate(() => document.querySelector('.app-notice-text')?.textContent ?? null);

try {
  // A clean start shows no notice: nothing in normal operation counts as an error.
  await pause(2500);
  console.log('notices after a clean start:', await page.evaluate(() => document.querySelectorAll('.app-notice').length));

  // One in the window, one in main.
  await page.evaluate(() => { setTimeout(() => { throw new Error('look: thrown in the window on purpose'); }, 0); });
  await poll(() => page.evaluate(() => !!document.querySelector('.app-notice')), { what: 'the notice' });
  console.log('after one:', await noticeText());
  await app.evaluate(() => { setTimeout(() => { throw new Error('look: thrown in main on purpose'); }, 0); });
  await app.evaluate(() => { void Promise.reject(new Error('look: rejected in main on purpose')); });
  await poll(async () => /\b3\b/.test(await noticeText() ?? ''), { what: 'the count of three', timeoutMs: 5000 });
  console.log('after three:', await noticeText());

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(300);
    await page.screenshot({ path: path.join(SHOTS, `background-error-${locale}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.setViewportSize({ width: 760, height: 640 }).catch(() => {});
  await pause(300);
  await page.screenshot({ path: path.join(SHOTS, `background-error-${locale}-narrow.png`) });
  await page.setViewportSize({ width: 1280, height: 760 }).catch(() => {});

  // Copy from the notice.
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await page.click('[data-action="copy-diagnostics"]');
  await pause(200);
  console.log('button after copy:', await page.evaluate(() => document.querySelector('[data-action="copy-diagnostics"]').textContent));
  await page.locator('#app-notices').screenshot({ path: path.join(SHOTS, `background-error-${locale}-copied.png`) });
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  console.log('--- clipboard (head) ---\n' + copied.split('\n').slice(0, 10).join('\n'));

  // The log file.
  const log = await readFile(path.join(userDataDir, 'logs', 'main.log'), 'utf8');
  console.log('--- main.log ---\n' + log.split('\n').filter((l) => !l.startsWith('    ')).join('\n'));

  // Help › Copy Diagnostics, with the box answered by a stub.
  await app.evaluate(({ dialog, Menu }) => {
    globalThis.__boxes = [];
    dialog.showMessageBox = async (...args) => { globalThis.__boxes.push(args.at(-1)); return { response: 0 }; };
    const help = Menu.getApplicationMenu().items.find((item) => item.role === 'help');
    globalThis.__helpLabels = help.submenu.items.map((item) => item.label || item.type);
    help.submenu.items[4].click();
  });
  await pause(300);
  console.log('Help menu:', JSON.stringify(await app.evaluate(() => globalThis.__helpLabels)));
  console.log('menu box:', JSON.stringify(await app.evaluate(() => globalThis.__boxes)));

  // The window's page dies: the reload offer, answered with Reload.
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__boxes = [];
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
  });
  await poll(() => app.evaluate(() => globalThis.__boxes.length > 0), { what: 'the reload offer', timeoutMs: 10000 });
  console.log('crash box:', JSON.stringify(await app.evaluate(() => globalThis.__boxes)));
  // Playwright's page stays crashed; ask the window itself.
  const loaded = () => app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    if (contents.isCrashed() || contents.isLoading()) return false;
    return contents.executeJavaScript("!!document.getElementById('tree-container')");
  }).catch(() => false);
  await poll(loaded, { what: 'the reloaded window', timeoutMs: 15000 });
  console.log('reloaded; notices shown again:', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]
    .webContents.executeJavaScript("document.querySelectorAll('.app-notice').length")));
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
