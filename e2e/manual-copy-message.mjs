// Look instead of trust (#1255): starts the real app, asks one question,
// then lets a phone ask a second one, and photographs Copy under the messages —
// on hover, after a copy, with keyboard focus, after a failure, and next to the
// "Sent from" line while the phone's answer is still being written.
// Not a test — a look.
//
//   node e2e/manual-copy-message.mjs [en|de]
//
// Result: out/mockup/copy-message-<locale>-<state>-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const QUESTION = locale === 'de' ? 'Welche Beete bekommen die Bohnen?' : 'Which beds get the beans?';
const ANSWER = locale === 'de'
  ? '## Beete\n\n- **Nordbeet:** Buschbohnen\n- **Südbeet:** Stangenbohnen\n\nDas Ostbeet bleibt für den Salat.'
  : '## Beds\n\n- **North bed:** bush beans\n- **South bed:** runner beans\n\nThe east bed stays free for the lettuce.';
const PHONE_QUESTION = locale === 'de' ? 'Und wann gieße ich sie?' : 'And when do I water them?';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-copy-look-');
const userDataDir = await makeTempDir('snotra-copy-look-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Garden\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');

const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;
const answerCopy = '#chat-messages > .chat-msg.assistant:last-child .chat-msg-copy';
const questionCopy = '#chat-messages > .chat-msg.user:nth-last-child(2) .chat-msg-copy';

async function shoot(name) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.waitForTimeout(250);
    await page.locator('#chat-messages').screenshot({ path: path.join(SHOTS, `copy-message-${locale}-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const before = await app.evaluate(({ clipboard }) => clipboard.readText());
try {
  await page.setViewportSize({ width: 1100, height: 760 }).catch(() => {});
  // The history column names the chat a phone's turn is routed to.
  await page.evaluate(() => {
    if (document.getElementById('app').classList.contains('app--no-history')) {
      document.getElementById('btn-toggle-chat-history').click();
    }
  });
  model.queueAnswer({ match: QUESTION, text: ANSWER });
  await sendChat(page, QUESTION);
  await poll(() => page.evaluate((s) => Boolean(document.querySelector(s)), answerCopy), { what: 'Copy under the answer' });

  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await shoot('rest');

  await page.hover('#chat-messages > .chat-msg.assistant:last-child .chat-md');
  await page.waitForTimeout(300);
  await shoot('hover-answer');

  await page.hover(answerCopy);
  await page.waitForTimeout(300);
  await shoot('hover-button');

  await page.click(answerCopy);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await shoot('copied');
  console.log('clipboard:', JSON.stringify(await app.evaluate(({ clipboard }) => clipboard.readText())));

  await page.waitForTimeout(2200);
  await page.keyboard.press('Shift');
  await page.focus(questionCopy);
  await page.waitForTimeout(300);
  await shoot('focus-question');

  // The clipboard of main cannot be made to fail from here: the look of a
  // failure is put on the button by hand.
  await page.evaluate((s) => {
    const button = document.querySelector(s);
    button.classList.add('chat-msg-copy--failed');
    button.querySelector('.chat-msg-copy__note').textContent = document.documentElement.lang === 'de' ? 'Nicht kopiert' : 'Not copied';
    document.activeElement?.blur();
  }, answerCopy);
  await page.waitForTimeout(300);
  await shoot('failed');

  // A phone's turn: its question carries "Sent from iPhone" next to Copy; its
  // answer is still being written and has none yet.
  const chatId = await poll(() => page.evaluate(() =>
    document.querySelector('.chat-history-row--current')?.dataset.chatId || null), {
    what: 'the chat id',
    explain: () => page.evaluate(() => `${document.getElementById('app').className} | ${document.querySelectorAll('.chat-history-row').length} rows`),
  });
  const route = { chatId, runId: 'phone-run-1' };
  const push = (channel, payload) => app.evaluate(({ BrowserWindow }, [c, p]) => {
    BrowserWindow.getAllWindows()[0].webContents.send(c, p);
  }, [channel, payload]);
  await push('chat:turn-started', { ...route, content: PHONE_QUESTION, origin: { kind: 'relay', client: 'iPhone' } });
  await push('chat:progress', { ...route, type: 'phase', phase: 'streaming' });
  await push('chat:delta', { ...route, text: locale === 'de' ? 'Am besten morgens' : 'Best in the morning' });
  await page.waitForTimeout(400);
  await page.hover(questionCopy);
  await page.waitForTimeout(300);
  await shoot('phone-streaming');
  console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('#chat-messages > .chat-msg')]
    .map((li) => ({ cls: li.className, row: [...(li.querySelector(':scope > .chat-msg-actions')?.children || [])].map((c) => c.className) }))), null, 1));
} finally {
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before).catch(() => {});
  await snotra.stop().catch(() => {});
  await model.close();
}
console.log('Screenshots in', SHOTS);
