// Look instead of trust: the reasoning level in the model menu (#727).
// Starts the real app with an OpenAI entry (a key that is never used — no
// message is sent), an older OpenAI model and the same local model on two
// servers. Photographs the open menu light and dark, with a level chosen by
// keyboard, for a model without levels, and in a narrow chat column.
// Not a test — a look.
//
//   node e2e/manual-reasoning-menu.mjs [de|en]
//
// Result: out/mockup/reasoning-menu-<state>.png

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const locale = process.argv[2] === 'en' ? 'en' : 'de';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-reasoning-menu-');
const userDataDir = await makeTempDir('snotra-reasoning-menu-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example project\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');

const configPath = path.join(userDataDir, 'llm-config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
config.presets[0].connection.displayName = 'Ollama';
config.presets.push(
  {
    id: 'studio',
    providerId: 'openai-compatible',
    model: 'fake-model',
    menuVisible: true,
    connection: { ...config.presets[0].connection, displayName: 'Mac Studio', baseUrl: 'http://127.0.0.1:9/v1' },
  },
  { id: 'current', providerId: 'openai', model: 'gpt-5-mini', menuVisible: true },
  { id: 'older', providerId: 'openai', model: 'gpt-4o-mini', menuVisible: true },
);
await writeFile(configPath, JSON.stringify(config), 'utf8');

const snotra = await launchApp({ userDataDir });
const { page, app } = snotra;

const shoot = async (name) => {
  const box = await page.evaluate(() => {
    const parts = ['chat-model-menu', 'chat-input-row']
      .map((id) => document.getElementById(id))
      .filter((el) => el && !el.classList.contains('hidden'))
      .map((el) => el.getBoundingClientRect());
    const x = Math.min(...parts.map((r) => r.left)) - 8;
    const y = Math.min(...parts.map((r) => r.top)) - 8;
    const right = Math.max(...parts.map((r) => r.right)) + 8;
    const bottom = Math.max(...parts.map((r) => r.bottom)) + 8;
    return { x, y, width: right - x, height: bottom - y };
  });
  await page.screenshot({ path: path.join(SHOTS, `reasoning-menu-${name}.png`), clip: box });
  console.log(`${name}: ${Math.round(box.width)}×${Math.round(box.height)}`);
};

const openMenu = async () => {
  await page.evaluate(() => {
    if (document.getElementById('chat-model-menu').classList.contains('hidden')) {
      document.getElementById('btn-chat-model-picker').click();
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('chat-model-menu').classList.contains('hidden')),
    { what: 'open model menu' });
};

const closeMenu = () => page.keyboard.press('Escape');

// Colours change with a transition; a shot right after the switch would catch
// it half way.
const theme = async (name) => {
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, name);
  await page.waitForTimeout(400);
};

const choose = async (presetId) => {
  await openMenu();
  await page.click(`.chat-model-menu-option[data-preset-id="${presetId}"]`);
  await poll(() => page.evaluate((id) => window.electronAPI.getLLMState().then((s) => s.activePresetId === id), presetId),
    { what: `entry ${presetId} active` });
};

const describe = () => page.evaluate(() => ({
  pill: document.getElementById('chat-model-pill-label').textContent,
  name: document.getElementById('btn-chat-model-picker').getAttribute('aria-label'),
  models: [...document.querySelectorAll('#chat-model-list .chat-model-menu-option')].map((o) => o.textContent),
  levels: document.getElementById('chat-reasoning').hidden
    ? null
    : [...document.querySelectorAll('#chat-reasoning-levels input')].map((i) => (i.checked ? `[${i.value}]` : i.value)).join(' '),
}));

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));

  // A key that is only stored, never sent: nothing below sends a message.
  const presets = JSON.parse(await readFile(configPath, 'utf8')).presets;
  const committed = await page.evaluate((rows) => window.electronAPI.commitSettings({
    presets: rows,
    activePresetId: 'current',
    providerPatches: { openai: { apiKey: 'sk-look-not-a-real-key' } },
  }), presets);
  if (!committed?.ok) throw new Error(`settings not saved: ${JSON.stringify(committed)}`);
  // The renderer reads the entries afresh after a reload.
  await page.reload();
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#chat-model-list').length)) > 0
    && (await page.evaluate(() => !document.getElementById('btn-chat-model-picker').classList.contains('hidden'))),
  { what: 'pill after reload' });
  // The restored chat's activation closes menus; let it land first.
  await page.waitForTimeout(1000);
  await choose('current');

  await theme('light');
  await openMenu();
  console.log('open:', await describe());
  await shoot('light');

  // Keyboard: Tab from the list to the levels, one step to the right.
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowRight');
  await poll(() => page.evaluate(() =>
    document.getElementById('chat-model-pill-label').textContent.endsWith('high')),
  { what: 'pill shows high' });
  await theme('dark');
  console.log('after ArrowRight:', await describe());
  await shoot('dark-keyboard');
  await closeMenu();

  await theme('light');
  await choose('older');
  await openMenu();
  console.log('older model:', await describe());
  await shoot('light-older-model');
  await closeMenu();

  // A narrow chat column: the menu moves left until it fits the window.
  await choose('current');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 860));
  await page.evaluate(() => { document.getElementById('chat-panel').style.width = '300px'; });
  await page.waitForTimeout(200);
  await openMenu();
  console.log('narrow:', await page.evaluate(() => {
    const r = document.getElementById('chat-model-menu').getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), window: window.innerWidth };
  }));
  await theme('dark');
  await shoot('dark-narrow');

  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
