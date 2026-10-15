// Look instead of trust (#764): starts the real app with a skill in the open
// folder, switched on there, under a temporary home folder, then
//  1. opens Settings › Skills, unfolds the skill and photographs the
//     "Make global…" button, light and dark, and with the keyboard focus on it,
//  2. answers the native confirmation by a stand-in in main — the dialog
//     itself cannot be photographed — and reports what it said,
//  3. photographs the skill under its new source and reports where the folder
//     and its switch-on went.
// Not a test — a look.
//
//   node e2e/manual-skill-make-global.mjs [en|de]
//
// Result: out/mockup/skill-make-global-<locale>-*.png

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const home = await makeTempDir('snotra-make-global-home-');
const workspace = await makeTempDir('snotra-make-global-ws-');
const userDataDir = await makeTempDir('snotra-make-global-userdata-');
const skillDir = path.join(workspace, '.agents', 'skills', 'release-notes');
await mkdir(SHOTS, { recursive: true });
await mkdir(skillDir, { recursive: true });
await writeFile(
  path.join(skillDir, 'SKILL.md'),
  '---\nname: release-notes\ndescription: Writes release notes from the merged pull requests, in the team\'s format.\n---\n\nList the pull requests since the last tag.\n',
  'utf8',
);
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(
  path.join(userDataDir, 'ui-preferences.json'),
  JSON.stringify({
    appLocale: locale,
    activeSkills: ['snotra-capabilities', 'snotra-memory', 'snotra-skill-authoring'],
    activeWorkspaceSkills: { [path.resolve(workspace)]: ['release-notes'] },
  }),
  'utf8',
);

const snotra = await launchApp({ userDataDir, home });
const { page, app } = snotra;
const shot = (name) => path.join(SHOTS, `skill-make-global-${locale}-${name}.png`);
const pause = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const modal = () => page.locator('#modal-settings .settings-dialog');

async function themed(name) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause();
    await modal().screenshot({ path: shot(`${name}-${theme}`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

try {
  await poll(() => page.evaluate(() => !!document.getElementById('btn-open-add-model')), { what: 'renderer' });
  await poll(async () => {
    await app.evaluate(({ Menu }) => {
      for (const top of Menu.getApplicationMenu().items) {
        const item = top.submenu?.items.find((i) => /^(Einstellungen|Settings)/.test(i.label ?? ''));
        if (item) { item.click(); return; }
      }
    });
    await pause(250);
    return page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden'));
  }, { what: 'settings dialog' });
  await page.click('#tab-settings-skills');
  await poll(() => page.evaluate(() =>
    Boolean(document.querySelector('li[data-skill-item="release-notes"] .settings-skill-item__summary'))),
  { what: 'folder skill in the settings', timeoutMs: 20000 });
  await page.click('li[data-skill-item="release-notes"] .settings-skill-item__summary');
  await page.locator('button[data-skill-make-global="release-notes"]').scrollIntoViewIfNeeded();
  await themed('before');
  await page.focus('button[data-skill-make-global="release-notes"]');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await themed('focus');

  // The native dialog cannot be driven from here; a stand-in in main answers
  // "Make global" and keeps what it was asked.
  await app.evaluate(({ dialog }) => {
    globalThis.__asked = [];
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.__asked.push({ type: options.type, message: options.message, detail: options.detail, buttons: options.buttons, defaultId: options.defaultId });
      return { response: 0 };
    };
  });
  await poll(() => page.evaluate(() => !!document.activeElement?.matches('button[data-skill-make-global]')),
    { what: 'the keyboard focus on "Make global…"' });
  await page.keyboard.press('Enter');
  await poll(() => page.evaluate(() =>
    !document.querySelector('button[data-skill-make-global]')
    && !!document.querySelector('li[data-skill-item="release-notes"]')), { what: 'skill moved' });
  await pause(500);
  await themed('after');

  const asked = await app.evaluate(() => globalThis.__asked);
  console.log('dialog:', JSON.stringify(asked, null, 1));
  const moved = path.join(home, '.snotra', 'skills', 'release-notes', 'SKILL.md');
  console.log('in ~/.snotra/skills:', await access(moved).then(() => true, () => false));
  console.log('still in the project:', await access(skillDir).then(() => true, () => false));
  const prefs = JSON.parse(await readFile(path.join(userDataDir, 'ui-preferences.json'), 'utf8'));
  console.log('activeSkills:', prefs.activeSkills, '— activeWorkspaceSkills:', prefs.activeWorkspaceSkills);
  console.log('focus on:', await page.evaluate(() => document.activeElement?.closest('li')?.dataset.skillItem ?? document.activeElement?.id));
  console.log(`Screenshots in ${SHOTS}`);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
