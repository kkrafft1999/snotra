// Look rather than trust (#1275): a folder with two rules files — one always,
// one on demand —, a run that fetches the second with load_rule, and the rows
// the rules take in the context breakdown, in both languages, light and dark.
// Not a test — a look.
//
//   node e2e/manual-rules-files.mjs
//
//   out/mockup/rules-files-<locale>-<theme>.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-rules-files-ws-');
const userDataDir = await makeTempDir('snotra-rules-files-userdata-');
await mkdir(SHOTS, { recursive: true });

await mkdir(path.join(workspace, '.agents', 'rules'), { recursive: true });
await writeFile(path.join(workspace, '.agents', 'rules', 'commit-messages.md'),
  '---\ndescription: When you write a commit message\n---\n\n- Write it in English, in the imperative.\n', 'utf8');
await writeFile(path.join(workspace, '.agents', 'rules', 'units.md'),
  '---\ndescription: When you name a measurement\nalways: true\n---\n\n- Use centimetres.\n', 'utf8');
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

async function applyLocale(locale) {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() =>
    !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'open settings dialog' });
  await page.evaluate(() =>
    document.querySelector('.settings-nav-item[data-settings-panel="general"]').click());
  await wait(200);
  await page.evaluate((value) => {
    const input = document.querySelector(`#choice-app-locale input[value="${value}"]`);
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, locale);
  await wait(400);
  await page.evaluate(() => document.getElementById('btn-settings-close').click());
  await wait(300);
}

try {
  await poll(() => page.evaluate(() =>
    document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  model.queueAnswer({ toolCalls: [{ name: 'load_rule', arguments: { name: 'commit-messages', scope: 'workspace' } }] });
  model.queueAnswer({ text: 'Done.' });
  await sendChat(page, 'Write a commit message');
  await poll(() => page.evaluate(() => document.getElementById('chat-messages').textContent.includes('Done.')
    && document.getElementById('chat-log').getAttribute('aria-busy') !== 'true'),
    { what: 'finished chat run' });
  await wait(600);

  for (const locale of ['en', 'de']) {
    await applyLocale(locale);
    const open = await page.evaluate(() =>
      !document.getElementById('chat-token-breakdown')?.classList.contains('hidden'));
    if (!open) await page.evaluate(() => document.getElementById('chat-token-usage')?.click());
    await wait(400);
    await page.evaluate(() =>
      document.querySelector('#chat-token-breakdown [aria-expanded="false"]')?.click());
    await wait(300);
    console.log(`=== ${locale} ===`);
    console.log(await page.evaluate(() => ({
      rows: [...document.querySelectorAll('#chat-token-breakdown .token-breakdown__row-body')].map((el) => el.innerText.replace(/\s+/g, ' ')),
      log: [...document.querySelectorAll('.chat-tool-line, .chat-tool-summary')].map((el) => el.innerText.replace(/\s+/g, ' ')),
    })));
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await wait(300);
      const panel = await page.$('#chat-panel');
      await (panel ?? page).screenshot({ path: path.join(SHOTS, `rules-files-${locale}-${theme}.png`) });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  }
  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop();
  await model.close();
}
