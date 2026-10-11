// Look instead of trust: the skills and tools of a chat at the composer (#773).
// Starts the real app with a folder skill that is ticked, a user skill that is
// not, a tool switched off and the execution tools left off. Photographs the
// pill, the open popover, the tools expanded, a dark and a narrow column and a
// chat without skills.
// Not a test — a look.
//
//   node e2e/manual-chat-config.mjs [de|en]
//
// Result: out/mockup/chat-config-<state>.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const locale = process.argv[2] === 'en' ? 'en' : 'de';

async function writeSkill(dir, name, description) {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(
    path.join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nInstructions.\n`,
    'utf8',
  );
}

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-chat-config-');
const userDataDir = await makeTempDir('snotra-chat-config-userdata-');
const home = await makeTempDir('snotra-chat-config-home-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example project\n', 'utf8');
await writeSkill(path.join(workspace, '.agents', 'skills'), 'release', 'Cuts a release of this project.');
await writeSkill(path.join(home, '.snotra', 'skills'), 'pdf-export', 'Turns a Markdown file into a PDF in the house style.');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({
  appLocale: locale,
  activeWorkspaceSkills: { [path.resolve(workspace)]: ['release'] },
  disabledTools: ['fetch_url'],
  chatPanelWidth: 560,
}), 'utf8');

const snotra = await launchApp({ userDataDir, home });
const { page } = snotra;

await poll(() => page.evaluate(() => !document.getElementById('chat-config-wrap').classList.contains('hidden')),
  { what: 'skills pill' });

const shoot = async (name) => {
  // Colours change with a transition; a shot right after a switch would catch it half way.
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
  await page.screenshot({ path: path.join(SHOTS, `chat-config-${name}.png`), clip: box });
  console.log(`${name}: ${Math.round(box.width)}×${Math.round(box.height)}`);
};

const isOpen = () => page.evaluate(() => !document.getElementById('chat-config-popup').classList.contains('hidden'));
const open = async () => {
  if (!(await isOpen())) await page.click('#btn-chat-config');
  await poll(isOpen, { what: 'open popover' });
  await poll(() => page.evaluate(() => document.querySelectorAll('#chat-config-popup .chat-config-row').length > 0),
    { what: 'popover rows' });
};
const close = async () => {
  if (await isOpen()) await page.keyboard.press('Escape');
};

await shoot('closed');
await open();
await shoot('open');
await page.click('#chat-config-popup .chat-config-summary');
await shoot('expanded');
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await shoot('dark');
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
await close();

// Keyboard: the pill focused, as a Tab lands on it.
await page.focus('#btn-chat-config');
await page.keyboard.press('Tab');
await page.keyboard.press('Shift+Tab');
await shoot('focus');

// Narrow: the pills take a row of their own.
await page.evaluate(() => {
  const panel = document.getElementById('chat-panel');
  panel.style.width = '320px';
  panel.style.minWidth = '320px';
  panel.style.flex = '0 0 320px';
});
await page.waitForTimeout(300);
await open();
await shoot('narrow');
await close();

const state = await page.evaluate(() => ({
  label: document.getElementById('chat-config-label').textContent,
  rows: [...document.querySelectorAll('#chat-config-popup .chat-config-row')].map((row) => row.textContent),
}));
console.log(JSON.stringify(state, null, 2));

await snotra.stop().catch(() => {});
await model.close();
