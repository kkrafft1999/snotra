// Look instead of trust: starts the real app with a folder's chats — some of
// them kept, one with a long title — and chats from three folders that no
// longer exist, then plays *Keep* and *Assign to this folder* through the
// history column and takes screenshots, light and dark (#1320). Not a test —
// a look.
//
//   node e2e/manual-history-keep.mjs [en|de] [ceiling]
//
// `ceiling` adds 2,000 chats in a second folder, so the history is over the
// ceiling across all folders and says so.
//
// Result: out/mockup/history-keep-<locale>-*.png

import { mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv.includes('de') ? 'de' : 'en';
const ceiling = process.argv.includes('ceiling');
const SHOTS = path.resolve('out/mockup');
const shot = (name) => path.join(SHOTS, `history-keep-${locale}${ceiling ? '-ceiling' : ''}-${name}.png`);

const TEXT = {
  en: {
    own: [
      ['Plan the release notes for 1.30', true],
      ['Compare the three hosting offers and write down what each one costs per month with backups included', false],
      ['Why does the sandbox block git push?', false],
      ['Summarise the meeting with the design team', true],
      ['Fix the flaky test on Windows', false],
      ['Draft the onboarding checklist', false],
    ],
    gone: {
      'garden-planner': ['Watering schedule for the raised beds', 'Which tomatoes grow well on a balcony?', 'Sketch the bed layout as a table', 'Order list for spring', 'Compost: what goes in, what stays out'],
      'thesis-draft-2025': ['Restructure chapter 3', 'Find sources on episodic memory'],
      'q3-offsite': ['Agenda for the offsite'],
    },
  },
  de: {
    own: [
      ['Release Notes für 1.30 planen', true],
      ['Die drei Hosting-Angebote vergleichen und aufschreiben, was jedes pro Monat mit Backups kostet', false],
      ['Warum blockiert die Sandbox git push?', false],
      ['Das Meeting mit dem Designteam zusammenfassen', true],
      ['Den wackligen Test unter Windows reparieren', false],
      ['Checkliste fürs Onboarding entwerfen', false],
    ],
    gone: {
      'gartenplaner': ['Gießplan für die Hochbeete', 'Welche Tomaten wachsen gut auf dem Balkon?', 'Beetplan als Tabelle skizzieren', 'Bestellliste fürs Frühjahr', 'Kompost: was rein darf, was nicht'],
      'masterarbeit-2025': ['Kapitel 3 umbauen', 'Quellen zum episodischen Gedächtnis finden'],
      'q3-offsite': ['Agenda fürs Offsite'],
    },
  },
}[locale];

const turn = (question) => [{ role: 'user', content: question }, { role: 'assistant', content: 'Done.' }];

const model = await startFakeModel();
const workspace = await realpath(await makeTempDir('snotra-keep-'));
const goneParent = await realpath(await makeTempDir('snotra-keep-gone-'));
const otherFolder = await realpath(await makeTempDir('snotra-keep-other-'));
const userDataDir = await makeTempDir('snotra-keep-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');

const now = Date.now();
const sessions = [];
TEXT.own.forEach(([title, keep], i) => {
  sessions.push({ id: `own-${i}`, workspaceRoot: workspace, title, updatedAt: now - (i + 1) * 3_600_000, messages: turn(title), ...(keep ? { keep: true } : {}) });
});
let n = 0;
for (const [folder, titles] of Object.entries(TEXT.gone)) {
  for (const title of titles) {
    n += 1;
    sessions.push({ id: `gone-${n}`, workspaceRoot: path.join(goneParent, folder), title, updatedAt: now - (n + 10) * 86_400_000, messages: turn(title) });
  }
}
sessions.push({ id: 'no-folder', workspaceRoot: null, title: 'Without a folder', updatedAt: now - 1000, messages: turn('Hi') });
if (ceiling) {
  for (let i = 0; i < 2000; i += 1) {
    sessions.push({ id: `other-${i}`, workspaceRoot: otherFolder, title: `Other ${i}`, updatedAt: now - (i + 100) * 60_000, messages: turn('x') });
  }
}
await writeFile(path.join(userDataDir, 'chat-history.json'),
  JSON.stringify({ version: 2, activeByWorkspace: { [workspace]: 'own-0' }, sessions }), 'utf8');

const snotra = await launchApp({ userDataDir });
const { page } = snotra;
const history = page.locator('#chat-history');
const status = () => page.evaluate(() => document.getElementById('chat-history-status')?.textContent);
const focused = () => page.evaluate(() => {
  const el = document.activeElement;
  return `${el?.className} ${el?.getAttribute('aria-label') || el?.textContent || ''}`.trim();
});

async function theme(value) {
  await page.evaluate((v) => { document.documentElement.dataset.theme = v; }, value);
  await page.waitForTimeout(300);
}

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'tree' });
  await page.evaluate(() => {
    if (document.getElementById('app').classList.contains('app--no-history')) {
      document.getElementById('btn-toggle-chat-history').click();
    }
  });
  await poll(() => page.evaluate(() => document.querySelectorAll('.chat-history-row').length >= 6),
    { what: 'six rows', timeoutMs: 60_000 });

  await page.mouse.move(0, 0);
  await history.screenshot({ path: shot('rows-light') });
  await theme('dark');
  await history.screenshot({ path: shot('rows-dark') });
  await theme('light');
  if (ceiling) {
    await page.evaluate(() => document.querySelector('.chat-history-ceiling')?.scrollIntoView());
    await history.screenshot({ path: shot('ceiling-light') });
    await theme('dark');
    await history.screenshot({ path: shot('ceiling-dark') });
    console.log('ceiling note:', await page.evaluate(() => document.querySelector('.chat-history-ceiling')?.textContent));
    process.exitCode = 0;
  } else {
    // Hover shows the bookmark of a chat that is not kept.
    await page.locator('.chat-history-row').nth(2).hover();
    await history.screenshot({ path: shot('hover-light') });

    // By keyboard: from the third row's open button, Tab to its bookmark, Enter.
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.querySelectorAll('.chat-history-row-main')[2].focus());
    await page.keyboard.press('Tab');
    console.log('focus after Tab:', await focused());
    await page.keyboard.press('Enter');
    await poll(() => page.evaluate(() =>
      document.querySelectorAll('.chat-history-row-keep')[2].getAttribute('aria-pressed') === 'true'), { what: 'kept' });
    console.log('status after Keep:', await status());
    await history.screenshot({ path: shot('kept-focus-light') });
    await theme('dark');
    await history.screenshot({ path: shot('kept-focus-dark') });
    await theme('light');

    // The note about missing folders, unfolded by keyboard.
    await page.evaluate(() => document.querySelector('.chat-history-orphans-toggle').focus());
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await history.screenshot({ path: shot('orphans-open-light') });
    await theme('dark');
    await history.screenshot({ path: shot('orphans-open-dark') });
    await theme('light');

    // Assign all of the first folder, then the one chat of the last.
    await page.evaluate(() => document.querySelector('.chat-history-orphans-assign-all').focus());
    await page.keyboard.press('Enter');
    await poll(() => page.evaluate(() => document.querySelectorAll('.chat-history-orphan').length === 3), { what: 'three orphans left' });
    console.log('status after Assign all:', await status());
    console.log('focus after Assign all:', await focused());
    await history.screenshot({ path: shot('after-assign-all-light') });

    await page.evaluate(() => [...document.querySelectorAll('.chat-history-orphan-assign')].at(-1).click());
    await poll(() => page.evaluate(() => document.querySelectorAll('.chat-history-orphan').length === 2), { what: 'two orphans left' });
    console.log('status after Assign:', await status());
    await page.evaluate(() => document.querySelector('.chat-history-orphans-assign-all').click());
    await poll(() => page.evaluate(() => !document.querySelector('.chat-history-orphans')), { what: 'note gone' });
    console.log('focus with no orphans left:', await focused());
    await page.mouse.move(0, 0);
    await history.screenshot({ path: shot('no-orphans-light') });
    await theme('dark');
    await history.screenshot({ path: shot('no-orphans-dark') });
  }
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
