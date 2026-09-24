// Look instead of trust: starts the real app, leaves one chat working and one
// waiting for an approval in the background, and takes screenshots of the
// history column (#320). Not a test — a look.
//
//   node e2e/manual-background-runs.mjs
//
// Result: out/mockup/background-runs-*.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const WORKING = 'Pruefe bitte alle Links im Ordner docs.';
const WAITING = 'Merk dir bitte eine Notiz.';

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-hintergrund-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-hintergrund-userdata-'));
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Beispielprojekt\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

function ask(question) {
  return page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, question);
}

async function newChat() {
  await page.evaluate(() => document.getElementById('btn-chat-new').click());
  // The switch is asynchronous; until it is through, the button is still the
  // stop button of the chat just left.
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')
    && document.querySelectorAll('#chat-messages .chat-msg.user').length === 0),
  { what: 'neuer Chat bereit' });
}

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'gezeichneter Baum' });
  await page.evaluate(() => {
    if (document.getElementById('app').classList.contains('app--no-history')) {
      document.getElementById('btn-toggle-chat-history').click();
    }
  });

  // One chat keeps working …
  model.queueAnswer({ match: WORKING, text: 'Ich gehe die Dateien durch. '.repeat(200), chunkDelayMs: 150 });
  await ask(WORKING);
  await poll(() => page.evaluate(() =>
    document.getElementById('btn-chat-send').classList.contains('chat-send--stop')), { what: 'erster Lauf' });
  await newChat();

  // … the other one waits for an approval to remember something.
  model.queueAnswer({
    match: WAITING,
    toolCalls: [{ name: 'remember', arguments: { scope: 'workspace', text: 'Notiz', origin: 'requested' } }],
  });
  await ask(WAITING);
  await poll(() => page.evaluate(() => !!document.querySelector('.chat-approval-card')), { what: 'Freigabekarte' });
  await page.waitForTimeout(300);
  const toolLog = () => page.evaluate(() => ({
    summary: document.querySelector('#chat-messages .chat-msg.assistant:last-of-type .chat-tool-log summary')?.textContent?.replace(/\s+/g, ' '),
    line: document.querySelector('#chat-messages .chat-msg.assistant:last-of-type .chat-tool-line')?.textContent?.replace(/\s+/g, ' '),
    permission: document.querySelector('#chat-messages .chat-msg.assistant:last-of-type .chat-tool-line')?.dataset.permission || null,
  }));
  console.log('tool log before the switch:', JSON.stringify(await toolLog()));
  await page.screenshot({ path: path.join(SHOTS, 'background-runs-card-before-light.png') });
  await newChat();

  const rows = await poll(() => page.evaluate(() => {
    const states = [...document.querySelectorAll('.chat-history-row')].map((row) => ({
      title: row.querySelector('.chat-history-row-title')?.textContent,
      state: row.dataset.runState || null,
      meta: row.querySelector('.chat-history-row-meta')?.innerText,
    }));
    return states.filter((s) => s.state).length >= 2 ? states : null;
  }), { what: 'zwei markierte Zeilen' });
  console.log(JSON.stringify(rows, null, 2));

  const history = page.locator('#chat-history');
  await page.waitForTimeout(300);
  await history.screenshot({ path: path.join(SHOTS, 'background-runs-light.png') });
  await page.screenshot({ path: path.join(SHOTS, 'background-runs-window-light.png') });

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(300);
  await history.screenshot({ path: path.join(SHOTS, 'background-runs-dark.png') });

  // Back into the waiting chat: its card is there again and still answers.
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.evaluate(() =>
    document.querySelector('.chat-history-row[data-run-state="awaiting"]')?.click());
  const card = await poll(() => page.evaluate(() => {
    const el = document.querySelector('#chat-messages .chat-approval-card');
    const once = el?.querySelector('button[data-response="allow-once"]');
    return el && once && !once.disabled ? { text: el.textContent.replace(/\s+/g, ' ').slice(0, 120) } : null;
  }), { what: 'Karte im wieder geoeffneten Chat' });
  console.log('card:', card.text);
  console.log('tool log after the switch:', JSON.stringify(await toolLog()));
  await page.screenshot({ path: path.join(SHOTS, 'background-runs-card-light.png') });
  await page.evaluate(() =>
    document.querySelector('#chat-messages .chat-approval-card button[data-response="allow-once"]').click());
  await poll(() => page.evaluate(() =>
    !document.querySelector('.chat-history-row--current')?.dataset.runState
    && !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'Lauf nach der Freigabe zu Ende' });
  console.log('approved and finished');

  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
