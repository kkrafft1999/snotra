// Look instead of trust (#792, step 2): the sandbox card after a run, with
// the real app, shell_execute and the real sandbox, in "Auto" — where the
// card appears all the same. The fake model runs
//  1. a command that writes a cache outside the workspace: the card is
//     photographed, "one folder up" and "for this session" are chosen, and
//     the command runs again;
//  2. a second command writing into the same cache: no card, the session
//     approval carries it;
//  3. a command reading a protected location: the card is denied with Esc.
// The box under each tool log is photographed after the decision.
// Not a test — a look.
//
//   node e2e/manual-sandbox-approval.mjs [en|de]
//
// macOS does not nest sandboxes: run it outside of one (a Claude Code session
// needs the sandbox bypass for it).
//
// Result: out/mockup/sandbox-approval-<locale>-{card,allowed,denied}-{light,dark}.png

import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const FIRST = 'Generate the client please.';
const SECOND = 'And the second engine.';
const THIRD = 'Check the SSH config.';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-sandbox-approval-');
const userDataDir = await makeTempDir('snotra-sandbox-approval-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(
  path.join(userDataDir, 'ui-preferences.json'),
  JSON.stringify({ appLocale: locale, shellExecutionEnabled: true }),
  'utf8',
);

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => stat(p).then(() => true, () => false);

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

const sandboxCard = () => poll(() => page.evaluate(() => {
  const card = document.querySelector('#chat-messages .chat-approval-card--sandbox[data-state="pending"]');
  return card && !card.querySelector('button[data-response="allow-once"]').disabled
    ? card.textContent.replace(/\s+/g, ' ').slice(0, 300)
    : null;
}), { what: 'sandbox card', timeoutMs: 60_000 });

async function idle() {
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 60_000 });
}

async function shoot(locator, state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(300);
    await locator.screenshot({ path: path.join(SHOTS, `sandbox-approval-${locale}-${state}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const lastBox = () => page.evaluate(() => {
  const boxes = document.querySelectorAll('#chat-messages .chat-sandbox-blocked');
  return boxes.length ? boxes[boxes.length - 1].textContent.replace(/\s+/g, ' ').trim() : null;
});
const lastToolResult = () => model.requests
  .map((r) => r.body?.messages?.findLast?.((m) => m.role === 'tool')?.content).filter(Boolean).at(-1) || '{}';

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  // The app runs with a home folder of its own; a cache folder like a real one.
  const home = await app.evaluate(() => process.env.HOME);
  const caches = path.join(home, 'Library', 'Caches');
  await mkdir(caches, { recursive: true });
  await mkdir(path.join(home, '.ssh'), { recursive: true });
  await writeFile(path.join(home, '.ssh', 'config'), 'Host example\n', 'utf8');
  const engines = path.join(caches, 'snotra-look', 'engines');
  await mkdir(path.join(caches, 'snotra-look'), { recursive: true });

  await page.evaluate(() => window.electronAPI.setToolPermissionMode('auto'));
  await poll(() => page.evaluate(() => document.getElementById('chat-tool-mode-wrap').dataset.mode === 'auto'),
    { what: 'Auto mode' });

  // 1. Write outside the workspace → card → one folder up, this session.
  model.queueAnswer({ match: FIRST, toolCalls: [{ name: 'shell_execute', arguments: {
    command: `mkdir -p "${engines}/5.22.0" && echo engine > "${engines}/5.22.0/query-engine" && echo generated`,
  } }] });
  await ask(FIRST);
  console.log('card:', await sandboxCard());
  const card = page.locator('#chat-messages .chat-approval-card--sandbox').last();
  await shoot(card, 'card');
  await page.evaluate(() => {
    const card = document.querySelector('#chat-messages .chat-approval-card--sandbox[data-state="pending"]');
    const options = card.querySelectorAll('.chat-approval-card__choice');
    options[0].querySelectorAll('input')[1]?.click();
    card.querySelector('input[value="session"]')?.click();
    card.querySelector('button[data-response="allow-once"]').click();
  });
  await idle();
  console.log('engine written:', await exists(path.join(engines, '5.22.0', 'query-engine')));
  console.log('box:', await lastBox());
  console.log('model reads:', JSON.parse(lastToolResult()).sandbox_decision);
  await shoot(page.locator('#chat-messages .chat-sandbox-blocked').last(), 'allowed');

  // 2. The same cache again: the session approval carries it, no card.
  model.queueAnswer({ match: SECOND, toolCalls: [{ name: 'shell_execute', arguments: {
    command: `mkdir -p "${engines}/5.23.0" && echo engine > "${engines}/5.23.0/query-engine" && echo generated`,
  } }] });
  await ask(SECOND);
  await idle();
  const cardsAfter = await page.evaluate(() => document.querySelectorAll('#chat-messages .chat-approval-card--sandbox').length);
  console.log('second engine written without a card:', await exists(path.join(engines, '5.23.0', 'query-engine')), `(sandbox cards: ${cardsAfter})`);

  // The session approval in Settings › Tools & security.
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /^(Einstellungen|Settings)/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings dialog' });
  await page.evaluate(() => document.getElementById('tab-settings-security').click());
  await poll(() => page.evaluate(() => document.querySelector('#settings-grants')?.textContent.trim() || null),
    { what: 'session allowances' });
  await page.evaluate(() => document.getElementById('settings-grants-card').scrollIntoView());
  console.log('session allowances:', await page.evaluate(() => document.getElementById('settings-grants').textContent.replace(/\s+/g, ' ').trim()));
  await shoot(page.locator('#settings-grants-card'), 'session');
  await page.keyboard.press('Escape');
  await poll(() => page.evaluate(() => document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings closed' });

  // 3. A protected read, denied with Esc.
  model.queueAnswer({ match: THIRD, toolCalls: [{ name: 'shell_execute', arguments: { command: 'cat ~/.ssh/config' } }] });
  await ask(THIRD);
  console.log('card:', await sandboxCard().catch(async (e) => {
    console.log('no card — box:', await lastBox(), '— model read:', lastToolResult().slice(0, 600));
    throw e;
  }));
  await page.keyboard.press('Escape');
  await idle();
  console.log('box:', await lastBox());
  console.log('model reads:', JSON.parse(lastToolResult()).sandbox_decision);
  await shoot(page.locator('#chat-messages .chat-sandbox-blocked').last(), 'denied');
  console.log('Screenshots in', SHOTS);
} finally {
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('smart')).catch(() => {});
  await snotra.stop().catch(() => {});
  await model.close();
}
