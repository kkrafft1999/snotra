// Look instead of trust (#329): starts the real app with shell_execute
// switched on, lets the fake model ask for two commands and
//  1. photographs the approval card of a `pip install` (light and dark),
//  2. approves a command that writes inside the workspace and outside of it,
//     and reports which of the two files exists afterwards.
// Not a test — a look.
//
//   node e2e/manual-sandbox-card.mjs [en|de] [off]
//
// `off` (macOS) starts the app itself inside a permissive Seatbelt profile.
// macOS does not nest sandboxes, so the self-test fails honestly and the card
// shows the "not isolated" state.
//
// Result: out/mockup/sandbox-card-<locale>[-off]-{light,dark}.png and
//         out/mockup/sandbox-settings-<locale>[-off].png

import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

import electronBinary from 'electron';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const off = process.argv[3] === 'off';
const variant = off ? `${locale}-off` : locale;
const SHOTS = path.resolve('out/mockup');
const INSTALL = 'Install requests please.';
const WRITE = 'Write two files please.';
const outsideFile = path.join(homedir(), `snotra-e2e-outside-${process.pid}.txt`);

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-sandbox-card-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-sandbox-card-userdata-'));
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(
  path.join(userDataDir, 'ui-preferences.json'),
  JSON.stringify({ appLocale: locale, shellExecutionEnabled: true }),
  'utf8',
);
let wrapper = null;
if (off) {
  wrapper = path.join(userDataDir, 'seatbelt-wrapper.sh');
  // Chromium's own renderer sandbox cannot nest either — off for this look.
  await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -p "(version 1)(allow default)" "${electronBinary}" "$@" --no-sandbox\n`, { mode: 0o755 });
}
const snotra = await launchApp({ userDataDir, wrapper });
const { app, page } = snotra;

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
    const cards = [...document.querySelectorAll('#chat-messages .chat-approval-card[data-state="pending"]')];
    const el = cards.at(-1);
    const once = el?.querySelector('button[data-response="allow-once"]');
    if (!el || !once || once.disabled) return null;
    return {
      badge: el.querySelector('.chat-approval-card__badge')?.textContent || '',
      badgeWarning: !!el.querySelector('.chat-approval-card__badge--warning'),
      text: el.textContent.replace(/\s+/g, ' ').slice(0, 400),
    };
  }), { what: 'pending approval card', timeoutMs: 30_000 });
}

async function idle() {
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 60_000 });
}

const exists = (p) => stat(p).then(() => true, () => false);

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  model.queueAnswer({ match: INSTALL, toolCalls: [{ name: 'shell_execute', arguments: { command: 'pip install requests' } }] });
  await ask(INSTALL);
  const card = await pendingCard();
  console.log('card:', JSON.stringify(card));
  const locator = page.locator('#chat-messages .chat-approval-card[data-state="pending"]').last();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 300));
    await locator.screenshot({ path: path.join(SHOTS, `sandbox-card-${variant}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.evaluate(() =>
    document.querySelector('#chat-messages .chat-approval-card[data-state="pending"] button[data-response="deny"]').click());
  await idle();

  model.queueAnswer({
    match: WRITE,
    toolCalls: [{
      name: 'shell_execute',
      arguments: { command: `echo hi > inside.txt; echo x > '${outsideFile}'; echo done` },
    }],
  });
  await ask(WRITE);
  await pendingCard();
  await page.evaluate(() =>
    document.querySelector('#chat-messages .chat-approval-card[data-state="pending"] button[data-response="allow-once"]').click());
  await idle();
  console.log('inside.txt written:', await exists(path.join(workspace, 'inside.txt')));
  console.log('outside file written:', await exists(outsideFile));
  const toolResult = model.requests.at(-1)?.body?.messages?.findLast?.((m) => m.role === 'tool')?.content || '';
  console.log('tool result seen by the model:', toolResult.slice(0, 600));

  // The tool cards in the settings: warning, status and isolation line.
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings dialog' });
  await page.evaluate(() => document.getElementById('tab-settings-tools').click());
  await poll(() => page.evaluate(() => {
    const el = document.getElementById('settings-shell-sandbox');
    return el && !el.hidden && el.textContent ? el.textContent : null;
  }), { what: 'isolation line' });
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('#settings-shell-card details.settings-note--warning')) d.open = true;
    document.getElementById('settings-shell-card').scrollIntoView();
  });
  await new Promise((r) => setTimeout(r, 400));
  console.log('isolation line:', await page.evaluate(() => document.getElementById('settings-shell-sandbox').textContent));
  await page.locator('#settings-shell-card').screenshot({ path: path.join(SHOTS, `sandbox-settings-${variant}.png`) });
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(outsideFile, { force: true });
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
