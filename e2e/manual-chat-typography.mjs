// Look instead of trust: starts the real app with an answer that holds links,
// inline code and a list, types a draft into the input, and takes screenshots
// of the chat in both themes (#1362). Not a test — a look.
//
//   node e2e/manual-chat-typography.mjs
//
// Result: out/mockup/chat-typography-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const QUESTION = 'Why is the new issue already on the board, although the rule says otherwise?';
const ANSWER = [
  'Something caught my eye on the way: [.claude/rules/task-management.md](https://github.com/kkrafft1999/snotra/blob/main/.claude/rules/task-management.md) says new issues do not land on the board by themselves. [kkrafft1999/snotra#1358](https://github.com/kkrafft1999/snotra/issues/1358) was in the backlog right after it was created, though, and `item-add` reported "Content already exists".',
  '',
  'So the board picks up new issues by itself now. Two things follow:',
  '',
  '- adjust the rule in `task-management.md`,',
  '- set the column only with `gh project item-edit`.',
].join('\n');
const DRAFT = 'Good, then please adjust the rule right away';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-chat-typography-');
const userDataDir = await makeTempDir('snotra-chat-typography-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

try {
  await poll(() => page.evaluate(() => !!document.getElementById('chat-input')), { what: 'chat ready' });
  model.queueAnswer({ match: QUESTION, text: ANSWER });
  await sendChat(page, QUESTION);
  // A tight poll right after the send kept the answer from ever arriving in
  // this script; a plain wait first lets the fake model stream it.
  await page.waitForTimeout(3000);
  await poll(() => page.evaluate(() => document.querySelectorAll('#chat-messages .chat-md code').length >= 3),
    { what: 'answer rendered' });
  await page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, DRAFT);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
  await page.waitForTimeout(400);

  const facts = await page.evaluate(() => {
    const pick = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const s = getComputedStyle(el);
      return { font: s.fontFamily, size: s.fontSize, lineHeight: s.lineHeight };
    };
    const link = document.querySelector('#chat-messages .chat-md a[href]');
    const code = document.querySelector('#chat-messages .chat-md code');
    return {
      user: pick('#chat-messages .chat-msg.user'),
      answer: pick('#chat-messages .chat-msg.assistant .chat-md'),
      input: pick('#chat-input'),
      mirror: pick('.chat-input-mirror'),
      link: link && {
        thickness: getComputedStyle(link).textDecorationThickness,
        offset: getComputedStyle(link).textUnderlineOffset,
        color: getComputedStyle(link).textDecorationColor,
      },
      codeBorder: code && getComputedStyle(code).borderTopWidth,
    };
  });
  console.log(JSON.stringify(facts, null, 2));

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      if (value === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
      else document.documentElement.removeAttribute('data-theme');
    }, theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOTS, `chat-typography-${theme}.png`) });
  }
} finally {
  await snotra.stop();
  await model.close();
}
