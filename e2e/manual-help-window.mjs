// A look rather than a test: starts the real app, opens Help › User manual
// (#790) and saves the help window in its states — wide and narrow, light and
// dark, English and German.
//
//   node e2e/manual-help-window.mjs
//
// Result: out/mockup/help-window-*.png

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-help-ws-');
const userDataDir = await makeTempDir('snotra-help-userdata-');
await mkdir(SHOTS, { recursive: true });

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function setHelpSize(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('manual.html'));
    win.setSize(size.width, size.height);
  }, { width, height });
  await wait(400);
}

async function setTheme(theme) {
  await page.evaluate((value) => localStorage.setItem('theme', value), theme);
  await wait(500);
}

// Through the app's own language switch, as a user would.
async function switchLocale(locale) {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await wait(800);
  await page.evaluate(() => document.querySelector('.settings-nav-item[data-settings-panel="general"]').click());
  await wait(200);
  await page.evaluate((value) => {
    const input = document.querySelector(`#choice-app-locale input[value="${value}"]`);
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, locale);
  await wait(400);
  await page.evaluate(() => document.getElementById('btn-settings-close').click());
  await wait(800);
}

async function shoot(help, name) {
  await help.screenshot({ path: path.join(SHOTS, `help-window-${name}.png`) });
  console.log(`help-window-${name}.png`);
}

async function openPage(help, slug, section = '') {
  await help.evaluate(({ slug: s }) => {
    document.querySelector(`.manual-nav a[data-page="${s}"]`)?.click();
  }, { slug });
  await poll(() => help.evaluate((s) => document.querySelector('[aria-current="page"]')?.dataset.page === s, slug),
    { what: `page ${slug}` });
  if (section) {
    await help.evaluate((anchor) => {
      document.querySelector(`.manual-outline a[data-anchor="${anchor}"]`)?.click();
    }, section);
  }
  await wait(500);
}

try {
  await poll(() => page.evaluate(() => document.readyState === 'complete'), { what: 'app window' });
  await switchLocale('en');

  const opened = app.waitForEvent('window');
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('help.manual').click());
  const help = await opened;
  await poll(() => help.evaluate(() => document.querySelectorAll('.manual-nav a[data-page]').length > 10),
    { what: 'chapters in the help window' });
  await wait(600);
  await setHelpSize(1280, 860);

  await shoot(help, 'en-light-overview');
  await openPage(help, 'safety/choose-a-mode');
  await shoot(help, 'en-light-page');
  await help.evaluate(() => document.querySelector('img.manual-shot')?.scrollIntoView({ block: 'center' }));
  await wait(400);
  await shoot(help, 'en-light-screenshot');
  await setTheme('dark');
  await shoot(help, 'en-dark-page');
  await setHelpSize(1000, 820);
  await shoot(help, 'en-dark-medium');

  await setHelpSize(700, 820);
  await shoot(help, 'en-dark-narrow');
  await help.evaluate(() => document.getElementById('manual-contents').click());
  await wait(500);
  await shoot(help, 'en-dark-narrow-contents');
  await help.keyboard.press('Escape');
  await setTheme('light');
  await shoot(help, 'en-light-narrow');

  await switchLocale('de');
  await setHelpSize(1280, 860);
  await shoot(help, 'de-light-page');
} finally {
  await snotra.stop().catch(() => {});
  await (model.close ?? model.stop)?.call(model);
}
