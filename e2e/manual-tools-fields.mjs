// Look instead of trust: opens Settings › Tools and photographs the two text
// fields there — the own Python interpreter and the Tavily API key — empty,
// filled and focused, light and dark. Not a test — a look.
//
//   node e2e/manual-tools-fields.mjs [en|de]
//
// Result: out/mockup/tools-fields-<locale>-<theme>-<state>.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-tools-fields-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-tools-fields-userdata-'));
await mkdir(SHOTS, { recursive: true });
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');

const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

async function shoot(name) {
  await new Promise((r) => setTimeout(r, 300));
  const file = path.join(SHOTS, `tools-fields-${locale}-${name}.png`);
  await page.locator('#panel-settings-tools').screenshot({ path: file });
  console.log('shot', file);
}

try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 1000));
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings dialog' });
  await page.evaluate(() => document.getElementById('tab-settings-tools').click());
  await poll(() => page.evaluate(() => !document.getElementById('panel-settings-tools').hidden),
    { what: 'tools panel' });

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.evaluate(() => {
      document.getElementById('input-python-interpreter').value = '';
      document.getElementById('input-web-search-key').value = '';
      document.activeElement?.blur();
    });
    await shoot(`${theme}-empty`);
    await page.evaluate(() => {
      document.getElementById('input-python-interpreter').value = '/Users/you/venv/bin/python3';
      document.getElementById('input-web-search-key').value = 'tvly-dev-0123456789abcdef';
    });
    await page.locator('#input-web-search-key').focus();
    await shoot(`${theme}-filled-focus`);
  }
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
