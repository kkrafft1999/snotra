// Look instead of trust: starts the real app, opens "Add model" and
// photographs the form for three providers, light and dark, at the window's
// minimum width (#414). For OpenAI it also moves the reasoning effort with the
// arrow keys, so the keyboard focus on the segmented control is in the picture.
// Not a test — a look.
//
//   node e2e/manual-add-model-dialog.mjs
//
// Result: out/mockup/add-model-<provider>-<theme>.png, plus the end of the long
// OpenAI-compatible form and two keyboard shots

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const PROVIDERS = ['openai', 'ollama', 'openai-compatible'];

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-add-model-');
const userDataDir = await makeTempDir('snotra-add-model-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example project\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });

const snotra = await launchApp({ userDataDir });
const { page, app } = snotra;

const chooseProvider = (id) => page.evaluate((id) => {
  const select = document.getElementById('select-provider');
  select.value = id;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}, id);

const shoot = async (name) => {
  const box = await page.evaluate(() => {
    const r = document.getElementById('dialog-add-model').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const file = path.join(SHOTS, `add-model-${name}.png`);
  await page.screenshot({ path: file, clip: box });
  console.log(`${name}: ${Math.round(box.width)}×${Math.round(box.height)}`);
};

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  // The narrowest window the app allows — the width the dialog has to fit.
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

  await page.evaluate(() => document.getElementById('btn-open-add-model').click());
  await poll(() => page.evaluate(() =>
    !document.getElementById('add-model-overlay').classList.contains('hidden')),
  { what: 'open add-model dialog' });

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    for (const provider of PROVIDERS) {
      await chooseProvider(provider);
      await page.waitForTimeout(150);
      await shoot(`${provider}-${theme}`);
    }
    // The long form scrolls; its end holds the switches.
    await page.evaluate(() => {
      const body = document.querySelector('#dialog-add-model .add-model-dialog__body');
      body.scrollTop = body.scrollHeight;
    });
    await shoot(`openai-compatible-${theme}-end`);
  }

  // Keyboard: focus the chosen level, one step to the right, switch on by Space.
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, 'light');
  await chooseProvider('openai');
  await page.focus('#preset-field-reasoningEffort input[value="medium"]');
  await page.keyboard.press('ArrowRight');
  const effort = await page.evaluate(() =>
    [...document.querySelectorAll('#preset-field-reasoningEffort input')].find((i) => i.checked)?.value);
  console.log('effort after ArrowRight:', effort);
  await shoot('openai-keyboard');
  await page.focus('#preset-field-reasoningSummary');
  await page.keyboard.press('Space');
  console.log('summary after Space:', await page.evaluate(() =>
    document.getElementById('preset-field-reasoningSummary').checked));
  await shoot('openai-keyboard-switch');

  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
