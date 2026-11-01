// Look instead of trust (#1314): the remember card for a procedure — a new
// skill in the folder, and a changed skill with its diff. Not a test — a look.
//
//   node e2e/manual-remember-skill.mjs [de]
//
//   out/mockup/remember-skill-<locale>-<state>-<theme>.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const ASK = 'Remember how a release is cut here.';
const AGAIN = 'Add the test run to the release skill.';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-remember-skill-');
const userDataDir = await makeTempDir('snotra-remember-skill-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { page } = snotra;
const PENDING = '#chat-messages .chat-approval-card[data-state="pending"]';

async function shoot(name) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 300));
    await page.locator(PENDING).last().screenshot({ path: path.join(SHOTS, `remember-skill-${locale}-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const text = () => page.evaluate((selector) => [...document.querySelectorAll(selector)].at(-1)?.innerText.replace(/\n+/g, ' | '), PENDING);

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0), { what: 'drawn tree' });
  const BODY = '# Cutting a release\n\n1. Bump the version in package.json.\n2. Tag the commit.\n3. Push the tag.';
  model.queueAnswer({ match: ASK, toolCalls: [{ name: 'remember', arguments: {
    kind: 'instruction', scope: 'workspace', topic: 'release', description: 'How a release is cut: bump, tag, push', body: BODY, origin: 'requested',
  } }] });
  model.queueAnswer({ text: 'Done.' });
  await sendChat(page, ASK);
  await poll(() => page.evaluate((selector) => !!document.querySelector(`${selector} .chat-approval-card__pills`), PENDING), { what: 'skill card', timeoutMs: 30_000 });
  console.log('new:', await text());
  await shoot('new');
  await page.evaluate((selector) => document.querySelector(`${selector} button[data-response="allow-once"]`).click(), PENDING);
  await poll(() => page.evaluate(() => !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')), { what: 'run finished', timeoutMs: 60_000 });
  model.queueAnswer({ match: AGAIN, toolCalls: [{ name: 'remember', arguments: {
    kind: 'instruction', scope: 'workspace', topic: 'release', body: BODY.replace('2. Tag', '2. Run the tests.\n3. Tag').replace('3. Push', '4. Push'), origin: 'requested',
  } }] });
  model.queueAnswer({ text: 'Done.' });
  await sendChat(page, AGAIN);
  await poll(() => page.evaluate((selector) => !!document.querySelector(`${selector} .chat-approval-card__pills`), PENDING), { what: 'changed skill card', timeoutMs: 30_000 });
  console.log('changed:', await text());
  await shoot('changed');
  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop();
  await model.close();
}
