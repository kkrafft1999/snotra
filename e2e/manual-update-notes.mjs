// Look rather than trust (#736): starts the real app and shows the update
// dialog with the release notes of 1.15.0 opened — hand-written highlights in
// bold and inline code, a quoted warning, and GitHub's generated list — in
// both languages, light and dark. Not a test — a look.
//
//   node e2e/manual-update-notes.mjs
//
//   out/mockup/update-notes-<locale>-<theme>.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The body of the v1.15.0 release, as GitHub delivers it.
const NOTES = [
  '## Highlights',
  '',
  '- **Reasoning is chosen in the chat now.** Open the model menu below the input field: the **Reasoning** section sets how hard the model thinks, for this chat only. A model entry no longer carries a level, and the model pill shows model and level, e.g. `gpt-6-luna · medium` (#723).',
  '- **New chats start with `medium`.** If your default entry used `high` until now, new chats start one step lower — pick `high` in the model menu when a question needs it. Chats from before keep the level they ran with.',
  '- **Documents as text:** the agent reads PDF, DOCX, XLSX and PPTX with `extract_document_text` (#42).',
  '',
  '> **Going back to 1.14.x is not supported.** This version moves the model settings to a new format (v6). An older version cannot read it and starts with default settings; your model entries would have to be set up again there.',
  '',
  "## What's Changed",
  '* Offer all seven OpenAI reasoning levels by @kkrafft1999 in https://github.com/kkrafft1999/snotra/pull/719',
  '* Keep the reasoning level per chat (#725) by @kkrafft1999 in https://github.com/kkrafft1999/snotra/pull/729',
  '',
  '',
  '**Full Changelog**: https://github.com/kkrafft1999/snotra/compare/v1.14.4...v1.15.0',
].join('\r\n');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-update-notes-ws-');
const userDataDir = await makeTempDir('snotra-update-notes-userdata-');
await mkdir(SHOTS, { recursive: true });
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
  await wait(300);
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

  for (const locale of ['en', 'de']) {
    await applyLocale(locale);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await app.evaluate(({ BrowserWindow }, notes) => {
        BrowserWindow.getAllWindows()[0].webContents.send('update:available', {
          updateAvailable: true,
          manual: false,
          currentVersion: '1.14.4',
          latestVersion: '1.15.0',
          isPrerelease: false,
          releaseUrl: 'https://github.com/kkrafft1999/snotra/releases/tag/v1.15.0',
          notes,
          canSelfUpdate: true,
          installKind: 'macos-bundle',
          asset: { name: 'Snotra Agent-darwin-arm64-1.15.0.dmg', size: 133_800_000 },
        });
      }, NOTES);
      await poll(() => page.evaluate(() =>
        !document.getElementById('modal-update').classList.contains('hidden')),
        { what: 'open update dialog' });
      await page.evaluate(() => { document.getElementById('modal-update-notes').open = true; });
      await wait(400);
      console.log(`=== ${locale}/${theme} ===`);
      console.log(await page.evaluate(() => document.getElementById('modal-update-notes-body').innerHTML));
      await page.screenshot({ path: path.join(SHOTS, `update-notes-${locale}-${theme}.png`) });
      await page.evaluate(() => {
        const body = document.getElementById('modal-update-notes-body');
        body.scrollTop = body.scrollHeight;
      });
      await wait(200);
      await page.screenshot({ path: path.join(SHOTS, `update-notes-${locale}-${theme}-end.png`) });
      await page.evaluate(() => document.getElementById('modal-update-close').click());
      await wait(300);
    }
  }
  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop();
  await model.close();
}
