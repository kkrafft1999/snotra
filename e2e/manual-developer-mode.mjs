// Look instead of trust (#1213): starts the real app, presses the developer
// mode shortcut and photographs the notice and the settings' navigation with
// the Developer chip, light and dark. Not a test — a look.
//
//   node e2e/manual-developer-mode.mjs [en|de]
//
// Result: out/mockup/developer-mode-<locale>-{notice,nav}-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
await mkdir(SHOTS, { recursive: true });
const model = await startFakeModel();
const workspace = await makeTempDir('garden-planner-');
const userDataDir = await makeTempDir('snotra-devmode-look-userdata-');
await writeFile(path.join(workspace, 'README.md'), '# Garden Planner\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;
await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});

async function both(name, shoot) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme);
    await page.waitForTimeout(250);
    await shoot(path.join(SHOTS, `developer-mode-${locale}-${name}-${theme}.png`));
  }
}

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0), { what: 'the tree' });
  await app.evaluate(({ BrowserWindow }, platform) => {
    BrowserWindow.getAllWindows()[0].webContents.emit('before-input-event', { preventDefault() {} }, {
      type: 'keyDown', code: 'KeyD', key: 'Î', shift: true, alt: true, isAutoRepeat: false,
      meta: platform === 'darwin', control: platform !== 'darwin',
    });
  }, process.platform);
  await poll(() => page.evaluate(() => !!document.querySelector('.app-notice[data-notice-id="developer-mode"]')), { what: 'the notice' });
  await both('notice', (file) => page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1280, height: 160 } }));
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /^(Einstellungen|Settings)/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')), { what: 'settings' });
  await page.evaluate(() => document.getElementById('tab-settings-remote').click());
  await both('nav', (file) => page.locator('.settings-dialog').screenshot({ path: file }));
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
