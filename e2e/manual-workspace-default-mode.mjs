// Look instead of trust (#413): starts the real app and photographs the
// workspace default — the mode pill's menu before and after ticking "for new
// chats in this folder too", the menu of a chat that left the default, and the
// card in Settings › Permissions — light and dark.
// Not a test — a look. Run it outside the Claude Code sandbox.
//
//   node e2e/manual-workspace-default-mode.mjs [en|de]
//
// Result: out/mockup/workspace-default-<locale>-*.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const model = await startFakeModel();
const parent = await makeTempDir('snotra-ws-default-');
const workspace = path.join(parent, 'snotra');
const userDataDir = await makeTempDir('snotra-ws-default-userdata-');
await mkdir(workspace, { recursive: true });
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;
const shot = (name) => path.join(SHOTS, `workspace-default-${locale}-${name}.png`);
const pause = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/** The composer with the open menu above it. */
async function photographMenu(name) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause();
    const box = await page.evaluate(() => {
      const union = (a, b) => ({
        x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom),
      });
      const r = union(
        document.getElementById('chat-input-row').getBoundingClientRect(),
        document.getElementById('chat-tool-mode-menu').getBoundingClientRect(),
      );
      return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.right - r.x + 24, height: r.bottom - r.y + 24 };
    });
    await page.screenshot({ path: shot(`${name}-${theme}`), clip: box });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

async function setMode(mode) {
  await page.evaluate((m) => window.electronAPI.setToolPermissionMode(m), mode);
  await poll(() => page.evaluate((m) => document.getElementById('chat-tool-mode-wrap').dataset.mode === m, mode),
    { what: `mode ${mode}` });
  await pause();
}

async function openMenu() {
  await page.evaluate(() => {
    if (document.getElementById('chat-tool-mode-menu').classList.contains('hidden')) {
      document.getElementById('btn-chat-tool-mode').click();
    }
  });
  await pause();
}

try {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  await setMode('auto');
  await openMenu();
  await photographMenu('1-auto-unticked');
  // Keyboard: from the last option, Tab reaches the checkbox.
  await page.evaluate(() => document.querySelector('.chat-tool-mode-option[data-mode="auto"]').focus());
  await page.keyboard.press('Tab');
  console.log('focus after Tab:', await page.evaluate(() => document.activeElement?.id));
  await page.keyboard.press('Space');
  await poll(async () => (await page.evaluate(() => window.electronAPI.getToolPermissionState())).workspaceMode === 'auto',
    { what: 'default "auto"' });
  await pause();
  console.log('status:', await page.evaluate(() => document.getElementById('chat-tool-mode-status').textContent));
  console.log('pill title:', await page.evaluate(() => document.getElementById('btn-chat-tool-mode').title));
  await photographMenu('2-auto-default');

  await page.keyboard.press('Escape');
  await setMode('smart');
  await openMenu();
  await photographMenu('3-chat-left-default');
  await page.keyboard.press('Escape');

  // Settings › Permissions, opened as in manual-sandbox-opt-out.mjs.
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('btn-settings-save').disabled
    && document.getElementById('settings-panel-heading').textContent.trim() !== ''),
  { what: 'settings ready' });
  await pause(800);
  await poll(() => page.evaluate(() => {
    if (!document.getElementById('panel-settings-security').hidden) return true;
    document.getElementById('tab-settings-security').click();
    return false;
  }), { what: 'security panel' });
  await pause(500);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause();
    const card = page.locator('#settings-security-header');
    await card.scrollIntoViewIfNeeded();
    await pause();
    await card.screenshot({ path: shot(`4-settings-${theme}`) });
  }
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
