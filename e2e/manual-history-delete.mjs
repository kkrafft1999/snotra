// Look instead of trust: starts the real app with three chats, asks to delete
// one from the history column and takes screenshots of the question, light
// and dark, and of the open model menu (#582, #583). Not a test — a look.
//
//   node e2e/manual-history-delete.mjs
//
// Result: out/mockup/history-delete-*.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const QUESTIONS = [
  'Fasse bitte die README zusammen.',
  'Schreib mir ein Protokoll vom Meeting gestern mit allen Entscheidungen, offenen Punkten und Verantwortlichen.',
  'Was steht in docs?',
];

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-verlauf-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-verlauf-userdata-'));
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Beispielprojekt\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

async function ask(text) {
  model.queueAnswer({ match: text, text: 'Erledigt.' });
  await page.evaluate((question) => {
    const input = document.getElementById('chat-input');
    input.value = question;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, text);
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')
    && document.querySelectorAll('#chat-messages .chat-msg.assistant').length > 0), { what: 'Antwort' });
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

  for (const [i, question] of QUESTIONS.entries()) {
    if (i > 0) await page.evaluate(() => document.getElementById('btn-chat-new').click());
    await page.waitForTimeout(200);
    await ask(question);
  }
  await poll(() => page.evaluate(() => document.querySelectorAll('.chat-history-row').length >= 3),
    { what: 'drei Zeilen' });

  const history = page.locator('#chat-history');
  await history.screenshot({ path: path.join(SHOTS, 'history-delete-rows-light.png') });

  // The second row asks.
  await page.evaluate(() => document.querySelectorAll('.chat-history-row-delete')[1].click());
  await page.waitForTimeout(200);
  const focus = await page.evaluate(() => document.activeElement?.className);
  console.log('focus after the bin:', focus);
  await history.screenshot({ path: path.join(SHOTS, 'history-delete-confirm-light.png') });

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(300);
  await history.screenshot({ path: path.join(SHOTS, 'history-delete-confirm-dark.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  // Delete for real, by keyboard: Shift+Tab from Cancel to Delete, Enter.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await poll(() => page.evaluate(() => document.querySelectorAll('.chat-history-row').length === 2),
    { what: 'zwei Zeilen nach dem Loeschen' });
  console.log('focus after the delete:', await page.evaluate(() =>
    document.activeElement?.closest('.chat-history-row')?.querySelector('.chat-history-row-title')?.textContent));
  await history.screenshot({ path: path.join(SHOTS, 'history-delete-after-light.png') });

  // The model menu, opened by keyboard.
  await page.evaluate(() => document.getElementById('btn-chat-model-picker').focus());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  console.log('model pill name:', await page.evaluate(() =>
    document.getElementById('btn-chat-model-picker').getAttribute('aria-label')));
  console.log('focus in the menu:', await page.evaluate(() => document.activeElement?.textContent));
  await page.screenshot({ path: path.join(SHOTS, 'history-delete-model-menu-light.png') });
  await page.keyboard.press('Escape');
  console.log('focus after Escape:', await page.evaluate(() => document.activeElement?.id));

  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
