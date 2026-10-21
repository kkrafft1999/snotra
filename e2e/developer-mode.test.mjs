// Developer mode in the real app (#1213): ⌘⌥⇧D (Ctrl+Alt+Shift+D on
// Windows and Linux) switches it, the notice says which way, Settings ›
// Remote access appears with a Developer chip and pairing opens, and a
// restart keeps it. The pieces are tested on their own in
// test/developer-mode.test.js and test/remote-access-settings-dom.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

/**
 * ⌘⌥⇧D as Electron reports it — Option+Shift+D types Î on a Mac. Playwright's
 * keyboard never reaches `before-input-event` (see e2e/hidden-files.test.mjs),
 * so the window is handed the input of the real key. True when it swallowed it.
 */
const pressShortcut = (app) => app.evaluate(({ BrowserWindow }, platform) => {
  const input = {
    type: 'keyDown', code: 'KeyD', key: 'Î', shift: true, alt: true, isAutoRepeat: false,
    meta: platform === 'darwin', control: platform !== 'darwin',
  };
  let prevented = false;
  BrowserWindow.getAllWindows()[0].webContents.emit(
    'before-input-event', { preventDefault: () => { prevented = true; } }, input
  );
  return prevented;
}, process.platform);

async function openSettings(app, page) {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((entry) => /^(Settings|Einstellungen)/.test(entry.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'the settings dialog' });
}

const view = (page) => page.evaluate(() => ({
  tab: !document.getElementById('tab-settings-remote').hidden,
  chip: !document.getElementById('settings-nav-remote-developer').hidden,
  notice: document.querySelector('.app-notice[data-notice-id="developer-mode"] .app-notice-heading')?.textContent ?? null,
}));

test('the shortcut switches developer mode: Remote access appears, pairing opens, a restart keeps it', { timeout: 240000 }, async (t) => {
  const model = await startFakeModel();
  t.after(() => model.close?.());
  const workspace = await makeTempDir('snotra-e2e-devmode-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  const userDataDir = await makeTempDir('snotra-e2e-devmode-userdata-');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

  let snotra = await launchApp({ userDataDir });
  t.after(() => snotra.app.close().catch(() => {}));
  let { app, page } = snotra;
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0), { what: 'the tree' });

  assert.deepEqual(await view(page), { tab: false, chip: false, notice: null }, 'not there by default');
  assert.equal((await page.evaluate(() => window.electronAPI.remote.startPairing())).reason, 'locked', 'and pairing is closed');

  assert.equal(await pressShortcut(app), true, 'the window swallows the shortcut');
  await poll(async () => (await view(page)).tab, { what: 'Remote access shown' });
  assert.deepEqual(await view(page), { tab: true, chip: true, notice: 'Developer mode on' });
  assert.equal((await page.evaluate(() => window.electronAPI.remote.getState())).locked, false, 'pairing is open');

  await openSettings(app, page);
  await page.click('#tab-settings-remote');
  // Open now — unless this system cannot keep keys encrypted (the Linux runner has no keyring), which the panel says instead.
  const encrypted = (await page.evaluate(() => window.electronAPI.remote.getState())).encryptionAvailable;
  await poll(() => page.evaluate((canPair) => {
    const pair = document.querySelector('[data-action="pair"]');
    const why = document.getElementById('ra-pair-why')?.textContent ?? '';
    return !!pair && !document.querySelector('.ra-soon') && !/Pairing opens once/.test(why)
      && (canPair ? pair.disabled === false : /cannot keep the phone’s keys encrypted/.test(why));
  }, encrypted), { what: 'Pair a phone no longer locked' });

  // A restart keeps it.
  await snotra.stop();
  snotra = await launchApp({ userDataDir });
  ({ app, page } = snotra);
  await poll(async () => (await view(page)).tab, { what: 'Remote access shown after a restart' });
  assert.equal((await view(page)).notice, null, 'no notice for a mode that was only read');

  // And the shortcut switches it off again.
  assert.equal(await pressShortcut(app), true, 'the window swallows the shortcut');
  await poll(async () => !(await view(page)).tab, { what: 'Remote access hidden' });
  assert.deepEqual(await view(page), { tab: false, chip: false, notice: 'Developer mode off' });
  assert.equal((await page.evaluate(() => window.electronAPI.remote.getState())).locked, true);
});
