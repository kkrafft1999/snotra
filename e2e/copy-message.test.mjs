// Copy under a chat message (#1255), in the real app: the button shows on
// hover and on keyboard focus, and what lands on the system clipboard — through
// main, since the renderer may not use navigator.clipboard — is the message's
// source: the answer's Markdown, the question as typed.
//
// The test writes the real clipboard; it puts back what was on it before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, waitForFolderChat, sendChat } from './helpers/app.mjs';

const QUESTION = 'Which beds get the beans?\n  Keep *both* rows.';
const ANSWER = '## Beds\n\n- **North** bed: bush beans\n- `south` bed: runner beans\n\n| Bed | Row |\n| --- | --- |\n| North | 1 |';

test('Copy shows on hover and focus and puts the message source on the clipboard (#1255)', { timeout: 120000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-copy-message-');
  const userDataDir = await makeTempDir('snotra-copy-message-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

  const snotra = await launchApp({ userDataDir });
  const { app, page } = snotra;
  const before = await app.evaluate(({ clipboard }) => clipboard.readText());
  t.after(async () => {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before).catch(() => {});
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const explain = () => `main:\n${snotra.mainOutput()}`;
  await waitForFolderChat(page, { explain });

  model.queueAnswer({ match: 'Which beds', text: ANSWER });
  await sendChat(page, QUESTION, { explain, t });
  const answerCopy = '#chat-messages > .chat-msg.assistant:last-child .chat-msg-copy';
  const questionCopy = '#chat-messages > .chat-msg.user:nth-last-child(2) .chat-msg-copy';
  await poll(() => page.evaluate((selector) => Boolean(document.querySelector(selector)), answerCopy),
    { what: 'Copy under the settled answer', explain });

  const opacity = (selector) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).opacity, selector);
  await page.mouse.move(0, 0);
  await poll(async () => (await opacity(answerCopy)) === '0', { what: 'Copy hidden at rest' });

  // The pointer on the answer: Copy shows; a click puts the Markdown on the clipboard.
  // Hovered again on every look: a redraw or a scroll after the first hover
  // leaves the pointer over a node that was replaced or moved away, and
  // Chromium only works out `:hover` again on the next move (#1346).
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  const answerText = '#chat-messages > .chat-msg.assistant:last-child .chat-md';
  await poll(async () => {
    await page.hover(answerText);
    return (await opacity(answerCopy)) === '1';
  }, {
    what: 'Copy shown on hover',
    explain: () => page.evaluate(({ text, copy }) => {
      const r = document.querySelector(text).getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const button = document.querySelector(copy);
      return {
        point: [Math.round(x), Math.round(y)],
        hit: hit ? `${hit.nodeName}.${hit.className}` : null,
        hitInAnswer: Boolean(hit?.closest('.chat-msg.assistant:last-child')),
        answerHovered: button.closest('.chat-msg').matches(':hover'),
        opacity: getComputedStyle(button).opacity,
        hoverNone: matchMedia('(hover: none)').matches,
      };
    }, { text: answerText, copy: answerCopy }),
  });
  await page.click(answerCopy);
  await poll(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())) === ANSWER,
    { what: 'the answer on the clipboard', explain: () => app.evaluate(({ clipboard }) => clipboard.readText()) });
  assert.equal(await page.evaluate((s) => document.querySelector(s).getAttribute('aria-label'), answerCopy), 'Copied');

  // The keyboard reaches the question's Copy: it shows with the focus, Enter copies.
  await page.mouse.move(0, 0);
  await page.focus(questionCopy);
  await poll(async () => (await opacity(questionCopy)) === '1', { what: 'Copy shown on focus' });
  await page.keyboard.press('Enter');
  await poll(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())) === QUESTION,
    { what: 'the question on the clipboard', explain: () => app.evaluate(({ clipboard }) => clipboard.readText()) });
});
