// Look instead of trust (#514): the two reset actions at the end of
// Settings › Security have one button each, and "Reset all permissions" asks
// in a native dialog instead of a second button on the page. Photographs the
// actions, light and dark, clicks "Reset all" with the dialog stubbed to
// "Cancel" and prints what the dialog would have said.
// Not a test — a look.
//
//   node e2e/manual-reset-actions.mjs [en|de]
//
// Result: out/mockup/reset-actions-<locale>-{light,dark,after-cancel}.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-reset-look-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-reset-look-userdata-'));
await mkdir(SHOTS, { recursive: true });
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

async function shoot(name) {
  await page.evaluate(() => document.getElementById('settings-reset-actions')?.scrollIntoView({ block: 'center' }));
  await new Promise((r) => setTimeout(r, 400));
  const file = path.join(SHOTS, `reset-actions-${locale}-${name}.png`);
  await page.locator('#modal-settings .settings-dialog').screenshot({ path: file });
  console.log('shot', file);
}

try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 1100));
  // The native dialog would block the run; record what it is asked to show
  // and answer "Cancel".
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    dialog.showMessageBox = async (...args) => {
      globalThis.__dialogs.push(args.find((arg) => arg && typeof arg === 'object' && 'buttons' in arg));
      return { response: 1 };
    };
  });
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings dialog' });
  await page.evaluate(() => document.getElementById('tab-settings-security').click());
  await poll(() => page.evaluate(() => document.querySelectorAll('#settings-reset-actions button[data-reset]').length === 2),
    { what: 'reset actions' });
  console.log('buttons:', await page.evaluate(() =>
    [...document.querySelectorAll('#settings-reset-actions button')].map((b) => `${b.dataset.reset}: ${b.textContent}`)));

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await shoot(theme);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  await page.locator('#settings-reset-actions button[data-reset="all"]').click();
  await poll(async () => (await app.evaluate(() => globalThis.__dialogs.length)) > 0, { what: 'native dialog' });
  console.log('dialog:', JSON.stringify(await app.evaluate(() => globalThis.__dialogs[0]), null, 2));
  console.log('buttons after cancel:', await page.evaluate(() =>
    [...document.querySelectorAll('#settings-reset-actions button')].map((b) => `${b.dataset.reset}: ${b.textContent}`)));
  await shoot('after-cancel');
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
