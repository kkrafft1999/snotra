// Look instead of trust (#1319): the cards about knowledge files in the real
// app — a file tool writing AGENTS.md, and a shell command that changed it,
// with Keep / Reset. Not a test — a look.
//
//   node e2e/manual-knowledge-cards.mjs [de]
//
//   out/mockup/knowledge-cards-<locale>-<write|change>-<theme>.png

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const WRITE = 'Add the test command to AGENTS.md.';
const CHANGE = 'Append the lint command with the shell.';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-knowledge-cards-');
const userDataDir = await makeTempDir('snotra-knowledge-cards-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'AGENTS.md'), '# Notes for agents\n\n- Tests run with npm test.\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale, shellExecutionEnabled: true }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { page } = snotra;
const PENDING = '#chat-messages .chat-approval-card[data-state="pending"]';

async function pendingCard() {
  return poll(() => page.evaluate((selector) => {
    const el = [...document.querySelectorAll(selector)].at(-1);
    const once = el?.querySelector('button[data-response="allow-once"]');
    if (!el || !once || once.disabled) return null;
    return el.innerText.replace(/\n+/g, ' | ');
  }, PENDING), { what: 'pending card', timeoutMs: 30_000 });
}

async function shoot(name) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 300));
    await page.locator(PENDING).last().screenshot({ path: path.join(SHOTS, `knowledge-cards-${locale}-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

async function answer(response) {
  await page.evaluate(([selector, value]) =>
    document.querySelector(`${selector} button[data-response="${value}"]`).click(), [PENDING, response]);
  await poll(() => page.evaluate(() => !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
    { what: 'run finished', timeoutMs: 60_000 });
}

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0), { what: 'drawn tree' });

  model.queueAnswer({ match: WRITE, toolCalls: [{ name: 'edit_file', arguments: { relative_path: 'AGENTS.md', old_string: '- Tests run with npm test.', new_string: '- Tests run with npm test.\n- Lint with npm run lint.' } }] });
  model.queueAnswer({ text: 'Done.' });
  await sendChat(page, WRITE);
  console.log('write card:', await pendingCard());
  await shoot('write');
  await answer('deny');

  model.queueAnswer({ match: CHANGE, toolCalls: [{ name: 'shell_execute', arguments: { command: 'echo "- Lint with npm run lint." >> AGENTS.md' } }] });
  model.queueAnswer({ text: 'Done.' });
  await sendChat(page, CHANGE);
  // The command itself asks first in Smart.
  await pendingCard();
  await page.evaluate((selector) => document.querySelector(`${selector} button[data-response="allow-once"]`).click(), PENDING);
  await poll(() => page.evaluate((selector) => {
    const el = [...document.querySelectorAll(selector)].at(-1);
    return el && /knowledge|Wissensdatei/.test(el.textContent) ? true : null;
  }, PENDING), { what: 'knowledge change card', timeoutMs: 60_000 });
  console.log('change card:', await pendingCard());
  await shoot('change');
  await answer('deny');
  console.log('AGENTS.md after Reset:', JSON.stringify(await readFile(path.join(workspace, 'AGENTS.md'), 'utf8')));
  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop();
  await model.close();
}
