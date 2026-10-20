// Look instead of trust: starts the real app, asks one question at the
// desktop, then lets main announce a phone's turn in that chat (#1194, step
// 2b) — `chat:turn-started` and the turn's events, as the remote desktop
// adapter sends them — and takes screenshots of the chat following it.
// Not a test — a look.
//
//   node e2e/manual-followed-turn.mjs
//
// Result: out/mockup/followed-turn-*.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const DESKTOP_QUESTION = 'Which files are in this folder?';
const PHONE_QUESTION = 'Summarise the README in two sentences.';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-followed-');
const userDataDir = await makeTempDir('snotra-followed-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Sample project\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

/** What main sends the window, as `main/remote/window-follow.js` does. */
const push = (channel, payload) => app.evaluate(({ BrowserWindow }, [c, p]) => {
  BrowserWindow.getAllWindows()[0].webContents.send(c, p);
}, [channel, payload]);

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'the tree' });
  await page.evaluate(() => {
    if (document.getElementById('app').classList.contains('app--no-history')) {
      document.getElementById('btn-toggle-chat-history').click();
    }
  });

  model.queueAnswer({ match: DESKTOP_QUESTION, text: 'There is one file: `README.md`.' });
  await sendChat(page, DESKTOP_QUESTION);
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')
    && /README/.test(document.querySelector('#chat-messages .chat-msg.assistant:last-of-type')?.textContent || '')), { what: 'the desktop turn' });
  const chatId = await poll(() => page.evaluate(() =>
    document.querySelector('.chat-history-row--current')?.dataset.chatId || null), { what: 'the chat id' });

  const route = { chatId, runId: 'phone-run-1' };
  await push('chat:turn-started', { ...route, content: PHONE_QUESTION });
  await push('chat:progress', { ...route, type: 'phase', phase: 'waiting' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'followed-turn-thinking-light.png') });

  await push('chat:tool-line', { ...route, phase: 'start', callIndex: 0, tool: 'read_file_text', line: 'Reading README.md' });
  await push('chat:tool-line', { ...route, phase: 'done', callIndex: 0, tool: 'read_file_text', line: 'Read README.md' });
  await push('chat:progress', { ...route, type: 'phase', phase: 'streaming' });
  for (const part of ['The README ', 'names the project ', 'as a sample. ', 'It says nothing else yet.']) {
    await push('chat:delta', { ...route, text: part });
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => ({
    users: [...document.querySelectorAll('#chat-messages .chat-msg.user')].map((el) => el.textContent.trim()),
    stop: document.getElementById('btn-chat-send').classList.contains('chat-send--stop'),
    row: document.querySelector('.chat-history-row--current')?.dataset.runState || null,
  }));
  console.log(JSON.stringify(state, null, 2));
  await page.screenshot({ path: path.join(SHOTS, 'followed-turn-streaming-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'followed-turn-streaming-dark.png') });

  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
