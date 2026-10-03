// Look instead of trust (#551, #555): starts the real app with both execution
// tools switched on, lets the fake model ask for
//  1. a shell command that takes a script on stdin,
//  2. a Python program with stdin and arguments,
//  3. a Python program past the old 4,000-character cut,
//  4. an edit_file replacement of every occurrence,
// and photographs each approval card, light and dark. Every card is denied —
// nothing runs.
// Not a test — a look.
//
//   node e2e/manual-input-card.mjs [en|de]
//
// Result: out/mockup/input-card-<locale>-{shell,python,long,edit}-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');

const CALLS = [
  {
    name: 'shell',
    question: 'Run the setup script please.',
    call: {
      name: 'shell_execute',
      arguments: {
        command: 'sh',
        stdin: 'set -e\nmkdir -p build\ncp -R assets build/\necho "copied $(ls build | wc -l) entries"\n',
      },
    },
  },
  {
    name: 'python',
    question: 'Count the words please.',
    call: {
      name: 'run_python',
      arguments: {
        code: 'import sys\n\ntext = sys.stdin.read()\nprint(sys.argv[1], len(text.split()))\n',
        stdin: 'The quick brown fox\njumps over the lazy dog.',
        argv: ['--label', 'words in input'],
      },
    },
  },
  {
    // Past the old 4,000-character cut: the card must hold all of it, and
    // "show in full" has to lift the limit of every block at once.
    name: 'long',
    question: 'Run the long program please.',
    call: {
      name: 'run_python',
      arguments: {
        code: Array.from({ length: 300 }, (_, i) => `print("line ${i + 1}")`).join('\n') + '\nprint("LAST LINE")',
        stdin: Array.from({ length: 40 }, (_, i) => `row ${i + 1}`).join('\n'),
      },
    },
  },
  {
    name: 'edit',
    question: 'Rename the constant please.',
    call: {
      name: 'edit_file',
      arguments: { relative_path: 'README.md', old_string: 'Example', new_string: 'Sample', replace_all: true },
    },
  },
];

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-input-card-');
const userDataDir = await makeTempDir('snotra-input-card-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n\nAn Example project.\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(
  path.join(userDataDir, 'ui-preferences.json'),
  JSON.stringify({ appLocale: locale, shellExecutionEnabled: true, pythonExecutionEnabled: true }),
  'utf8',
);
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

function ask(question) {
  return page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, question);
}

function pendingCard() {
  return poll(() => page.evaluate(() => {
    const el = [...document.querySelectorAll('#chat-messages .chat-approval-card[data-state="pending"]')].at(-1);
    const once = el?.querySelector('button[data-response="allow-once"]');
    if (!el || !once || once.disabled) return null;
    return {
      blocks: [...el.querySelectorAll('.chat-approval-card__preview-label')].map((label) => label.textContent),
      texts: [...el.querySelectorAll('.chat-approval-card__preview-text')].map((pre) => pre.textContent),
      toggleHidden: el.querySelector('.chat-approval-card__preview-toggle')?.hidden ?? null,
    };
  }), { what: 'pending approval card', timeoutMs: 30_000 });
}

async function idle() {
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 60_000 });
}

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  for (const { name, question, call } of CALLS) {
    model.queueAnswer({ match: question, toolCalls: [call] });
    await ask(question);
    const card = await pendingCard();
    console.log(`${name}:`, JSON.stringify({ ...card, texts: card.texts.map((text) => (text.length > 200 ? `${text.slice(0, 60)}… (${text.length} chars)` : text)) }));
    const locator = page.locator('#chat-messages .chat-approval-card[data-state="pending"]').last();
    if (name === 'long') {
      const expanded = await page.evaluate(() => {
        const el = [...document.querySelectorAll('#chat-messages .chat-approval-card[data-state="pending"]')].at(-1);
        el.querySelector('.chat-approval-card__preview-toggle').click();
        return [...el.querySelectorAll('.chat-approval-card__preview-text')]
          .map((pre) => pre.classList.contains('chat-approval-card__preview-text--clamped'));
      });
      console.log('long: clamped after "show in full":', JSON.stringify(expanded));
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('#chat-messages .chat-approval-card[data-state="pending"]')].at(-1);
        el.querySelector('.chat-approval-card__preview-toggle').click();
      });
    }
    await locator.scrollIntoViewIfNeeded();
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await new Promise((r) => setTimeout(r, 300));
      await locator.screenshot({ path: path.join(SHOTS, `input-card-${locale}-${name}-${theme}.png`) });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.evaluate(() =>
      document.querySelector('#chat-messages .chat-approval-card[data-state="pending"] button[data-response="deny"]').click());
    await idle();
  }
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
