// Look instead of trust (#792, step 3): a connection that waits for the user
// while its command runs — with the real app, shell_execute, the real sandbox
// and its proxy, in "Auto". The fake model runs
//  1. curl to a host outside the call's domains: the card appears while curl
//     waits, is photographed after a few seconds, "every host of this domain"
//     is chosen, and curl carries on;
//  2. curl to another host: denied with Esc;
//  3. curl with a short time limit that nobody answers: the card says it
//     stopped waiting, a card after the run offers the host, and the command
//     runs again.
// The box under each tool log is photographed after the decision.
// Not a test — a look. Needs the network (www.example.com, www.iana.org,
// www.wikipedia.org).
//
//   node e2e/manual-sandbox-live.mjs [en|de]
//
// macOS does not nest sandboxes: run it outside of one (a Claude Code session
// needs the sandbox bypass for it).
//
// Result: out/mockup/sandbox-live-<locale>-{waiting,card,allowed,denied,gaveup,retrycard,retried}-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const FIRST = 'Fetch the example page.';
const SECOND = 'Now the IANA page.';
const THIRD = 'And Wikipedia, quickly.';
const curl = (url, seconds = 60) => `curl -sS -m ${seconds} -o /dev/null -w "%{http_code}\\n" ${url}`;

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-sandbox-live-');
const userDataDir = await makeTempDir('snotra-sandbox-live-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'requirements.txt'), 'torch\n', 'utf8');

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
  return page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, question);
}

/** The open sandbox card — the live one, or the one after the run. */
const openCard = (live) => poll(() => page.evaluate((wantLive) => {
  const cards = [...document.querySelectorAll('#chat-messages .chat-approval-card--sandbox[data-state="pending"]')];
  const card = cards.find((c) => /waiting|wartet/i.test(c.querySelector('.chat-approval-card__title').textContent) === wantLive);
  return card && !card.querySelector('button[data-response="allow-once"]').disabled
    ? card.textContent.replace(/\s+/g, ' ').slice(0, 400)
    : null;
}, live), { what: live ? 'live card' : 'card after the run', timeoutMs: 60_000 });

async function idle() {
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 90_000 });
}

async function shoot(locator, state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(300);
    await locator.screenshot({ path: path.join(SHOTS, `sandbox-live-${locale}-${state}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const lastBox = () => page.evaluate(() => {
  const boxes = document.querySelectorAll('#chat-messages .chat-sandbox-blocked');
  return boxes.length ? boxes[boxes.length - 1].textContent.replace(/\s+/g, ' ').trim() : null;
});
const lastToolResult = () => JSON.parse(model.requests
  .map((r) => r.body?.messages?.findLast?.((m) => m.role === 'tool')?.content).filter(Boolean).at(-1) || '{}');
const lastAnswer = () => page.locator('#chat-messages .chat-msg.assistant').last();
const liveCard = () => page.locator('#chat-messages .chat-approval-card--sandbox').last();

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  // "Auto" asks in a system dialog; this look confirms it itself.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('auto'));
  await poll(() => page.evaluate(() => document.getElementById('chat-tool-mode-wrap').dataset.mode === 'auto'),
    { what: 'Auto mode' });

  // 1. A connection waits; allowed for every host of the domain, curl carries on.
  model.queueAnswer({ match: FIRST, toolCalls: [{ name: 'shell_execute', arguments: { command: curl('https://www.example.com') } }] });
  console.log('asking:', FIRST);
  await ask(FIRST);
  console.log('live card:', await openCard(true));
  await shoot(lastAnswer(), 'waiting');
  await pause(4000);
  console.log('after 4 s:', await page.evaluate(() => document.querySelector('.chat-approval-card__run')?.textContent));
  await shoot(liveCard(), 'card');
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#chat-messages .chat-approval-card--sandbox[data-state="pending"]')].at(-1);
    card.querySelectorAll('.chat-approval-card__choice')[0].querySelectorAll('input')[1]?.click();
    card.querySelector('button[data-response="allow-once"]').click();
  });
  await idle();
  console.log('box:', await lastBox());
  console.log('model reads:', lastToolResult().stdout, '·', lastToolResult().sandbox_connections);
  await shoot(lastAnswer(), 'allowed');

  // 2. Another host, denied with Esc.
  model.queueAnswer({ match: SECOND, toolCalls: [{ name: 'shell_execute', arguments: { command: curl('https://www.iana.org') } }] });
  await ask(SECOND);
  console.log('live card:', await openCard(true));
  await page.keyboard.press('Escape');
  await idle();
  console.log('box:', await lastBox());
  console.log('model reads:', lastToolResult().sandbox_connections);
  await shoot(lastAnswer(), 'denied');

  // 3. Nobody answers; curl gives up after 4 s, the card after the run asks for a retry.
  model.queueAnswer({ match: THIRD, toolCalls: [{ name: 'shell_execute', arguments: { command: curl('https://www.wikipedia.org', 4) } }] });
  await ask(THIRD);
  console.log('live card:', await openCard(true));
  console.log('card after the run:', await openCard(false));
  await shoot(page.locator('#chat-messages .chat-approval-card--sandbox').nth(-2), 'gaveup');
  await shoot(liveCard(), 'retrycard');
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#chat-messages .chat-approval-card--sandbox[data-state="pending"]')].at(-1);
    card.querySelector('button[data-response="allow-once"]').click();
  });
  await idle();
  console.log('box:', await lastBox());
  console.log('model reads:', lastToolResult().stdout, '·', lastToolResult().sandbox_decision);
  await shoot(page.locator('#chat-messages .chat-sandbox-blocked').last(), 'retried');
  console.log('Screenshots in', SHOTS);
} catch (error) {
  // What the app saw, before stopping it: a run still waiting can hold the quit.
  console.log('failed:', error?.message);
  console.log('chat:', await page.evaluate(() => document.querySelector('#chat-messages .chat-msg.assistant:last-of-type')?.textContent.replace(/\s+/g, ' ').slice(-800)).catch(() => '?'));
  console.log('main output:', snotra.mainOutput().slice(-3000));
  process.exitCode = 1;
} finally {
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('smart')).catch(() => {});
  await snotra.stop().catch(() => {});
  await model.close();
}
