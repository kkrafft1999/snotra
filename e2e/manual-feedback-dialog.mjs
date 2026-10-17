// Look instead of trust: the feedback form (#1045) in the real app, sent
// through main to a fake endpoint on a loopback port — never the real one.
//
//   node e2e/manual-feedback-dialog.mjs [en|de]
//
// Result: out/mockup/feedback-<locale>-<state>-<theme>.png for the states
// sidebar (the bar at the foot of the tree), form, failed and sent.

import { mkdir, writeFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');

// The fake endpoint: the first request fails as GitHub would, the next is filed.
let requests = 0;
const endpoint = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    requests += 1;
    res.setHeader('Content-Type', 'application/json');
    if (requests === 1) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'upstream_failed' }));
      return;
    }
    res.statusCode = 201;
    res.end(JSON.stringify({ id: 'f1', issueUrl: 'https://github.com/kkrafft1999/snotra/issues/1203' }));
  });
});
await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
const endpointUrl = `http://127.0.0.1:${endpoint.address().port}/api/feedback`;

const model = await startFakeModel();
const workspace = await realpath(await makeTempDir('snotra-feedback-'));
const userDataDir = await makeTempDir('snotra-feedback-userdata-');
await mkdir(SHOTS, { recursive: true });
for (const name of ['README.md', 'notes.md', 'todo.md']) await writeFile(path.join(workspace, name), `# ${name}\n`);
await mkdir(path.join(workspace, 'docs'));

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir, env: { SNOTRA_FEEDBACK_ENDPOINT: endpointUrl } });
const { page } = snotra;

const MESSAGE = locale === 'de'
  ? 'Ich hätte gern eine Möglichkeit, einen Chat als Markdown-Datei zu exportieren, um ihn im Team weiterzugeben.'
  : 'I would like to export a chat as a Markdown file, so I can pass it on to my team.';

async function shoot(state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => {
      if (th === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
    }, theme);
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: path.join(SHOTS, `feedback-${locale}-${state}-${theme}.png`) });
  }
}

try {
  await poll(
    async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
    { what: 'file tree' },
  );
  await page.hover('#btn-sidebar-feedback');
  await new Promise((r) => setTimeout(r, 300));
  await shoot('sidebar');

  await page.click('#btn-sidebar-feedback');
  await poll(
    () => page.evaluate(() => document.getElementById('feedback-diagnostics-values').textContent.length > 0),
    { what: 'feedback form with diagnostics' },
  );
  await page.fill('#feedback-message', MESSAGE);
  await shoot('form');

  await page.click('#feedback-send');
  await poll(() => page.evaluate(() => !document.getElementById('feedback-fallback').hidden), { what: 'failure' });
  await shoot('failed');

  await page.click('#feedback-send');
  await poll(() => page.evaluate(() => !document.getElementById('feedback-sent').hidden), { what: 'sent' });
  await shoot('sent');
  console.log(`feedback screenshots in ${SHOTS} (requests to the fake endpoint: ${requests})`);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  endpoint.close();
}
