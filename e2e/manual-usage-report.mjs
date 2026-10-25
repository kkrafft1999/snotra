// Look instead of trust (#1258): starts the real app on a history spread over
// three folders, five models and six weeks, opens the usage report and
// photographs it — by model, by workspace with a row unfolded and its chats
// shown, the chart as a table, a period without spending — light and dark.
// Not a test — a look.
//
//   node e2e/manual-usage-report.mjs [en|de]
//
// Result: out/mockup/usage-report-<locale>-<state>-{light,dark}.png

import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';
import { usageFolderNames, writeUsageHistory } from './helpers/usage-fixture.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
await mkdir(SHOTS, { recursive: true });

const model = await startFakeModel();
const parent = await realpath(await makeTempDir('snotra-usage-look-'));
const folders = [locale === 'de' ? 'gartenplaner' : 'garden-planner', ...usageFolderNames(locale)].map((name) => path.join(parent, name));
for (const folder of folders) await mkdir(folder, { recursive: true });
await writeFile(path.join(folders[0], 'README.md'), '# Garden Planner\n', 'utf8');
const userDataDir = await makeTempDir('snotra-usage-look-userdata-');
await prepareUserData(userDataDir, { workspace: folders[0], modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'folder-history.json'), JSON.stringify({ paths: folders }), 'utf8');
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
await writeUsageHistory(userDataDir, { folders, locale });

const snotra = await launchApp({ userDataDir });
const { page } = snotra;
await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shoot(name) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(300);
    await page.screenshot({ path: path.join(SHOTS, `usage-report-${locale}-${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const rows = () => page.evaluate(() => document.querySelectorAll('#usage-table .usage-table__row').length);

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0), { what: 'tree' });
  await page.click('#btn-sidebar-usage');
  await poll(async () => (await rows()) > 0, { what: 'report rows' });
  await page.mouse.move(0, 0);
  await shoot('models');

  await page.click('input[name="usage-group"][value="workspaces"]', { force: true });
  await poll(() => page.evaluate(() => /website|garden|garten/i.test(document.getElementById('usage-table').textContent)), { what: 'workspace rows' });
  await page.click('#usage-table .usage-table__row .usage-table__disclosure');
  await page.click('#usage-table .usage-table__row .usage-table__chats');
  await page.mouse.move(0, 0);
  await pause(200);
  await shoot('workspaces');

  await page.evaluate(() => document.getElementById('usage-table').scrollIntoView({ block: 'start' }));
  await shoot('workspaces-scrolled');

  await page.evaluate(() => document.querySelector('.usage-dialog__body').scrollTo(0, 0));
  await page.click('.usage-chart__toggle');
  await shoot('chart-table');
  await page.click('.usage-chart__toggle');

  await page.click('input[name="usage-period"][value="all"]', { force: true });
  await pause(300);
  await shoot('all-time');

  await page.click('input[name="usage-period"][value="custom"]', { force: true });
  await pause(200);
  await page.fill('#usage-from', '2020-01-01');
  await page.fill('#usage-to', '2020-01-31');
  await page.dispatchEvent('#usage-to', 'change');
  await pause(300);
  await shoot('empty');

  await page.setViewportSize({ width: 760, height: 760 }).catch(() => {});
  await page.click('input[name="usage-period"][value="last7"]', { force: true });
  await pause(300);
  await shoot('narrow');
  console.log('done');
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
