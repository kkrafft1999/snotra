// Look instead of trust (#548): starts the real app with a global skill under
// a temporary home folder and shell_execute on, then
//  1. loads the skill and tries to edit its asset file — reports the refusal
//     the model reads and that the file stayed as it was,
//  2. tries a shell run in the skill folder and reports the refusal,
//  3. keeps the new rule in .agents/data/ of the open folder instead —
//     photographs the approval card and reports the file it wrote.
// Not a test — a look. Run it outside the Claude Code sandbox, or the app's
// own sandbox cannot start (macOS does not nest them).
//
//   node e2e/manual-skill-folders.mjs [en|de]
//
// Result: out/mockup/skill-folders-<locale>-*.png

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const EDIT = 'Remember that stand-ups go to the project task.';
const SHELL = 'Append the retro rule with the script.';
const DATA = 'Keep the stand-up rule for this project.';
const DATA_FILE = '.agents/data/time-booking-rules.md';
const BODY_MARK = 'The rules live in assets/rules.md';

const model = await startFakeModel();
const home = await makeTempDir('snotra-skill-home-');
const workspace = await makeTempDir('snotra-skill-ws-');
const userDataDir = await makeTempDir('snotra-skill-userdata-');
const skillDir = path.join(home, '.snotra', 'skills', 'time-booking');
const rulesFile = path.join(skillDir, 'assets', 'rules.md');
await mkdir(SHOTS, { recursive: true });
await mkdir(path.join(skillDir, 'assets'), { recursive: true });
await writeFile(
  path.join(skillDir, 'SKILL.md'),
  `---\nname: time-booking\ndescription: Books working time and keeps the learned mapping rules up to date.\n---\n\n${BODY_MARK}. Keep new ones in <workspace>/${DATA_FILE}.\n`,
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
const snotra = await launchApp({ userDataDir, home });
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

  // 1. Load, then try to edit the asset file: refused before any card.
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
  await idle();
  console.log('load_skill as the model read it:', toolResults().at(-2));
  console.log('edit as the model read it:', toolResults().at(-1));
  console.log('file after edit:', JSON.stringify(await readFile(rulesFile, 'utf8')));

  // 2. A shell run in the skill folder: refused as well.
  model.queueAnswer({
    match: SHELL,
    toolCalls: [{ name: 'shell_execute', arguments: { command: "printf -- '- Retro → Internal\\n' >> assets/rules.md", cwd: 'skill:time-booking' } }],
  });
  await ask(SHELL);
  await idle();
  console.log('shell as the model read it:', toolResults().at(-1));
  console.log('file after shell:', JSON.stringify(await readFile(rulesFile, 'utf8')));

  // 3. Keep it in the project instead: an ordinary write with a card.
  model.queueAnswer({
    match: DATA,
    toolCalls: [{
      name: 'write_file_text',
      arguments: { relative_path: DATA_FILE, content: '# Rules\n\n- Stand-ups → Project task\n' },
    }],
  });
  await ask(DATA);
  await waitForCard('data card');
  console.log('data card:', await pendingCard().evaluate((el) => el.textContent.replace(/\s+/g, ' ').slice(0, 500)));
  await themed('data', (file) => pendingCard().screenshot({ path: file }));
  await pendingCard().evaluate((el) => el.querySelector('button[data-response="allow-once"]').click());
  await idle();
  console.log('data file:', JSON.stringify(await readFile(path.join(workspace, DATA_FILE), 'utf8')));
  console.log('skill file at the end:', JSON.stringify(await readFile(rulesFile, 'utf8')));
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
