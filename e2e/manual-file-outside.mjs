// Look instead of trust (#792, step 4): the file tools outside the open
// folder, with the real app, its planner and its file tools. The fake model
//  1. reads a file in ~/Documents/move (Smart): the card is photographed,
//     "the folder around it" is chosen for this call, and the file is read;
//  2. edits ~/notes/todo.md (Smart): one card with the preview, denied with Esc;
//  3. in "Auto", writes ~/notes/new.md: the card comes all the same, allowed
//     for the session, and a second write into ~/notes needs no card; the
//     session allowance is photographed in the settings.
// The box under each tool log is photographed after the decision.
// Not a test — a look.
//
//   node e2e/manual-file-outside.mjs [en|de]
//
// Result: out/mockup/file-outside-<locale>-{read,readbox,write,denied,auto,session}-{light,dark}.png

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const FIRST = 'Read my moving plan from the documents.';
const SECOND = 'Add order boxes to my notes.';
const THIRD = 'Write a new note, then a second one.';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-file-outside-');
const userDataDir = await makeTempDir('snotra-file-outside-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Move\n', 'utf8');

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

const openCard = () => poll(() => page.evaluate(() => {
  const card = document.querySelector('#chat-messages .chat-approval-card--sandbox[data-state="pending"]');
  return card && !card.querySelector('button[data-response="allow-once"]').disabled
    ? card.textContent.replace(/\s+/g, ' ').slice(0, 300)
    : null;
}), { what: 'card before the call', timeoutMs: 30_000 });

async function idle() {
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 60_000 });
}

async function shoot(locator, state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(300);
    await locator.screenshot({ path: path.join(SHOTS, `file-outside-${locale}-${state}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const lastBox = () => page.evaluate(() => {
  const boxes = document.querySelectorAll('#chat-messages .chat-sandbox-blocked');
  return boxes.length ? boxes[boxes.length - 1].textContent.replace(/\s+/g, ' ').trim() : null;
});
const lastToolResult = () => model.requests
  .map((r) => r.body?.messages?.findLast?.((m) => m.role === 'tool')?.content).filter(Boolean).at(-1) || '';
const pendingCard = () => page.locator('#chat-messages .chat-approval-card--sandbox[data-state="pending"]').last();
const box = () => page.locator('#chat-messages .chat-sandbox-blocked').last();

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  // The app runs with a home folder of its own.
  const home = await app.evaluate(() => process.env.HOME);
  await mkdir(path.join(home, 'Documents', 'move'), { recursive: true });
  await writeFile(path.join(home, 'Documents', 'move', 'plan.md'), '# Moving plan\n\n- Kitchen first\n', 'utf8');
  await mkdir(path.join(home, 'notes'), { recursive: true });
  await writeFile(path.join(home, 'notes', 'todo.md'), '- boxes\n', 'utf8');

  // 1. Read outside (Smart): the folder around it, for this call.
  model.queueAnswer({ match: FIRST, toolCalls: [{ name: 'read_file_text', arguments: { relative_path: '~/Documents/move/plan.md' } }] });
  await ask(FIRST);
  console.log('card:', await openCard());
  await shoot(pendingCard(), 'read');
  await page.evaluate(() => {
    const card = document.querySelector('#chat-messages .chat-approval-card--sandbox[data-state="pending"]');
    card.querySelectorAll('.chat-approval-card__choice')[0].querySelectorAll('input')[1]?.click();
    card.querySelector('button[data-response="allow-once"]').click();
  });
  await idle();
  console.log('box:', await lastBox());
  console.log('model reads:', lastToolResult().slice(0, 160));
  await shoot(box(), 'readbox');

  // 2. Edit outside (Smart): one card with the preview, denied with Esc.
  model.queueAnswer({ match: SECOND, toolCalls: [{ name: 'edit_file', arguments: {
    relative_path: '~/notes/todo.md', old_string: '- boxes', new_string: '- boxes\n- order boxes',
  } }] });
  await ask(SECOND);
  console.log('card:', await openCard());
  console.log('cards in this answer:', await page.evaluate(() =>
    document.querySelector('#chat-messages .chat-msg.assistant:last-of-type').querySelectorAll('.chat-approval-card').length));
  await shoot(pendingCard(), 'write');
  await page.keyboard.press('Escape');
  await idle();
  console.log('box:', await lastBox());
  console.log('model reads:', lastToolResult().slice(0, 240));
  console.log('todo.md unchanged:', (await readFile(path.join(home, 'notes', 'todo.md'), 'utf8')) === '- boxes\n');
  await shoot(box(), 'denied');

  // 3. Auto: the card all the same, for the session; the second write without one.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('auto'));
  await poll(() => page.evaluate(() => document.getElementById('chat-tool-mode-wrap').dataset.mode === 'auto'),
    { what: 'Auto mode' });
  model.queueAnswer({ match: THIRD, toolCalls: [{ name: 'write_file_text', arguments: { relative_path: '~/notes/new.md', content: 'first\n' } }] });
  model.queueAnswer({ match: THIRD, toolCalls: [{ name: 'write_file_text', arguments: { relative_path: '~/notes/second.md', content: 'second\n' } }] });
  await ask(THIRD);
  console.log('card in Auto:', await openCard());
  await shoot(pendingCard(), 'auto');
  await page.evaluate(() => {
    const card = document.querySelector('#chat-messages .chat-approval-card--sandbox[data-state="pending"]');
    card.querySelectorAll('.chat-approval-card__choice')[0].querySelectorAll('input')[1]?.click();
    card.querySelector('input[value="session"]')?.click();
    card.querySelector('button[data-response="allow-once"]').click();
  });
  await idle();
  const cards = await page.evaluate(() => document.querySelectorAll('#chat-messages .chat-approval-card--sandbox').length);
  console.log('written:', await readFile(path.join(home, 'notes', 'new.md'), 'utf8').catch(() => '—').then((s) => s.trim()),
    '/', await readFile(path.join(home, 'notes', 'second.md'), 'utf8').catch(() => '—').then((s) => s.trim()),
    `(cards so far: ${cards})`);
  console.log('box:', await lastBox());

  // The session allowance in Settings › Tools & security.
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
