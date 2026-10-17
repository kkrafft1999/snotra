// Look instead of trust (#979): starts the real app, lets a run finish one
// step, kills the app while the next round is still under way, starts it again
// and photographs the turn that comes back with its "Interrupted." note,
// light and dark.
// Not a test — a look.
//
//   node e2e/manual-interrupted-run.mjs [en|de]
//
// Result: out/mockup/interrupted-run-<locale>-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
await mkdir(SHOTS, { recursive: true });

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-interrupted-look-');
const userDataDir = await makeTempDir('snotra-interrupted-look-userdata-');
await writeFile(path.join(workspace, 'README.md'), '# Garden Planner\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');

let snotra = await launchApp({ userDataDir });
try {
  let { page } = snotra;
  await poll(() => page.evaluate(() => !!document.querySelector('#chat-messages > .chat-msg')), { what: 'chat' });
  model.queueAnswer({ match: 'LOOK', toolCalls: [{ name: 'list_directory', arguments: { relative_path: '' } }] });
  model.queueAnswer({ match: 'LOOK', text: 'The beds are laid out as follows', holdUntil: new Promise(() => {}) });
  await sendChat(page, locale === 'de' ? 'Was liegt in diesem Ordner? LOOK' : 'What is in this folder? LOOK');
  await poll(() => model.requests.some((r) => r.answer?.holdUntil), { what: 'second round', timeoutMs: 60000 });
  await poll(async () => {
    const history = await page.evaluate(() => window.electronAPI.getChatHistory());
    return (history?.sessions || []).some((s) => s.messages.some((m) => m.interrupted && m.toolTrace?.length));
  }, { what: 'step saved' });

  const exited = new Promise((resolve) => snotra.app.process().once('exit', resolve));
  snotra.app.process().kill('SIGKILL');
  await exited;

  snotra = await launchApp({ userDataDir });
  page = snotra.page;
  await page.setViewportSize({ width: 1100, height: 700 }).catch(() => {});
  await poll(() => page.evaluate(() => !!document.querySelector('.chat-interrupted-note')), { what: 'note', timeoutMs: 30000 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await new Promise((r) => setTimeout(r, 300));
    await page.locator('#chat-messages').screenshot({ path: path.join(SHOTS, `interrupted-run-${locale}-${theme}.png`) });
  }
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
