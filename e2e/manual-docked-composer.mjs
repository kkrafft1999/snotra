// Look instead of trust (#400): starts the real app, docks the chat next to
// an open file and photographs the composer at the panel's default and
// minimum width, and the wide chat for comparison — in "Smart" and in "Auto"
// without sandbox, light and dark. Prints the widths, whether the pills sit on
// a row of their own, and the tab order through the bar.
// Not a test — a look. Run it outside the Claude Code sandbox.
//
//   node e2e/manual-docked-composer.mjs [en|de]
//
// Result: out/mockup/docked-composer-<locale>-*.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-docked-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-docked-userdata-'));
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n\nA file to open next to the chat.\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
// shell_execute on: without a working sandbox "Auto" shows the warning pill.
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale, shellExecutionEnabled: true }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;
const shot = (name) => path.join(SHOTS, `docked-composer-${locale}-${name}.png`);
const pause = (ms = 400) => new Promise((r) => setTimeout(r, ms));

function measure() {
  return page.evaluate(() => {
    const w = (el) => Math.round(el.getBoundingClientRect().width);
    const bar = document.querySelector('.chat-composer-bar');
    const pill = document.getElementById('btn-chat-tool-mode');
    return {
      panel: w(document.getElementById('chat-panel')),
      composer: w(document.getElementById('chat-input-row')),
      bar: w(bar),
      stacked: bar.dataset.stacked === 'true',
      model: w(document.getElementById('chat-model-picker-wrap')),
      mode: w(document.getElementById('chat-tool-mode-wrap')),
      modeCut: pill.scrollWidth > pill.clientWidth,
      overflow: bar.scrollWidth > bar.clientWidth,
    };
  });
}

async function photograph(name) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause();
    await page.locator('#chat-input-row').screenshot({ path: shot(`${name}-${theme}`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

async function tabOrder() {
  await page.evaluate(() => document.getElementById('chat-input').focus());
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    seen.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName));
  }
  return seen;
}

async function setMode(mode) {
  await page.evaluate((m) => window.electronAPI.setToolPermissionMode(m), mode);
  await poll(() => page.evaluate((m) => document.getElementById('chat-tool-mode-wrap').dataset.mode === m, mode),
    { what: `mode ${mode}` });
  await pause();
}

try {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  // The wide chat first: one row, as before.
  console.log('wide:', JSON.stringify(await measure()));
  await photograph('wide-smart');

  // Dock the chat next to the open file.
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('#tree-container .tree-item')].find((el) => /README/.test(el.textContent));
    item?.click();
    item?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await poll(() => page.evaluate(() => !document.getElementById('app').classList.contains('app--no-preview')),
    { what: 'docked chat' });
  await pause(800);

  for (const [label, width] of [['320', ''], ['260', '260px']]) {
    await page.evaluate((w) => { document.getElementById('chat-panel').style.width = w; }, width);
    await pause();
    await setMode('smart');
    console.log(`docked ${label} smart:`, JSON.stringify(await measure()));
    await photograph(`docked-${label}-smart`);
    await setMode('auto');
    console.log(`docked ${label} auto:`, JSON.stringify(await measure()));
    await photograph(`docked-${label}-auto`);
    if (label === '320') console.log('tab order (docked):', (await tabOrder()).join(' → '));
  }
  await page.evaluate(() => { document.getElementById('chat-panel').style.width = ''; });
  await setMode('smart');
  await page.screenshot({ path: shot('docked-window') });
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
