// Look instead of trust (#977): starts the real app with a chat history it
// cannot read (the file is a folder), sends a question and photographs the
// chat column with the banner, light and dark — plus the contrast of its text
// on the tinted ground, and a narrow column.
// Not a test — a look.
//
//   node e2e/manual-chat-save-notice.mjs [en|de]
//
// Result: out/mockup/chat-save-notice-<locale>-{light,dark,narrow}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
await mkdir(SHOTS, { recursive: true });

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-save-notice-look-');
const userDataDir = await makeTempDir('snotra-save-notice-look-userdata-');
await writeFile(path.join(workspace, 'README.md'), '# Garden Planner\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
await mkdir(path.join(userDataDir, 'chat-history.json'));

const snotra = await launchApp({ userDataDir });
const { page } = snotra;
await page.setViewportSize({ width: 1280, height: 760 }).catch(() => {});

/** WCAG contrast of an element's text against the banner's ground, as drawn. */
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
    const notice = document.getElementById('chat-save-notice');
    const behind = rgb(getComputedStyle(document.getElementById('chat-panel')).backgroundColor);
    const ground = over(rgb(getComputedStyle(notice).backgroundColor), behind);
    const ratio = (el) => {
      const fg = over(rgb(getComputedStyle(el).color), ground);
      const [a, b] = [lum(fg), lum(ground)].sort((x, y) => y - x);
      return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
    };
    return {
      heading: ratio(notice.querySelector('.chat-save-notice-heading')),
      text: ratio(notice.querySelector('.chat-save-notice-text')),
      link: ratio(notice.querySelector('.chat-save-notice-link')),
    };
  });
}

try {
  await poll(() => page.evaluate(() => !!document.querySelector('#chat-messages > .chat-msg')), { what: 'chat' });
  model.queueAnswer({ match: 'LOOK-1', text: 'Radishes go in rows 20 cm apart, about 2 cm deep.' });
  await sendChat(page, 'How far apart do the radishes go? LOOK-1');
  await poll(() => page.evaluate(() => !document.getElementById('chat-save-notice').hidden), { what: 'banner' });
  await poll(() => page.evaluate(() => !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
    { what: 'run finished' });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 300));
    console.log(theme, JSON.stringify(await contrasts()));
    await page.locator('#chat-panel').screenshot({ path: path.join(SHOTS, `chat-save-notice-${locale}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  // Keyboard: the link takes the focus ring.
  await page.evaluate(() => document.getElementById('chat-save-notice-link').focus({ focusVisible: true }));
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await new Promise((r) => setTimeout(r, 200));
  await page.locator('#chat-save-notice').screenshot({ path: path.join(SHOTS, `chat-save-notice-${locale}-focus.png`) });
  await page.setViewportSize({ width: 900, height: 760 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await page.locator('#chat-panel').screenshot({ path: path.join(SHOTS, `chat-save-notice-${locale}-narrow.png`) });
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
