// Look instead of trust (#1195): starts the real app with two workspaces and
// photographs *Access from your phone* on Settings › Tools › Security in
// every state — closed without a paired phone, the native dialog cancelled,
// opened with keyboard focus on the switch, and closed again without a dialog. Light and dark each. The native dialog is
// answered by a stub in main; its text is printed. Not a test — a look. Run
// it outside the Claude Code sandbox, or the app's own sandbox cannot start.
//
//   node e2e/manual-phone-access.mjs [en|de]
//
// Result: out/mockup/phone-access-<locale>-*.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const prefix = `phone-access-${locale}`;
const pause = (ms = 400) => new Promise((r) => setTimeout(r, ms));

const model = await startFakeModel();
const base = await makeTempDir('snotra-phone-');
const garden = path.join(base, 'garden-planner');
for (const dir of [garden]) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'README.md'), '# Example\n', 'utf8');
}
const userDataDir = await makeTempDir('snotra-phone-userdata-');
await mkdir(SHOTS, { recursive: true });
await prepareUserData(userDataDir, { workspace: garden, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'folder-history.json'), JSON.stringify({ paths: [garden] }), 'utf8');
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale, shellExecutionEnabled: true }), 'utf8');
const { app, page } = await launchApp({ userDataDir });

async function shoot(name, selector = '#modal-settings .settings-dialog') {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(300);
    const file = path.join(SHOTS, `${prefix}-${name}-${theme}.png`);
    await page.locator(selector).screenshot({ path: file });
    console.log('shot', file);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const phoneSwitch = () => page.locator('input[data-action="phone"]');
const showPhoneCard = () => page.evaluate(() => {
  const wrap = document.querySelector('.settings-dialog__panel-wrap');
  const card = document.querySelector('input[data-action="phone"]').closest('.settings-sandbox-card');
  wrap.scrollTop = card.offsetTop - 120;
});
const describeFocus = () => page.evaluate(() => {
  const el = document.activeElement;
  return el ? `${el.tagName.toLowerCase()}${el.dataset?.focus ? ` [${el.dataset.focus}]` : ''} checked=${el.checked}` : 'none';
});
const answerDialog = (response) => app.evaluate(({ dialog }, value) => {
  globalThis.__dialogs ??= [];
  dialog.showMessageBox = async (win, options) => {
    globalThis.__dialogs.push(options || win);
    return { response: value };
  };
}, response);

try {
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1280, 1100); });
  await poll(async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0, { what: 'drawn tree' });

  await page.evaluate(() => document.getElementById('btn-sidebar-settings')?.click());
  await poll(() => page.evaluate(() => !document.getElementById('btn-settings-save').disabled), { what: 'settings ready' });
  await page.evaluate(() => document.getElementById('tab-settings-sandbox').click());
  await poll(() => page.evaluate(() => !!document.querySelector('input[data-action="phone"]')), { what: 'the phone switch' });

  // 1. Closed, no phone paired.
  await showPhoneCard();
  await shoot('off');
  console.log('describedby:', await page.evaluate(() => {
    const input = document.querySelector('input[data-action="phone"]');
    return input.getAttribute('aria-describedby').split(' ').map((id) => document.getElementById(id).textContent).join(' | ');
  }));

  // 2. Cancel in the native dialog: stays closed, says nothing.
  await answerDialog(1);
  await phoneSwitch().focus();
  await page.keyboard.press('Space');
  await pause(800);
  console.log('after cancel:', await describeFocus(), 'error:', JSON.stringify(await page.evaluate(() => document.getElementById('settings-sandbox-error')?.textContent)));

  // 3. Allow: open to the phone, the list says so; keyboard focus stays on the switch.
  await answerDialog(0);
  await page.keyboard.press('Space');
  await poll(() => page.evaluate(() => document.querySelector('input[data-action="phone"]')?.checked === true), { what: 'opened' });
  await pause(300);
  console.log('after allow:', await describeFocus());
  await showPhoneCard();
  await shoot('on-focus');
  console.log('list:', await page.evaluate(() => [...document.querySelectorAll('.settings-sandbox-ws')].map((n) => n.innerText.replace(/\s+/g, ' ')).join(' / ')));
  const dialogs = await app.evaluate(() => globalThis.__dialogs.map((d) => ({ message: d.message, detail: d.detail, buttons: d.buttons, defaultId: d.defaultId })));
  for (const d of dialogs) console.log('dialog:', JSON.stringify(d));

  // 4. Closing asks nothing and takes effect at once.
  const before = await app.evaluate(() => globalThis.__dialogs.length);
  await phoneSwitch().focus();
  await page.keyboard.press('Space');
  await poll(() => page.evaluate(() => document.querySelector('input[data-action="phone"]')?.checked === false), { what: 'closed' });
  console.log('dialogs for closing:', (await app.evaluate(() => globalThis.__dialogs.length)) - before);
  console.log('releases:', JSON.stringify(await page.evaluate(() => window.electronAPI.remote.getReleases())));
} finally {
  await app.close().catch(() => {});
  await model.close?.();
}
