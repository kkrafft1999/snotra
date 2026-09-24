// Hinsehen statt vertrauen: faehrt die echte App hoch, schaltet alle vier
// Spalten weg und legt Screenshots der leeren Flaeche ab (Issue #315).
// Kein Test — ein Blick.
//
//   node e2e/manual-empty-canvas.mjs
//
// Ergebnis: out/mockup/empty-canvas-*.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const TOGGLES = ['btn-toggle-sidebar', 'btn-toggle-content-pane',
  'btn-toggle-chat-panel', 'btn-toggle-chat-history'];

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-leer-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-leer-userdata-'));
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Beispielprojekt\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

const state = () => page.evaluate(() => {
  const app = document.getElementById('app');
  const el = document.getElementById('empty-canvas');
  const box = el.getBoundingClientRect();
  const before = getComputedStyle(el, '::before');
  return {
    appClasses: app.className,
    pressed: ['btn-toggle-sidebar', 'btn-toggle-content-pane', 'btn-toggle-chat-panel',
      'btn-toggle-chat-history'].map((id) =>
      `${id}=${document.getElementById(id).getAttribute('aria-pressed')}`).join(' '),
    display: getComputedStyle(el).display,
    size: `${Math.round(box.width)}x${Math.round(box.height)}`,
    mask: (before.maskImage || before.webkitMaskImage || '').slice(0, 60),
    ink: before.backgroundColor,
  };
});

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'gezeichneter Baum' });

  console.log('vorher :', JSON.stringify(await state(), null, 2));

  await page.evaluate((ids) => {
    for (const id of ids) {
      const button = document.getElementById(id);
      if (button.getAttribute('aria-pressed') !== 'false') button.click();
    }
  }, TOGGLES);
  await page.waitForTimeout(600);

  console.log('nachher:', JSON.stringify(await state(), null, 2));
  await page.screenshot({ path: path.join(SHOTS, 'empty-canvas-light.png') });

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'empty-canvas-dark.png') });

  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
