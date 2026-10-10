// Help links in the settings (#848), in the real app: a `?` next to a heading
// opens the help window at the page and section it names, the header's `?`
// follows the open section, and a second `?` turns the open window to its
// page instead of opening another one. Which pages and anchors exist is
// checked against the bundled manual in test/settings-help.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { launchApp, makeTempDir, poll, prepareUserData } from './helpers/app.mjs';
import { startFakeModel } from './helpers/fake-model.mjs';

test('a ? in the settings opens the manual at its section', { timeout: 120000 }, async (t) => {
  const model = await startFakeModel();
  t.after(() => (model.close ?? model.stop)?.call(model));
  const workspace = await makeTempDir('snotra-settings-help-ws-');
  await writeFile(path.join(workspace, 'notes.md'), '# Notes\n');
  const userDataDir = await makeTempDir('snotra-settings-help-userdata-');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  const snotra = await launchApp({ userDataDir });
  t.after(() => snotra.stop().catch(() => {}));
  const { app, page } = snotra;
  // The menu's Settings reaches a renderer that is listening only once the
  // folder is drawn.
  await poll(async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
    { what: 'drawn tree' });

  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !!document.activeElement?.closest('#modal-settings')),
    { what: 'the settings dialog with the focus' });

  // The header's ? names the page of the open section, and follows it.
  const header = () => page.evaluate(() => document.getElementById('btn-settings-panel-help').getAttribute('aria-label'));
  assert.match(await header(), /models|Modelle/i);
  await page.evaluate(() => document.querySelector('.settings-nav-item[data-settings-panel="security"]').click());
  await poll(async () => /may do|darf/.test(await header()), { what: 'the header ? on Tools & security' });

  // The ? next to "Default mode": keyboard-reachable, named after its target.
  const button = page.locator('[data-manual-help="defaultMode"]');
  await poll(() => button.isVisible(), { what: 'the ? next to the default mode' });
  const name = await button.getAttribute('aria-label');
  assert.ok(name && name !== 'Help', `the ? names its target: ${name}`);
  const fragment = await page.evaluate(async () => {
    const { settingsHelpTarget } = await import('./manual/settings-help-links.js');
    return settingsHelpTarget('defaultMode', document.documentElement.lang).fragment;
  });

  const opened = app.waitForEvent('window');
  await button.focus();
  await page.keyboard.press('Enter');
  const help = await opened;
  await poll(() => help.evaluate((anchor) =>
    document.querySelector('.manual-nav [aria-current="page"]')?.dataset.page === 'safety/choose-a-mode'
      && document.activeElement?.dataset?.mdAnchor === anchor, fragment),
  { what: 'the help window on "Choose a mode", at the default mode' });

  // With the window open, another ? turns it to its own page.
  await page.bringToFront();
  await page.evaluate(() => document.querySelector('.settings-nav-item[data-settings-panel="tools"]').click());
  await page.evaluate(() => document.querySelector('[data-manual-help="python"]').click());
  await poll(() => help.evaluate(() =>
    document.querySelector('.manual-nav [aria-current="page"]')?.dataset.page === 'customising/built-in-tools'
      && document.activeElement?.dataset?.mdAnchor === 'python'),
  { what: 'the help window turned to "Python"' });
  const helpWindows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('manual.html')).length);
  assert.equal(helpWindows, 1, 'one help window, not a second');
});
