// Look instead of trust (#160): starts the real app on a folder without
// skills, lets the fake model write `.agents/skills/release-notes/SKILL.md`
// and photographs the approval card, the tool log with the skill line, and
// Settings › Skills with the new skill — light and dark. Not a test — a look.
//
//   node e2e/manual-skill-authoring.mjs [en|de]
//
// Result: out/mockup/skill-authoring-<locale>-<state>-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');

const SKILL = [
  '---',
  'name: release-notes',
  'description: Writes release notes from the merged pull requests since the last tag. Use when asked for release notes or a changelog.',
  '---',
  '',
  'Collect the merged pull requests since the last tag and group them by area.',
  '',
].join('\n');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-skill-authoring-look-');
const userDataDir = await makeTempDir('snotra-skill-authoring-look-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Project\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { page, app } = snotra;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(state, take) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(250);
    await take(path.join(SHOTS, `skill-authoring-${locale}-${state}-${theme}.png`));
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  model.queueAnswer({
    match: 'release notes',
    toolCalls: [{
      name: 'write_file_text',
      arguments: { relative_path: '.agents/skills/release-notes/SKILL.md', content: SKILL },
    }],
  });
  model.queueAnswer({
    text: locale === 'de'
      ? 'Der Skill `release-notes` liegt in `.agents/skills/`. Schalte ihn unter Einstellungen › Skills ein.'
      : 'The skill `release-notes` is in `.agents/skills/`. Switch it on under Settings › Skills.',
  });
  await page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, locale === 'de' ? 'Bau mir einen Skill für release notes.' : 'Make me a skill for release notes.');

  const card = page.locator('.chat-approval-card').last();
  await poll(() => page.evaluate(() =>
    Boolean(document.querySelector('.chat-approval-card button[data-response="allow-once"]:not([disabled])'))),
  { what: 'approval card' });
  await shoot('card', (file) => card.screenshot({ path: file }));
  await page.evaluate(() =>
    document.querySelector('.chat-approval-card button[data-response="allow-once"]:not([disabled])').click());

  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')
    && document.querySelector('#chat-messages > li:last-child')?.textContent.includes('release-notes')),
  { what: 'run through', timeoutMs: 60000 });
  const log = page.locator('.chat-tool-log').last();
  await log.evaluate((el) => { el.open = true; el.scrollIntoView({ block: 'center' }); });
  await shoot('log', (file) => log.screenshot({ path: file }));

  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /^(Einstellungen|Settings)/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings dialog' });
  await page.click('#tab-settings-skills');
  await poll(() => page.evaluate(() =>
    Boolean(document.querySelector('input[type="checkbox"][data-skill-name="release-notes"]'))),
  { what: 'new skill in the settings', timeoutMs: 20000 });
  await shoot('settings', (file) => page.screenshot({ path: file }));
  console.log(`Screenshots in ${SHOTS}`);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
