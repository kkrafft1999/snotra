// Look instead of trust (#792, step 5): the system notification about an
// approval card waiting out of sight, with the real app. A native
// notification cannot be photographed, so main's Notification.show is
// captured and its click triggered from here. The fake model
//  1. answers chat A slowly with an edit; meanwhile a new chat B is opened,
//     so the card arrives out of sight: one notification, and chat A's row
//     in the history says it needs an approval (photographed);
//  2. the notification is clicked: the window comes up with chat A and its card;
//  3. Snotra "in the background" (the renderer told it has no focus): a card
//     in the chat on screen gets one too;
//  4. switched off under Settings › General (photographed): none.
// Not a test — a look.
//
//   node e2e/manual-approval-notification.mjs [en|de]
//
// Result: out/mockup/approval-notification-<locale>-{history,setting}-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const FIRST = 'Tidy up the readme please.';
const SECOND = 'Now the readme title.';
const THIRD = 'And once more.';

const model = await startFakeModel();
model.setTitle(locale === 'de' ? 'Readme aufräumen' : 'Tidy the readme');
const workspace = await makeTempDir('snotra-notify-');
const userDataDir = await makeTempDir('snotra-notify-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Move\n\nold line\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const snotra = await launchApp({ userDataDir });
const { page, app } = snotra;

function ask(question) {
  return page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, question);
}

async function shoot(locator, state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(300);
    await locator.screenshot({ path: path.join(SHOTS, `approval-notification-${locale}-${state}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const shown = () => app.evaluate(() => (globalThis.__shownNotifications || []).map((n) => ({ title: n.title, body: n.body })));
const edit = (line) => ({ name: 'edit_file', arguments: { relative_path: 'README.md', old_string: 'old line', new_string: line } });
const pendingCard = () => page.evaluate(() => !!document.querySelector('#chat-messages .chat-approval-card[data-state="pending"]'));
const currentChat = () => page.evaluate(() => document.querySelector('#chat-messages .chat-msg.user')?.textContent.trim() || '(empty chat)');

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0), { what: 'drawn tree' });
  // The history column, where a chat with a waiting card is marked.
  await page.evaluate(() => {
    const toggle = document.getElementById('btn-toggle-chat-history');
    if (toggle?.getAttribute('aria-pressed') !== 'true') toggle?.click();
  });
  // Main's notifications, captured instead of shown.
  await app.evaluate(({ Notification }) => {
    globalThis.__shownNotifications = [];
    Notification.prototype.show = function show() { globalThis.__shownNotifications.push(this); };
  });

  // 1. The card arrives while another chat is on screen.
  model.queueAnswer({ match: FIRST, delayMs: 2500, toolCalls: [edit('new line')] });
  await ask(FIRST);
  await pause(300);
  await page.evaluate(() => document.getElementById('btn-chat-new').click());
  await poll(async () => (await shown()).length > 0, { what: 'notification', timeoutMs: 20_000 });
  console.log('notification:', JSON.stringify(await shown()));
  console.log('on screen:', await currentChat());
  const row = await poll(() => page.evaluate(() => {
    const awaiting = document.querySelector('.chat-history-row[data-run-state="awaiting"]');
    return awaiting ? awaiting.textContent.replace(/\s+/g, ' ').trim() : null;
  }), { what: 'history row needs approval', timeoutMs: 10_000 }).catch(() => '(history column closed)');
  console.log('history row:', row);
  if (!row.startsWith('(')) await shoot(page.locator('#chat-history'), 'history');

  // 2. A click: the window comes up with chat A and its card.
  await app.evaluate(() => globalThis.__shownNotifications.at(-1).emit('click'));
  await poll(pendingCard, { what: 'card on screen after the click', timeoutMs: 10_000 });
  console.log('after the click, on screen:', await currentChat(), '— card waiting:', await pendingCard());
  await page.keyboard.press('Escape');
  await poll(() => page.evaluate(() => !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')), { what: 'run finished', timeoutMs: 20_000 });

  // 3. In the background, a card in the chat on screen.
  await page.evaluate(() => { document.hasFocus = () => false; });
  model.queueAnswer({ match: SECOND, toolCalls: [edit('second line')] });
  await ask(SECOND);
  await poll(pendingCard, { what: 'second card', timeoutMs: 20_000 });
  await pause(300);
  console.log('in the background:', JSON.stringify((await shown()).at(-1)), `(${(await shown()).length} so far)`);
  await page.keyboard.press('Escape');
  await poll(() => page.evaluate(() => !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')), { what: 'run finished', timeoutMs: 20_000 });

  // 4. Switched off under Settings › General.
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /^(Einstellungen|Settings)/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')), { what: 'settings dialog' });
  await page.evaluate(() => document.getElementById('tab-settings-general').click());
  await poll(() => page.evaluate(() => document.getElementById('input-approval-notifications')?.checked === true), { what: 'switch on' });
  const group = page.locator('#input-approval-notifications').locator('xpath=ancestor::div[contains(@class,"modal-field-group")]');
  await group.scrollIntoViewIfNeeded();
  await shoot(group, 'setting');
  await page.evaluate(() => document.getElementById('input-approval-notifications').click());
  await poll(() => page.evaluate(() => document.getElementById('status-approval-notifications')?.textContent.trim() || null), { what: 'saved' });
  console.log('switch status:', await page.evaluate(() => document.getElementById('status-approval-notifications').textContent.trim()));
  await page.keyboard.press('Escape');
  const before = (await shown()).length;
  model.queueAnswer({ match: THIRD, toolCalls: [edit('third line')] });
  await ask(THIRD);
  await poll(pendingCard, { what: 'third card', timeoutMs: 20_000 });
  await pause(500);
  console.log('switched off — new notifications:', (await shown()).length - before);
  await page.keyboard.press('Escape');
  console.log('Screenshots in', SHOTS);
} catch (error) {
  console.log('failed:', error?.message);
  console.log('main output:', snotra.mainOutput().slice(-2000));
  process.exitCode = 1;
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
