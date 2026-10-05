// Look instead of trust: an entry with an OpenAI model below GPT-5 (#724).
// Starts the real app with one such entry next to a current one, photographs
// the preference list and the edit dialog of the older entry, light and dark.
// Not a test — a look.
//
//   node e2e/manual-older-openai-model.mjs
//
// Result: out/mockup/older-model-{list,dialog}-<theme>.png

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-older-model-');
const userDataDir = await makeTempDir('snotra-older-model-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example project\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });

// Two OpenAI entries behind the fake model: a current one and an older one.
const configPath = path.join(userDataDir, 'llm-config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
config.presets.push(
  { id: 'current', providerId: 'openai', model: 'gpt-5-mini', reasoningEffort: 'high', menuVisible: true },
  { id: 'older', providerId: 'openai', model: 'gpt-4o-mini', reasoningEffort: 'medium', menuVisible: true },
);
await writeFile(configPath, JSON.stringify(config), 'utf8');

const snotra = await launchApp({ userDataDir });
const { page, app } = snotra;

const shoot = async (name, selector) => {
  const box = await page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
  const file = path.join(SHOTS, `older-model-${name}.png`);
  await page.screenshot({ path: file, clip: box });
  console.log(`${name}: ${Math.round(box.width)}×${Math.round(box.height)}`);
};

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 860));

  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /^(Einstellungen|Settings)/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() =>
    !document.getElementById('modal-settings').classList.contains('hidden')),
  { what: 'open settings dialog' });
  await poll(() => page.evaluate(() =>
    document.querySelectorAll('#pref-model-list .settings-pref-row-inner').length === 3),
  { what: 'three entries in the list' });

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(150);
    await shoot(`list-${theme}`, '#pref-model-list');
  }
  console.log('rows:', await page.evaluate(() =>
    [...document.querySelectorAll('#pref-model-list .settings-pref-main')]
      .map((m) => m.innerText.replace(/\n/g, ' | '))));

  await page.evaluate(() => {
    const row = document.querySelector('#pref-model-list .settings-pref-row-inner[data-preset-id="older"]');
    row.closest('li').querySelector('.settings-icon-edit').click();
  });
  await poll(() => page.evaluate(() =>
    !document.getElementById('add-model-overlay').classList.contains('hidden')),
  { what: 'open edit dialog' });

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(150);
    await shoot(`dialog-${theme}`, '#dialog-add-model');
  }
  console.log('dialog:', await page.evaluate(() => ({
    model: document.getElementById('select-model').value,
    fieldsHidden: document.getElementById('preset-fields-popup').classList.contains('hidden'),
    hint: document.getElementById('model-offer-hint').textContent,
  })));

  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
