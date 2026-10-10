// The help window (#790): Help › User manual opens the manual that ships with
// the app, in the real app. Checked here what only the running app shows: the
// window opens on the overview with every chapter, a link inside a page leads
// to the other page and its section, a screenshot arrives, back returns, and
// the page cannot reach the app window's channels.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { launchApp, makeTempDir, poll, prepareUserData } from './helpers/app.mjs';
import { startFakeModel } from './helpers/fake-model.mjs';

test('Help › User manual opens the bundled manual and navigates it', { timeout: 120000 }, async (t) => {
  const model = await startFakeModel();
  t.after(() => (model.close ?? model.stop)?.call(model));
  const workspace = await makeTempDir('snotra-help-ws-');
  const userDataDir = await makeTempDir('snotra-help-userdata-');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  const snotra = await launchApp({ userDataDir });
  t.after(() => snotra.stop().catch(() => {}));
  const { app } = snotra;

  const opened = app.waitForEvent('window');
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('help.manual').click());
  const help = await opened;

  await poll(() => help.evaluate(() => document.querySelector('.manual-nav [aria-current="page"]')?.dataset.page),
    { what: 'the overview marked in the chapters' });
  const start = await help.evaluate(() => ({
    current: document.querySelector('.manual-nav [aria-current="page"]').dataset.page,
    chapters: document.querySelectorAll('.manual-nav__chapter').length,
    title: document.querySelector('#manual-doc h1')?.textContent,
    version: document.getElementById('manual-version').textContent,
  }));
  assert.equal(start.current, 'index');
  assert.equal(start.chapters, 8);
  assert.ok(start.title, 'the overview has its title');
  assert.match(start.version, /^\d+\.\d+\.\d+/);

  // A second call brings the same window to the front instead of a new one.
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('help.manual').click());
  const helpWindows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('manual.html')).length);
  assert.equal(helpWindows, 1);

  // Into a chapter, then along a link of the page to another page's section.
  await help.evaluate(() => document.querySelector('.manual-nav a[data-page="safety/choose-a-mode"]').click());
  await poll(() => help.evaluate(() => document.querySelector('.manual-crumbs [aria-current="page"]')?.textContent
    && document.querySelector('.manual-nav [aria-current="page"]')?.dataset.page === 'safety/choose-a-mode'),
    { what: 'the page "Choose a mode"' });
  await poll(() => help.evaluate(() => document.querySelector('img.manual-shot')?.src?.startsWith('data:image/webp')),
    { what: 'the screenshot of the page' });

  const link = await help.evaluate(() => {
    const anchor = document.querySelector('#manual-doc a[data-page="safety/why-snotra-asks"]');
    anchor.click();
    return anchor.dataset.fragment;
  });
  assert.ok(link, 'the link names a section');
  await poll(() => help.evaluate(() =>
    document.querySelector('.manual-nav [aria-current="page"]')?.dataset.page === 'safety/why-snotra-asks'),
  { what: 'the linked page' });
  const focused = await help.evaluate(() => document.activeElement?.dataset?.mdAnchor ?? null);
  assert.equal(focused, link, 'the section the link names has the focus');

  await help.evaluate(() => document.getElementById('manual-back').click());
  await poll(() => help.evaluate(() =>
    document.querySelector('.manual-nav [aria-current="page"]')?.dataset.page === 'safety/choose-a-mode'),
  { what: 'back on "Choose a mode"' });

  // Search (#847): Cmd/Ctrl+F, a query, ↓ to the second result, Enter.
  await help.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  assert.equal(await help.evaluate(() => document.activeElement?.id), 'manual-search');
  // A word both languages use, so that the test does not depend on the profile's language.
  await help.keyboard.type('sandbox');
  await poll(() => help.evaluate(() => document.querySelectorAll('#manual-results [role="option"]').length > 1),
    { what: 'search results' });
  assert.equal(await help.evaluate(() => document.getElementById('manual-nav').hidden), true,
    'the results take the place of the chapters');
  await help.keyboard.press('ArrowDown');
  const chosen = await help.evaluate(() => {
    const input = document.getElementById('manual-search');
    const option = document.getElementById(input.getAttribute('aria-activedescendant'));
    return option.querySelector('.manual-result__title').textContent;
  });
  await help.keyboard.press('Enter');
  await poll(() => help.evaluate((title) =>
    document.querySelector('#manual-doc h1')?.textContent === title, chosen),
  { what: `the page "${chosen}"` });
  const landed = await help.evaluate(() => ({
    anchor: document.activeElement?.dataset?.mdAnchor ?? null,
    lit: document.activeElement?.classList.contains('manual-hit') ?? false,
  }));
  assert.ok(landed.anchor, 'the section the words were found in has the focus');
  assert.equal(landed.lit, true, 'and is lit up');

  await help.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  await help.keyboard.press('Escape');
  assert.equal(await help.evaluate(() => document.getElementById('manual-nav').hidden), false,
    'Escape brings the chapters back');

  // The help page has its own bridge and nothing of the app's.
  const bridges = await help.evaluate(() => ({ app: typeof window.api, manual: typeof window.manualApi }));
  assert.deepEqual(bridges, { app: 'undefined', manual: 'object' });
});
