// Look instead of trust (#419): the mode pill's menu on a system without
// encrypted storage — "Auto" shown but not offered, "Always ask" available.
// safeStorage is switched off in main after the start, which is what the
// renderer sees on a Linux desktop without a keyring.
// Not a test — a look. Run it outside the Claude Code sandbox.
//
//   node e2e/manual-mode-without-encryption.mjs [en|de]
//
// Result: out/mockup/mode-without-encryption-<locale>-<theme>.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-no-keyring-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-no-keyring-userdata-'));
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;
const pause = (ms = 400) => new Promise((r) => setTimeout(r, ms));

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });
  await app.evaluate(({ safeStorage }) => { safeStorage.isEncryptionAvailable = () => false; });
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('ask-all'));
  await poll(() => page.evaluate(() => document.getElementById('chat-tool-mode-wrap').dataset.mode === 'ask-all'),
    { what: 'mode ask-all' });
  await page.evaluate(() => document.getElementById('btn-chat-tool-mode').click());
  await pause();
  console.log('auto disabled:', await page.evaluate(() =>
    document.querySelector('.chat-tool-mode-option[data-mode="auto"]').disabled));
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause();
    const box = await page.evaluate(() => {
      const a = document.getElementById('chat-input-row').getBoundingClientRect();
      const b = document.getElementById('chat-tool-mode-menu').getBoundingClientRect();
      const x = Math.min(a.x, b.x) - 12; const y = Math.min(a.y, b.y) - 12;
      return { x: Math.max(0, x), y: Math.max(0, y), width: Math.max(a.right, b.right) - x + 12, height: Math.max(a.bottom, b.bottom) - y + 12 };
    });
    await page.screenshot({ path: path.join(SHOTS, `mode-without-encryption-${locale}-${theme}.png`), clip: box });
  }
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
