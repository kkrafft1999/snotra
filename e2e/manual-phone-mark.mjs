// Look instead of trust (#1197): starts the real app, asks one question at
// the desktop, then lets main announce a phone's turn in that chat — its
// question carries the phone's origin, its card is answered on the phone,
// its step says so — and photographs the marks, live and once the chat is
// drawn again from what main stored.
// Not a test — a look.
//
//   node e2e/manual-phone-mark.mjs [en|de]
//
// Result: out/mockup/phone-mark-<locale>-{live,stored}-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const require = createRequire(import.meta.url);
const { createToolApprovalRequestDto } = require('../src/shared/contracts/tool-permissions.js');
const { PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels.js');

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const DESKTOP_QUESTION = locale === 'de' ? 'Welche Dateien liegen in diesem Ordner?' : 'Which files are in this folder?';
const PHONE_QUESTION = locale === 'de' ? 'Kannst du die Tests laufen lassen?' : 'Can you run the tests?';
const PHONE = { kind: 'relay', client: 'iPhone' };

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-phone-mark-');
const userDataDir = await makeTempDir('snotra-phone-mark-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Sample project\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');

const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

/** What main sends the window. */
const push = (channel, payload) => app.evaluate(({ BrowserWindow }, [c, p]) => {
  BrowserWindow.getAllWindows()[0].webContents.send(c, p);
}, [channel, payload]);

async function shoot(name) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.waitForTimeout(350);
    await page.locator('#chat-messages').screenshot({ path: path.join(SHOTS, `phone-mark-${locale}-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

try {
  await page.setViewportSize({ width: 1100, height: 760 }).catch(() => {});
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'the tree' });
  await page.evaluate(() => {
    if (document.getElementById('app').classList.contains('app--no-history')) {
      document.getElementById('btn-toggle-chat-history').click();
    }
  });

  model.queueAnswer({ match: DESKTOP_QUESTION, text: locale === 'de' ? 'Es gibt eine Datei: `README.md`.' : 'There is one file: `README.md`.' });
  await sendChat(page, DESKTOP_QUESTION);
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')
    && /README/.test(document.querySelector('#chat-messages .chat-msg.assistant:last-of-type')?.textContent || '')), { what: 'the desktop turn' });
  const chatId = await poll(() => page.evaluate(() =>
    document.querySelector('.chat-history-row--current')?.dataset.chatId || null), { what: 'the chat id' });

  // The phone's turn, as `main/remote/desktop-adapter.js` tells the window.
  const route = { chatId, runId: 'phone-run-1' };
  await push('chat:turn-started', { ...route, content: PHONE_QUESTION, origin: PHONE });
  await push('chat:progress', { ...route, type: 'phase', phase: 'waiting' });
  await push('chat:tool-line', { ...route, phase: 'start', callIndex: 0, tool: 'shell_execute', category: 'command', line: 'Running npm test' });
  const card = createToolApprovalRequestDto({
    requestId: 'phone-card-1',
    tool: 'shell_execute',
    riskClasses: ['execute'],
    targets: [],
    mode: 'smart',
    chatId,
    preview: { kind: 'command', text: 'npm test' },
  });
  await push(PUSH.TOOL_APPROVAL_REQUEST, card);
  await page.waitForTimeout(300);
  await push(PUSH.TOOL_APPROVAL_RESOLVED, { requestId: 'phone-card-1', response: 'allow-once', invalidated: false, reason: null, by: PHONE });
  await push('chat:tool-line', {
    ...route, phase: 'done', callIndex: 0, tool: 'shell_execute', category: 'command', line: 'Ran npm test',
    permission: { decision: 'allow', source: 'allow-once', status: 'executed', riskClasses: ['execute'], mode: 'smart' },
    answeredBy: PHONE,
  });
  await push('chat:progress', { ...route, type: 'phase', phase: 'streaming' });
  await push('chat:delta', { ...route, text: locale === 'de' ? 'Alle 412 Tests laufen durch.' : 'All 412 tests pass.' });
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.querySelector('#chat-messages .chat-msg.assistant:last-of-type .chat-tool-log')?.setAttribute('open', ''); });
  const live = await page.evaluate(() => ({
    users: [...document.querySelectorAll('#chat-messages .chat-msg.user')].map((el) => el.textContent.trim()),
    origin: document.querySelector('.chat-msg-origin')?.textContent || null,
    row: [...document.querySelectorAll('.chat-tool-line')].map((el) => el.getAttribute('aria-label')),
    card: document.querySelector('.chat-approval-card__toggle')?.textContent || null,
  }));
  console.log(JSON.stringify(live, null, 2));
  await shoot('live');
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
console.log('Screenshots in', SHOTS);
