// Look rather than trust (#943): starts the real app and shows the update
// dialog for a check that GitHub's rate limit turned away — in both
// languages, light and dark. Not a test — a look.
//
//   node e2e/manual-update-check-failed.mjs
//
//   out/mockup/update-check-failed-<locale>-<theme>.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-update-check-failed-ws-');
const userDataDir = await makeTempDir('snotra-update-check-failed-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

async function applyLocale(locale) {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() =>
    !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'open settings dialog' });
  await wait(300);
  await page.evaluate(() =>
    document.querySelector('.settings-nav-item[data-settings-panel="general"]').click());
  await wait(200);
  await page.evaluate((value) => {
    const input = document.querySelector(`#choice-app-locale input[value="${value}"]`);
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, locale);
  await wait(400);
  await page.evaluate(() => document.getElementById('btn-settings-close').click());
  await wait(300);
}

try {
  await poll(() => page.evaluate(() =>
    document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });

  for (const locale of ['en', 'de']) {
    await applyLocale(locale);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await app.evaluate(({ BrowserWindow }, resetTime) => {
        BrowserWindow.getAllWindows()[0].webContents.send('update:available', {
          updateAvailable: false,
          manual: true,
          currentVersion: '1.21.1',
          releaseUrl: 'https://github.com/kkrafft1999/snotra/releases/latest',
          error: { key: 'update.error.rateLimited', params: { resetTime } },
        });
      }, Date.now() + 9 * 60 * 1000);
      await poll(() => page.evaluate(() =>
        !document.getElementById('modal-update').classList.contains('hidden')),
        { what: 'open update dialog' });
      await wait(400);
      console.log(`=== ${locale}/${theme} ===`);
      console.log(await page.evaluate(() => document.getElementById('modal-update-title').textContent + ' — ' + document.getElementById('modal-update-summary').textContent));
      await page.screenshot({ path: path.join(SHOTS, `update-check-failed-${locale}-${theme}.png`) });
      await page.evaluate(() => document.getElementById('modal-update-close').click());
      await wait(300);
    }
  }
  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop();
  await model.close();
}
