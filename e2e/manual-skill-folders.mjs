// Look instead of trust (#429): starts the real app with a global skill under
// a temporary home folder and shell_execute on, then
//  1. loads the skill and edits its asset file — photographs the approval card
//     and reports whether the file changed,
//  2. loads it again and appends to the file from a shell run in the skill
//     folder — photographs the card with the skill folders the sandbox opens,
//     and reports what the run and the model saw,
//  3. edits the file without loading the skill and reports the refusal.
// Not a test — a look. Run it outside the Claude Code sandbox, or the app's
// own sandbox cannot start (macOS does not nest them).
//
//   node e2e/manual-skill-folders.mjs [en|de]
//
// Result: out/mockup/skill-folders-<locale>-*.png

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const EDIT = 'Remember that stand-ups go to the project task.';
const SHELL = 'Append the retro rule with the script.';
const UNLOADED = 'Change the rules without loading.';
const BODY_MARK = 'The rules live in assets/rules.md';

const model = await startFakeModel();
const home = await mkdtemp(path.join(tmpdir(), 'snotra-skill-home-'));
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-skill-ws-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-skill-userdata-'));
const skillDir = path.join(home, '.snotra', 'skills', 'time-booking');
const rulesFile = path.join(skillDir, 'assets', 'rules.md');
await mkdir(SHOTS, { recursive: true });
await mkdir(path.join(skillDir, 'assets'), { recursive: true });
await writeFile(
  path.join(skillDir, 'SKILL.md'),
  `---\nname: time-booking\ndescription: Books working time and keeps the learned mapping rules up to date.\n---\n\n${BODY_MARK}. Update them when the user teaches a new one.\n`,
  'utf8',
);
await writeFile(rulesFile, '# Rules\n\n- Mail and admin → Internal\n', 'utf8');
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(
  path.join(userDataDir, 'ui-preferences.json'),
  JSON.stringify({
    appLocale: locale,
    shellExecutionEnabled: true,
    activeSkills: ['time-booking', 'snotra-capabilities', 'snotra-memory'],
  }),
  'utf8',
);

// The app reads global skills from the home folder; this one is temporary.
process.env.HOME = home;
const snotra = await launchApp({ userDataDir });
const { page } = snotra;
const shot = (name) => path.join(SHOTS, `skill-folders-${locale}-${name}.png`);
const pause = (ms = 350) => new Promise((r) => setTimeout(r, ms));

async function themed(name, take) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause();
    await take(shot(`${name}-${theme}`));
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

function ask(question) {
  return page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, question);
}

async function idle() {
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 90_000 });
}

function pendingCard() {
  return page.locator('#chat-messages .chat-approval-card[data-state="pending"]').last();
}

async function waitForCard(what) {
  await poll(() => page.evaluate(() => !!document.querySelector('#chat-messages .chat-approval-card[data-state="pending"]')),
    { what, timeoutMs: 30_000 });
  await pause(400);
}

function toolResults() {
  return model.requests
    .filter((r) => !r.isTitleRequest)
    .flatMap((r) => r.body?.messages || [])
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
}

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  // 1. Load, then edit the asset file.
  model.queueAnswer({ match: EDIT, toolCalls: [{ name: 'load_skill', arguments: { name: 'time-booking' } }] });
  model.queueAnswer({
    match: BODY_MARK,
    toolCalls: [{
      name: 'edit_file',
      arguments: {
        relative_path: rulesFile,
        old_string: '- Mail and admin → Internal\n',
        new_string: '- Mail and admin → Internal\n- Stand-ups → Project task\n',
      },
    }],
  });
  await ask(EDIT);
  await waitForCard('edit card');
  console.log('edit card:', await pendingCard().evaluate((el) => el.textContent.replace(/\s+/g, ' ').slice(0, 500)));
  await themed('edit', (file) => pendingCard().screenshot({ path: file }));
  await pendingCard().evaluate((el) => el.querySelector('button[data-response="allow-once"]').click());
  await idle();
  console.log('tool log:', await page.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .chat-message')].at(-1)?.textContent.replace(/\s+/g, ' ').slice(0, 300)));
  console.log('file after edit:', JSON.stringify(await readFile(rulesFile, 'utf8')));

  // 2. Load again (a new reply starts with nothing loaded), then a shell run
  //    in the skill folder.
  model.queueAnswer({ match: SHELL, toolCalls: [{ name: 'load_skill', arguments: { name: 'time-booking' } }] });
  model.queueAnswer({
    match: BODY_MARK,
    toolCalls: [{ name: 'shell_execute', arguments: { command: "printf -- '- Retro → Internal\\n' >> assets/rules.md", cwd: 'skill:time-booking' } }],
  });
  await ask(SHELL);
  await waitForCard('shell card');
  console.log('shell card:', await pendingCard().evaluate((el) => el.textContent.replace(/\s+/g, ' ').slice(0, 700)));
  await themed('shell', (file) => pendingCard().screenshot({ path: file }));
  await pendingCard().evaluate((el) => el.querySelector('button[data-response="allow-once"]').click());
  await idle();
  const shellResult = toolResults().at(-1) || '';
  let parsed = null;
  try { parsed = JSON.parse(shellResult); } catch { /* printed raw */ }
  console.log('shell exit code:', parsed?.exit_code, 'stderr:', String(parsed?.stderr ?? shellResult).slice(0, 400));
  console.log('sandbox as the model read it:', JSON.stringify(parsed?.sandbox));
  console.log('file after shell:', JSON.stringify(await readFile(rulesFile, 'utf8')));

  // 3. Without loading the skill first.
  model.queueAnswer({
    match: UNLOADED,
    toolCalls: [{ name: 'write_file_text', arguments: { relative_path: 'skill:time-booking/assets/rules.md', content: 'gone' } }],
  });
  await ask(UNLOADED);
  await idle();
  console.log('unloaded write:', toolResults().at(-1));
  console.log('file at the end:', JSON.stringify(await readFile(rulesFile, 'utf8')));
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
