// Look instead of trust (#121): starts the real app with shell_execute
// switched on, lets the fake model ask for commands and
//  1. photographs the card of `git status` with "Always allow this command"
//     (light and dark), answers it with "always" — the native dialog is
//     stubbed and its text reported,
//  2. asks for `git status` again and reports that no card came,
//  3. photographs the card of a compound command, where "always" is disabled
//     and the hint says why,
//  4. photographs a long command, whose open preview is height-limited and
//     keeps "show in full" — the short ones do not show it,
//  5. photographs the remembered command in Settings › Permissions.
// Not a test — a look.
//
//   node e2e/manual-command-rule.mjs [en|de]
//
// Result: out/mockup/command-rule-<locale>-{card-light,card-dark,compound,long,settings}.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const FIRST = 'Show the git status please.';
const AGAIN = 'And once more, please.';
const COMPOUND = 'Status and log together please.';
const LONG = 'Print the numbers please.';

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-command-rule-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-command-rule-userdata-'));
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(
  path.join(userDataDir, 'ui-preferences.json'),
  JSON.stringify({ appLocale: locale, shellExecutionEnabled: true }),
  'utf8',
);
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

function ask(question) {
  return page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, question);
}

const PENDING = '#chat-messages .chat-approval-card[data-state="pending"]';

function pendingCard() {
  return poll(() => page.evaluate((selector) => {
    const el = [...document.querySelectorAll(selector)].at(-1);
    const once = el?.querySelector('button[data-response="allow-once"]');
    if (!el || !once || once.disabled) return null;
    const always = el.querySelector('button[data-response="allow-always"]');
    return {
      buttons: [...el.querySelectorAll('.chat-approval-card__actions button')].map((b) => `${b.textContent}${b.disabled ? ' (disabled)' : ''}`),
      alwaysEnabled: !!always && !always.disabled,
      hint: el.querySelector('.chat-approval-card__hint')?.textContent || '',
      previewOpen: el.querySelector('.chat-approval-card__preview')?.open === true,
      showInFull: !!el.querySelector('.chat-approval-card__preview-toggle:not([hidden])'),
    };
  }, PENDING), { what: 'pending approval card', timeoutMs: 30_000 });
}

async function idle() {
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 60_000 });
}

async function shootCard(name) {
  await page.locator(PENDING).last().screenshot({ path: path.join(SHOTS, `command-rule-${locale}-${name}.png`) });
}

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  // The native confirmation is main's; here it is answered with "confirm".
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    dialog.showMessageBox = async (win, options) => {
      globalThis.__dialogs.push(options || win);
      return { response: 0 };
    };
  });

  model.queueAnswer({ match: FIRST, toolCalls: [{ name: 'shell_execute', arguments: { command: 'git status' } }] });
  await ask(FIRST);
  console.log('card:', JSON.stringify(await pendingCard()));
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 300));
    await shootCard(`card-${theme}`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.evaluate((selector) =>
    document.querySelector(`${selector} button[data-response="allow-always"]`).click(), PENDING);
  await idle();
  const dialogs = await app.evaluate(() => globalThis.__dialogs);
  console.log('dialog:', JSON.stringify(dialogs.at(-1), null, 2));
  console.log('outcome:', await page.evaluate(() =>
    [...document.querySelectorAll('.chat-approval-card__result')].at(-1)?.textContent || ''));

  const requestsBefore = model.requests.length;
  model.queueAnswer({ match: AGAIN, toolCalls: [{ name: 'shell_execute', arguments: { command: 'git   status' } }] });
  await ask(AGAIN);
  await idle();
  const cardsAfter = await page.evaluate(() => document.querySelectorAll('#chat-messages .chat-approval-card').length);
  console.log('cards in the chat after the second run (1 = no new card):', cardsAfter);
  const toolResult = model.requests.slice(requestsBefore).at(-1)?.body?.messages?.findLast?.((m) => m.role === 'tool')?.content || '';
  console.log('second tool result:', toolResult.slice(0, 200));

  model.queueAnswer({ match: COMPOUND, toolCalls: [{ name: 'shell_execute', arguments: { command: 'git status && git log -1' } }] });
  await ask(COMPOUND);
  console.log('compound card:', JSON.stringify(await pendingCard()));
  await shootCard('compound');
  await page.evaluate((selector) =>
    document.querySelector(`${selector} button[data-response="deny"]`).click(), PENDING);
  await idle();

  const lines = Array.from({ length: 30 }, (_, i) => `echo line ${i + 1}`).join('\n');
  model.queueAnswer({ match: LONG, toolCalls: [{ name: 'shell_execute', arguments: { command: lines } }] });
  await ask(LONG);
  console.log('long card:', JSON.stringify(await pendingCard()));
  await shootCard('long');
  await page.evaluate((selector) =>
    document.querySelector(`${selector} button[data-response="deny"]`).click(), PENDING);
  await idle();

  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings dialog' });
  await page.evaluate(() => document.getElementById('tab-settings-permissions').click());
  const row = await poll(() => page.evaluate(() => {
    const el = document.querySelector('#settings-rules-workspace .settings-rule-item');
    return el ? el.textContent.replace(/\s+/g, ' ') : null;
  }), { what: 'remembered command in the rule list' });
  console.log('rule row:', row);
  await page.evaluate(() => document.getElementById('settings-rules-workspace').closest('section, .settings-card, fieldset, div').scrollIntoView());
  await new Promise((r) => setTimeout(r, 300));
  await page.locator('#settings-rules-workspace').screenshot({ path: path.join(SHOTS, `command-rule-${locale}-settings.png`) });
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
