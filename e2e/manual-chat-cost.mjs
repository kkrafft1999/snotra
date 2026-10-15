// Look instead of trust (#949): starts the real app, lets the fake model
// answer twice — once priced through a price of the user's own, once with a
// second model the table does not know — and photographs the cost chip with
// its popover, the history row and the price section of Settings › Models,
// light and dark.
// Not a test — a look.
//
//   node e2e/manual-chat-cost.mjs [en|de]
//
// Result: out/mockup/chat-cost-<locale>-{composer,popover,history,settings,settings-form}-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
await mkdir(SHOTS, { recursive: true });

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-cost-look-');
const userDataDir = await makeTempDir('snotra-cost-look-userdata-');
await writeFile(path.join(workspace, 'README.md'), '# Garden Planner\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
// $1.75 / $14 per million, like a current OpenAI model.
await writeFile(path.join(userDataDir, 'model-prices.json'),
  JSON.stringify({ overrides: { 'fake-model': { input: 1.75e-6, output: 14e-6 } } }), 'utf8');

const snotra = await launchApp({ userDataDir });
const { page } = snotra;
await page.setViewportSize({ width: 1280, height: 820 }).catch(() => {});

async function shoot(name, locator) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 300));
    const file = path.join(SHOTS, `chat-cost-${locale}-${name}-${theme}.png`);
    if (locator) await locator.screenshot({ path: file });
    else await page.screenshot({ path: file });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

try {
  await poll(() => page.evaluate(() => !!document.querySelector('#chat-messages > .chat-msg')), { what: 'chat' });
  for (let i = 1; i <= 3; i += 1) {
    model.queueAnswer({ match: `LOOK-${i}`, text: 'The radishes go in rows 20 cm apart.' });
    await sendChat(page, `How far apart do the radishes go? LOOK-${i}`);
    await poll(() => page.evaluate(() => !document.querySelector('.chat-cost-wrap')?.hidden), { what: 'cost chip' });
    await poll(() => page.evaluate(() => !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
      { what: 'run finished' });
  }
  const composer = page.locator('#chat-input-row');
  await shoot('composer', composer);

  await page.evaluate(() => document.getElementById('chat-cost').click());
  await new Promise((r) => setTimeout(r, 200));
  await shoot('popover', page.locator('#chat-panel'));
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    if (document.getElementById('app').classList.contains('app--no-history')) {
      document.getElementById('btn-toggle-chat-history').click();
    }
  });
  await poll(() => page.evaluate(() => !!document.querySelector('.chat-history-row-cost')), { what: 'history cost' });
  await shoot('history', page.locator('.chat-history-row--current'));

  // The price of the fake model removed for the settings view: "No price known".
  await page.evaluate(() => window.electronAPI.setModelPriceOverride('fake-model', null));
  await snotra.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('ui:open-settings');
  });
  await poll(() => page.evaluate(() => !!document.querySelector('.model-prices__row')), { what: 'price list' });
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => document.getElementById('settings-model-prices-card').scrollIntoView({ block: 'start' }));
  await shoot('settings', page.locator('#settings-model-prices-card'));
  await page.evaluate(() => document.querySelector('.model-prices__row [data-action="edit"]').click());
  await page.evaluate(() => {
    const form = document.querySelector('.model-prices__form');
    form.elements.namedItem('input').value = '1.75';
    form.requestSubmit();
  });
  await new Promise((r) => setTimeout(r, 300));
  await shoot('settings-form', page.locator('#settings-model-prices-card'));
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
