// Look instead of trust (#1001): starts the real app with a chat history it
// cannot understand (moved aside at start) and a folder history it cannot
// read (a folder in its place, so it is not saved), and photographs the
// notices under the title bar, light and dark and in a narrow window — plus
// the contrast of their text on their ground.
// Not a test — a look.
//
//   node e2e/manual-app-notices.mjs [en|de]
//
// Result: out/mockup/app-notices-<locale>-{light,dark,narrow,focus}.png

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
await mkdir(SHOTS, { recursive: true });

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-notices-look-');
const userDataDir = await makeTempDir('snotra-notices-look-userdata-');
await writeFile(path.join(workspace, 'README.md'), '# Garden Planner\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
await writeFile(path.join(userDataDir, 'chat-history.json'), '{ "version": 2, "sessions": [', 'utf8');
await rm(path.join(userDataDir, 'folder-history.json'), { force: true });
await mkdir(path.join(userDataDir, 'folder-history.json'));

const snotra = await launchApp({ userDataDir });
const { page } = snotra;
await page.setViewportSize({ width: 1280, height: 760 }).catch(() => {});

/** WCAG contrast of each notice's text against its ground, as drawn. */
function contrasts() {
  return page.evaluate(() => {
    const rgb = (value) => (value.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const c = [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const over = (fg, bg) => {
      const a = fg[3] ?? 1;
      return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
    };
    const behind = rgb(getComputedStyle(document.body).backgroundColor);
    return [...document.querySelectorAll('.app-notice')].map((notice) => {
      const ground = over(rgb(getComputedStyle(notice).backgroundColor), behind);
      const ratio = (el) => {
        if (!el) return null;
        const fg = over(rgb(getComputedStyle(el).color), ground);
        const [a, b] = [lum(fg), lum(ground)].sort((x, y) => y - x);
        return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
      };
      return {
        kind: notice.className,
        heading: ratio(notice.querySelector('.app-notice-heading')),
        text: ratio(notice.querySelector('.app-notice-text')),
        path: ratio(notice.querySelector('.app-notice-path')),
        link: ratio(notice.querySelector('.app-notice-link')),
      };
    });
  });
}

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('.app-notice').length >= 2), {
    what: 'two notices',
    explain: () => page.evaluate(() => document.getElementById('app-notices')?.outerHTML.slice(0, 400)),
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 300));
    console.log(theme, JSON.stringify(await contrasts()));
    await page.screenshot({ path: path.join(SHOTS, `app-notices-${locale}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.setViewportSize({ width: 760, height: 640 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(SHOTS, `app-notices-${locale}-narrow.png`) });
  await page.setViewportSize({ width: 1280, height: 760 }).catch(() => {});
  // Keyboard: the close button takes the focus ring.
  await page.evaluate(() => document.querySelector('.app-notice-link')?.focus());
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await new Promise((r) => setTimeout(r, 200));
  await page.locator('#app-notices').screenshot({ path: path.join(SHOTS, `app-notices-${locale}-focus.png`) });
  console.log('focused', await page.evaluate(() => document.activeElement?.dataset?.action || document.activeElement?.id));
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
