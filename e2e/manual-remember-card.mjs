// Look instead of trust (#1276): the remember card with kind and reader as
// pills (mockup variant A), in the real app — the proposal, a re-sorted
// reader, and a fact turned into a rule that goes back to Snotra.
// Not a test — a look.
//
//   node e2e/manual-remember-card.mjs [de]
//
//   out/mockup/remember-card-<locale>-<state>-<theme>.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const ASK = 'Remember how commit messages are written here.';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-remember-card-');
const userDataDir = await makeTempDir('snotra-remember-card-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'AGENTS.md'), '# Notes\n\n- Tests run with npm test.\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { page } = snotra;
const PENDING = '#chat-messages .chat-approval-card[data-state="pending"]';

async function shoot(name) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 300));
    await page.locator(PENDING).last().screenshot({ path: path.join(SHOTS, `remember-card-${locale}-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const text = () => page.evaluate((selector) => [...document.querySelectorAll(selector)].at(-1)?.innerText.replace(/\n+/g, ' | '), PENDING);

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0), { what: 'drawn tree' });
  model.queueAnswer({
    match: ASK,
    toolCalls: [{ name: 'remember', arguments: {
      kind: 'rule', scope: 'workspace', topic: 'commit-messages', description: 'When you write a commit message',
      text: 'When you write a commit message, write it in English, in the imperative.', origin: 'requested',
    } }],
  });
  model.queueAnswer({ text: 'Done.' });
  await sendChat(page, ASK);
  await poll(() => page.evaluate((selector) => !!document.querySelector(`${selector} .chat-approval-card__pills`), PENDING), { what: 'remember card', timeoutMs: 30_000 });
  console.log('proposal:', await text());
  await shoot('proposal');
  await page.evaluate((selector) => document.querySelector(`${selector} input[name$="remember-reader"][value="team"]`).click(), PENDING);
  console.log('team:', await text());
  await shoot('team');
  await page.evaluate((selector) => document.querySelector(`${selector} input[name$="remember-kind"][value="instruction"]`).click(), PENDING);
  console.log('procedure:', await text());
  await shoot('procedure');
  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop();
  await model.close();
}
