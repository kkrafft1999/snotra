// Look instead of trust: a model that gets no tools (#1013). Starts the real
// app on an OpenAI-compatible entry with "Send tools along" switched off and
// photographs the pill and the open popover, light and dark.
// Not a test — a look.
//
//   node e2e/manual-no-tools.mjs [de|en]
//
// Result: out/mockup/no-tools-<state>-<locale>.png

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const locale = process.argv[2] === 'en' ? 'en' : 'de';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-no-tools-');
const userDataDir = await makeTempDir('snotra-no-tools-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example project\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const configPath = path.join(userDataDir, 'llm-config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
config.presets[0].connection.sendTools = false;
await writeFile(configPath, JSON.stringify(config), 'utf8');
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale, chatPanelWidth: 560 }), 'utf8');

const snotra = await launchApp({ userDataDir });
const { page } = snotra;

await poll(() => page.evaluate(() => document.getElementById('chat-config-wrap').dataset.noTools === 'true'),
  { what: 'no-tools pill' });

const shoot = async (name) => {
  await page.waitForTimeout(250);
  const box = await page.evaluate(() => {
    const parts = ['chat-config-popup', 'chat-input-row']
      .map((id) => document.getElementById(id))
      .filter((el) => el && !el.classList.contains('hidden'))
      .map((el) => el.getBoundingClientRect());
    const x = Math.min(...parts.map((r) => r.left)) - 8;
    const y = Math.min(...parts.map((r) => r.top)) - 8;
    const right = Math.max(...parts.map((r) => r.right)) + 8;
    const bottom = Math.max(...parts.map((r) => r.bottom)) + 8;
    return { x, y, width: right - x, height: bottom - y };
  });
  await page.screenshot({ path: path.join(SHOTS, `no-tools-${name}-${locale}.png`), clip: box });
  console.log(`${name}: ${Math.round(box.width)}×${Math.round(box.height)}`);
};

await shoot('closed');
await page.click('#btn-chat-config');
await poll(() => page.evaluate(() => !!document.querySelector('#chat-config-popup .chat-config-notools')),
  { what: 'no-tools note' });
await shoot('open');
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await shoot('dark');

console.log(JSON.stringify(await page.evaluate(() => ({
  label: document.getElementById('chat-config-label').textContent,
  title: document.getElementById('btn-chat-config').title,
  note: document.querySelector('#chat-config-popup .chat-config-notools')?.textContent,
})), null, 2));

await snotra.stop().catch(() => {});
await model.close();
