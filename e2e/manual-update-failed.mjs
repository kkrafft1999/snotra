// Look rather than trust (#442): starts the real app and shows the update
// dialog after a Windows swap that failed on the last quit — in both
// languages, light and dark. Not a test — a look.
//
//   node e2e/manual-update-failed.mjs
//
//   out/mockup/update-failed-<locale>-<theme>.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-update-failed-ws-');
const userDataDir = await makeTempDir('snotra-update-failed-userdata-');
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
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send('update:available', {
          updateAvailable: true,
          manual: false,
          currentVersion: '1.12.1',
          latestVersion: '1.13.0',
          isPrerelease: false,
          releaseUrl: 'https://github.com/kkrafft1999/snotra/releases',
          notes: '- Windows self-update no longer leaves the old version in place',
          canSelfUpdate: true,
          installKind: 'windows-dir',
          asset: { name: 'Snotra Agent-win32-x64-1.13.0.zip', size: 131_000_000 },
          lastInstallFailure: {
            version: '1.13.0',
            error: 'The process cannot access the file because it is being used by another process.',
            logFile: 'C:\\Users\\konrad\\AppData\\Roaming\\Snotra Agent\\update-install.log',
          },
        });
      });
      await poll(() => page.evaluate(() =>
        !document.getElementById('modal-update').classList.contains('hidden')),
        { what: 'open update dialog' });
      await wait(400);
      console.log(`=== ${locale}/${theme} ===`);
      console.log(await page.evaluate(() => document.getElementById('modal-update-hint').textContent));
      await page.screenshot({ path: path.join(SHOTS, `update-failed-${locale}-${theme}.png`) });
      await page.evaluate(() => document.getElementById('modal-update-close').click());
      await wait(300);
    }
  }
  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop();
  await model.close();
}
