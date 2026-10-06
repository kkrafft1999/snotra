// Look instead of trust (#767): the settings navigation after the merge —
// "Tools & security" and "Tool setup" with the MCP servers below the built-in
// tools — and the links from the external row of Tools & security, light and
// dark, at a wide and a narrow window. Not a test — a look.
//
//   node e2e/manual-settings-tool-setup.mjs [en|de]
//
// Result: out/mockup/tool-setup-<locale>-<width>-<theme>-<view>.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-tool-setup-');
const userDataDir = await makeTempDir('snotra-tool-setup-userdata-');
await mkdir(SHOTS, { recursive: true });
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
// Two servers, one on and one off, so the section shows a list rather than
// its empty state. The command does not exist; the rows are drawn all the same.
await writeFile(path.join(userDataDir, 'mcp-servers.json'), JSON.stringify({
  servers: [
    { id: 'files', label: 'Files', command: 'snotra-no-such-command', args: [], enabled: true },
    { id: 'notes', label: 'Notes', command: 'snotra-no-such-command', args: [], enabled: false },
  ],
}), 'utf8');

const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;
const dialog = page.locator('.settings-dialog');

async function shoot(name) {
  await new Promise((r) => setTimeout(r, 300));
  const file = path.join(SHOTS, `tool-setup-${locale}-${name}.png`);
  await dialog.screenshot({ path: file });
  console.log('shot', file);
}

const scrollPanel = (to) => page.evaluate((to) => {
  const wrap = document.querySelector('.settings-dialog__panel-wrap');
  wrap.scrollTop = to === 'bottom' ? wrap.scrollHeight : 0;
}, to);

const openTab = async (key) => {
  await page.evaluate((key) => document.getElementById(`tab-settings-${key}`).click(), key);
  await poll(() => page.evaluate((key) => !document.getElementById(`panel-settings-${key}`).hidden, key),
    { what: `${key} panel` });
};

try {
  // The renderer subscribes to the menu item a moment after the window
  // shows; click until the dialog answers.
  await poll(async () => {
    await app.evaluate(({ Menu }) => {
      for (const top of Menu.getApplicationMenu()?.items ?? []) {
        const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
        if (item) { item.click(); return; }
      }
    });
    await new Promise((r) => setTimeout(r, 250));
    return page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden'));
  }, { what: 'settings dialog' });

  for (const width of [1180, 760]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);

      await openTab('tools');
      await poll(() => page.evaluate(() => document.querySelectorAll('#settings-mcp-list .mcp-row').length > 0),
        { what: 'MCP rows' });
      await scrollPanel('top');
      await shoot(`${width}-${theme}-top`);
      await scrollPanel('bottom');
      await shoot(`${width}-${theme}-bottom`);

      await openTab('security');
      await page.evaluate(() => {
        const toggle = document.querySelector('.settings-security-row__toggle[data-risk-class="external"]');
        if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
        document.querySelector('.settings-security-links')?.scrollIntoView({ block: 'center' });
      });
      await shoot(`${width}-${theme}-security-links`);
    }
  }
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
