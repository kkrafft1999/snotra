// Access from your phone in the real app (#1195): on Settings › Tools ›
// Security every workspace starts closed to the phone; with encrypted storage,
// opening it is confirmed in the system dialog — Cancel keeps it closed
// without a word — and closing it asks nothing; without encrypted storage (the
// Linux runner has no keyring) the switch cannot be opened and says why. The
// switch is worked with the keyboard, and the card passes axe in both themes.
// The page's logic is tested on the markup in test/tool-security-panel-dom.test.js,
// main's in test/remote-release-settings.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';
import { axeViolations, describeViolations } from './helpers/axe.mjs';

/** Sets the theme as ThemeManager.js does and ends its colour transitions (#1118). */
function useTheme(page, theme) {
  return page.evaluate((value) => {
    if (value === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    void document.body.offsetHeight;
    for (const animation of document.getAnimations()) animation.finish();
  }, theme);
}

test('Tools › Security: a workspace is opened to the phone through the system dialog and closed at once', { timeout: 240000 }, async (t) => {
  const model = await startFakeModel();
  t.after(() => model.close?.());
  const workspace = path.join(await makeTempDir('snotra-e2e-phone-'), 'garden-planner');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  const userDataDir = await makeTempDir('snotra-e2e-phone-userdata-');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');
  const { app, page } = await launchApp({ userDataDir });
  t.after(() => app.close().catch(() => {}));

  const answer = (response) => app.evaluate(({ dialog }, value) => {
    globalThis.__dialogs ??= [];
    dialog.showMessageBox = async (win, options) => {
      globalThis.__dialogs.push(options || win);
      return { response: value };
    };
  }, response);
  const dialogs = () => app.evaluate(() => globalThis.__dialogs?.length || 0);
  const releases = () => page.evaluate(() => window.electronAPI.remote.getReleases());
  const checked = () => page.evaluate(() => document.querySelector('input[data-action="phone"]')?.checked);
  await answer(1);
  await poll(async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0, { what: 'the open folder', timeoutMs: 30000 });

  await page.evaluate(() => document.getElementById('btn-sidebar-settings')?.click());
  await poll(() => page.evaluate(() => !document.getElementById('btn-settings-save').disabled), { what: 'settings ready' });
  await page.evaluate(() => document.getElementById('tab-settings-sandbox').click());
  await poll(() => page.evaluate(() => !!document.querySelector('input[data-action="phone"]')), { what: 'the phone switch', timeoutMs: 30000 });

  const state = await releases();
  assert.deepEqual(state.released, [], 'closed to the phone by default');
  assert.equal(state.paired, false);
  assert.equal(await checked(), false);

  const findings = [];
  for (const theme of ['light', 'dark']) {
    await useTheme(page, theme);
    for (const violation of await axeViolations(page, { context: '#modal-settings' })) findings.push({ screen: `phone switch off (${theme})`, ...violation });
  }
  await useTheme(page, 'light');

  await page.locator('input[data-action="phone"]').focus();
  if (!state.available) {
    // Without encrypted storage nothing can be kept for the phone — and nothing is asked.
    assert.equal(await page.evaluate(() => document.querySelector('input[data-action="phone"]').getAttribute('aria-disabled')), 'true');
    await page.keyboard.press('Space');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await checked(), false);
    assert.equal(await dialogs(), 0);
    assert.match(await page.evaluate(() => document.getElementById('settings-sandbox-detail').textContent), /does not encrypt/);
    t.diagnostic('no encrypted storage here: the switch is checked closed');
    assert.equal(findings.length, 0, describeViolations(findings));
    return;
  }

  // Cancel in the system dialog: closed, and no error line.
  await page.keyboard.press('Space');
  await poll(async () => (await dialogs()) === 1, { what: 'the system dialog' });
  await poll(async () => (await checked()) === false, { what: 'back to closed' });
  assert.equal(await page.evaluate(() => document.getElementById('settings-sandbox-error').classList.contains('hidden')), true);
  assert.deepEqual((await releases()).released, []);

  // Allow: open, named in the dialog, and said in the list.
  await answer(0);
  await page.keyboard.press('Space');
  await poll(async () => (await releases()).released.length === 1, { what: 'opened to the phone' });
  await poll(async () => (await checked()) === true, { what: 'the switch on' });
  const dialog = await app.evaluate(() => globalThis.__dialogs.at(-1));
  assert.equal(dialog.message, 'Open this workspace to your phone?');
  assert.match(dialog.detail, /garden-planner/);
  assert.equal(dialog.defaultId, 1, 'Cancel is the default');
  assert.equal(path.basename((await releases()).released[0]), 'garden-planner');
  assert.match(await page.evaluate(() => document.querySelector('.settings-sandbox-ws[aria-current="true"] .settings-sandbox-ws__meta').textContent), /· phone$/);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.action), 'phone', 'the focus stays on the switch');
  for (const theme of ['light', 'dark']) {
    await useTheme(page, theme);
    for (const violation of await axeViolations(page, { context: '#modal-settings' })) findings.push({ screen: `phone switch on (${theme})`, ...violation });
  }
  await useTheme(page, 'light');

  // Closing asks nothing.
  const before = await dialogs();
  await page.keyboard.press('Space');
  await poll(async () => (await releases()).released.length === 0, { what: 'closed to the phone' });
  assert.equal(await dialogs(), before);
  assert.equal(findings.length, 0, describeViolations(findings));
});
