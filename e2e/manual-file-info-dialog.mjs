// Look instead of trust: the information dialog of the file tree (#849) in
// the real app, through the real pipeline — context menu, file-info,
// fs:show-info, renderer. Only the native menu itself is stood in for: its
// popup is swallowed and "Information" is clicked from the main process.
//
//   node e2e/manual-file-info-dialog.mjs [en|de]
//
// Result: out/mockup/file-info-dialog-<locale>-<state>-<theme>.png for the
// states file, copied and folder. The file dates are pinned.

import { mkdir, writeFile, utimes, realpath } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const PINNED = new Date('2026-09-12T15:49:00');

const model = await startFakeModel();
const workspace = await realpath(await makeTempDir('snotra-file-info-'));
const userDataDir = await makeTempDir('snotra-file-info-userdata-');
await mkdir(SHOTS, { recursive: true });

const readme = path.join(workspace, 'README.md');
await writeFile(readme, `# Example project\n\n${'A README of a couple of kilobytes. '.repeat(64)}\n`);
await utimes(readme, PINNED, PINNED);
const docs = path.join(workspace, 'docs');
await mkdir(docs);
for (const name of ['architecture.md', 'security.md', 'release.md']) {
  await writeFile(path.join(docs, name), `# ${name}\n`);
}
await utimes(docs, PINNED, PINNED);

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

async function showInfo(target) {
  // Swallow the native popup and keep the template, then click the entry.
  await app.evaluate(({ Menu }) => {
    if (globalThis.__snotraInfoPatched) return;
    globalThis.__snotraInfoPatched = true;
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => {
      globalThis.__snotraLastTemplate = template;
      const menu = build(template);
      menu.popup = () => {};
      return menu;
    };
  });
  await page.evaluate((p) => window.electronAPI.showFileContextMenu(p), target);
  await app.evaluate(() => {
    const item = globalThis.__snotraLastTemplate
      .find((entry) => entry.label === 'Information' || entry.label === 'Informationen');
    item.click();
  });
  await poll(
    () => page.evaluate(() => !document.getElementById('modal-file-info').classList.contains('hidden')),
    { what: 'information dialog' },
  );
  await new Promise((r) => setTimeout(r, 300));
}

async function shoot(state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => {
      if (th === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
    }, theme);
    await new Promise((r) => setTimeout(r, 150));
    await page.screenshot({ path: path.join(SHOTS, `file-info-dialog-${locale}-${state}-${theme}.png`) });
  }
}

try {
  await poll(
    async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
    { what: 'tree' },
  );

  await showInfo(readme);
  await shoot('file');
  console.log('focus on open:', await page.evaluate(() => document.activeElement?.id));

  await page.click('#modal-file-info-copy');
  await poll(
    () => page.evaluate(() => document.getElementById('modal-file-info-status').textContent !== ''),
    { what: 'copy confirmation' },
  );
  await shoot('copied');
  console.log('clipboard:', await app.evaluate(({ clipboard }) => clipboard.readText()));

  await page.keyboard.press('Escape');
  await showInfo(docs);
  await shoot('folder');
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
