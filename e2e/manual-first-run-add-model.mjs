// Look instead of trust (#807): a fresh profile lists OpenAI · gpt-5-mini
// without a key. "Add model" with OpenAI, the suggested model and a key has to
// complete that entry instead of refusing it; without a key the refusal names
// the entry. Photographs both, light and dark, and checks that Apply stores
// the key. Not a test — a look.
//
//   node e2e/manual-first-run-add-model.mjs [en|de]
//
// Result: out/mockup/first-run-add-model-<locale>-<state>-<theme>.png

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { launchApp, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');

const userDataDir = await makeTempDir('snotra-first-run-userdata-');
await mkdir(SHOTS, { recursive: true });
// Only the language; everything else is what a first start finds.
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');

const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

const isHidden = (id) => page.evaluate((id) => document.getElementById(id).classList.contains('hidden'), id);
const rowTitles = () => page.evaluate(() =>
  [...document.querySelectorAll('#pref-model-list strong')].map((n) => n.textContent));

async function shoot(state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: path.join(SHOTS, `first-run-add-model-${locale}-${state}-${theme}.png`) });
  }
}

async function addOpenAi(apiKey) {
  await page.evaluate(() => document.getElementById('btn-open-add-model').click());
  await poll(async () => !(await isHidden('add-model-overlay')), { what: 'open add-model dialog' });
  await page.evaluate(() => {
    const select = document.getElementById('select-provider');
    select.value = 'openai';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  if (apiKey) await page.locator('#input-api-key').fill(apiKey);
  await page.evaluate(() => document.getElementById('btn-add-preset-row').click());
  await new Promise((r) => setTimeout(r, 200));
}

try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800));
  // A fresh profile has no folder to draw; the composer tells that the
  // renderer is up and listens to the menu.
  await poll(() => page.evaluate(() => !!document.getElementById('btn-open-add-model')), { what: 'renderer' });
  await poll(async () => {
    if (await isHidden('modal-settings')) {
      await app.evaluate(({ Menu }) => {
        for (const top of Menu.getApplicationMenu().items) {
          const item = top.submenu?.items.find((i) => /^(Einstellungen|Settings)/.test(i.label ?? ''));
          if (item) { item.click(); return; }
        }
      });
    }
    return !(await isHidden('modal-settings'));
  }, { what: 'open settings dialog' });
  // Opening loads in steps and clears the popup's status on the way; Apply
  // comes on once it is done.
  await poll(() => page.evaluate(() => !document.getElementById('btn-settings-save').disabled),
    { what: 'settings loaded' });
  console.log('fresh list:', await rowTitles());

  // Without a key: refused, and the message names the entry.
  await addOpenAi('');
  console.log('without key — popup open:', !(await isHidden('add-model-overlay')),
    '— status:', await page.evaluate(() => document.getElementById('model-status').textContent));
  await shoot('refused');
  await page.keyboard.press('Escape');
  await poll(async () => isHidden('add-model-overlay'), { what: 'closed add-model dialog' });

  // With a key: the entry takes it, the popup closes.
  await addOpenAi('sk-test-807-not-a-real-key');
  console.log('with key — popup closed:', await isHidden('add-model-overlay'),
    '— rows:', await rowTitles(),
    '— focus:', await page.evaluate(() => document.activeElement?.getAttribute('aria-label')));
  await shoot('completed');

  await page.evaluate(() => document.getElementById('btn-settings-save').click());
  const config = path.join(userDataDir, 'llm-config.json');
  await poll(async () => {
    try { return !!JSON.parse(await readFile(config, 'utf8')).providers?.openai?.apiKeyEnc; } catch { return false; }
  }, { what: 'stored key' });
  const stored = JSON.parse(await readFile(config, 'utf8'));
  console.log('stored presets:', stored.presets.map((p) => `${p.providerId} · ${p.model}`),
    '— key stored:', !!stored.providers.openai.apiKeyEnc);
} finally {
  await snotra.stop().catch(() => {});
}
