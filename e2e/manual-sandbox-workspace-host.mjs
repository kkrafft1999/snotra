// Look instead of trust (#946): a connection kept open for the workspace —
// with the real app, shell_execute, the real sandbox and its proxy, in
// "Auto". The fake model runs
//  1. curl to a host outside the call's domains: the card offers "For this
//     workspace", which is chosen; the system dialog is answered by the
//     script and its text logged; curl carries on;
//  2. the same curl again: no card, the host is open for the workspace;
//  3. Settings › Tools › Autonomy: the row "Execute" counts the host when
//     closed and lists it when open; closing it there takes it away again.
// Not a test — a look. Needs the network (www.example.com).
//
//   node e2e/manual-sandbox-workspace-host.mjs [en|de]
//
// macOS does not nest sandboxes: run it outside of one (a Claude Code session
// needs the sandbox bypass for it).
//
// Result: out/mockup/workspace-host-<locale>-{card,allowed,settings-closed,settings-open}-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const FIRST = 'Fetch the example page.';
const AGAIN = 'Once more, please.';
const curl = (url, seconds = 60) => `curl -sS -m ${seconds} -o /dev/null -w "%{http_code}\\n" ${url}`;

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-workspace-host-');
const userDataDir = await makeTempDir('snotra-workspace-host-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Server tools\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(
  path.join(userDataDir, 'ui-preferences.json'),
  JSON.stringify({ appLocale: locale, shellExecutionEnabled: true }),
  'utf8',
);

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const snotra = await launchApp({ userDataDir });
const { page, app } = snotra;

function ask(question) {
  return sendChat(page, question);
}

const openLiveCard = () => poll(() => page.evaluate(() => {
  const card = [...document.querySelectorAll('#chat-messages .chat-approval-card--sandbox[data-state="pending"]')].at(-1);
  return card && !card.querySelector('button[data-response="allow-once"]').disabled
    ? card.textContent.replace(/\s+/g, ' ').slice(0, 400)
    : null;
}), { what: 'live card', timeoutMs: 60_000 });

async function idle() {
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 90_000 });
}

async function shoot(locator, state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(300);
    await locator.screenshot({ path: path.join(SHOTS, `workspace-host-${locale}-${state}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const lastToolResult = () => JSON.parse(model.requests
  .map((r) => r.body?.messages?.findLast?.((m) => m.role === 'tool')?.content).filter(Boolean).at(-1) || '{}');
const lastAnswer = () => page.locator('#chat-messages .chat-msg.assistant').last();
const liveCard = () => page.locator('#chat-messages .chat-approval-card--sandbox').last();

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  // Every system dialog is confirmed by the script, and kept to be read.
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    dialog.showMessageBox = async (win, options) => {
      globalThis.__dialogs.push(options || win);
      return { response: 0 };
    };
  });
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('auto'));
  await poll(() => page.evaluate(() => document.getElementById('chat-tool-mode-wrap').dataset.mode === 'auto'),
    { what: 'Auto mode' });

  // 1. The connection waits; kept open for the workspace.
  model.queueAnswer({ match: FIRST, toolCalls: [{ name: 'shell_execute', arguments: { command: curl('https://www.example.com') } }] });
  await ask(FIRST);
  console.log('live card:', await openLiveCard());
  console.log('durations:', await page.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .chat-approval-card--sandbox[data-state="pending"] input[name$="duration"]')]
      .map((i) => `${i.value}${i.checked ? '*' : ''}`).join(' ')));
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#chat-messages .chat-approval-card--sandbox[data-state="pending"]')].at(-1);
    card.querySelector('input[value="workspace"]').click();
  });
  await shoot(liveCard(), 'card');
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#chat-messages .chat-approval-card--sandbox[data-state="pending"]')].at(-1);
    card.querySelector('button[data-response="allow-once"]').click();
  });
  await idle();
  const dialogs = await app.evaluate(() => globalThis.__dialogs.map((d) => ({ title: d.title, detail: d.detail, buttons: d.buttons })));
  console.log('system dialog:', JSON.stringify(dialogs.at(-1), null, 2));
  console.log('model reads:', lastToolResult().stdout, '·', lastToolResult().sandbox_connections);
  await shoot(lastAnswer(), 'allowed');

  // 2. The same again: no card.
  model.queueAnswer({ match: AGAIN, toolCalls: [{ name: 'shell_execute', arguments: { command: curl('https://www.example.com') } }] });
  await ask(AGAIN);
  await idle();
  console.log('cards in the second answer:', await page.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .chat-msg.assistant')].at(-1).querySelectorAll('.chat-approval-card').length));
  console.log('second run reads:', lastToolResult().stdout, '·', lastToolResult().sandbox_connections ?? '(no connection asked)');

  // 3. Settings › Tools › Autonomy.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 1500));
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings dialog' });
  await page.evaluate(() => document.getElementById('tab-settings-security').click());
  await poll(() => page.evaluate(() => document.querySelectorAll('#settings-security-rows .settings-security-row').length === 6),
    { what: 'six rows' });
  const row = page.locator('.settings-security-row[data-risk-class="execute"]');
  console.log('closed row:', (await row.innerText()).replace(/\s+/g, ' '));
  await shoot(row, 'settings-closed');
  await page.locator('.settings-security-row__toggle[data-risk-class="execute"]').click();
  await pause(300);
  const hostItem = row.locator('button[data-host-remove]').first();
  await hostItem.scrollIntoViewIfNeeded();
  await shoot(row, 'settings-open');
  console.log('close button:', await hostItem.getAttribute('aria-label'));
  await hostItem.focus();
  await page.keyboard.press('Enter');
  await poll(() => page.evaluate(() => !document.querySelector('button[data-host-remove]')), { what: 'host closed' });
  console.log('after closing:', (await row.innerText()).replace(/\s+/g, ' ').slice(0, 300));
  console.log('Screenshots in', SHOTS);
} catch (error) {
  console.log('failed:', error?.message);
  console.log('chat:', await page.evaluate(() => document.querySelector('#chat-messages .chat-msg.assistant:last-of-type')?.textContent.replace(/\s+/g, ' ').slice(-800)).catch(() => '?'));
  console.log('main output:', snotra.mainOutput().slice(-3000));
  process.exitCode = 1;
} finally {
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('smart')).catch(() => {});
  await snotra.stop().catch(() => {});
  await model.close();
}
