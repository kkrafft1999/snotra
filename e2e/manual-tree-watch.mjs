// Hinsehen statt vertrauen: faehrt die echte App hoch, veraendert den Ordner
// von aussen und legt Screenshots ab. Kein Test — ein Blick (Issue #158).
//
//   node e2e/manual-tree-watch.mjs
//
// Ergebnis: out/mockup/tree-watch-*.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-watch-blick-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-watch-userdata-'));
await mkdir(SHOTS, { recursive: true });

await writeFile(path.join(workspace, 'README.md'), '# Beispielprojekt\n', 'utf8');
await mkdir(path.join(workspace, 'src'));
await writeFile(path.join(workspace, 'src', 'app.js'), "console.log('hallo');\n", 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

const labels = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#tree-container .tree-item .label')].map((el) => el.textContent)
  );

try {
  await poll(async () => (await labels()).length > 0, { what: 'gezeichneter Baum' });
  // src aufklappen und README auswaehlen — so sieht ein Arbeitsstand aus.
  await page.evaluate(() => {
    [...document.querySelectorAll('#tree-container .tree-item')]
      .find((el) => el.querySelector('.label')?.textContent === 'src')
      ?.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => {
    [...document.querySelectorAll('#tree-container .tree-item')]
      .find((el) => el.querySelector('.label')?.textContent === 'README.md')
      ?.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(SHOTS, 'tree-watch-1-vorher.png') });
  console.log('vorher:', await labels());

  // Jetzt von aussen: neuer Ordner, neue Dateien, eine davon tief im Baum.
  await mkdir(path.join(workspace, 'docs'));
  await writeFile(path.join(workspace, 'docs', 'konzept.md'), '# Konzept\n', 'utf8');
  await writeFile(path.join(workspace, 'src', 'neu.js'), '// frisch\n', 'utf8');
  await poll(async () => (await labels()).includes('neu.js'), { what: 'src/neu.js im Baum' });
  await page.screenshot({ path: path.join(SHOTS, 'tree-watch-2-angelegt.png') });
  console.log('nach dem Anlegen:', await labels());

  // Und wieder weg — samt der ausgewaehlten Datei.
  await rm(path.join(workspace, 'src', 'neu.js'));
  await rm(path.join(workspace, 'README.md'));
  await poll(async () => !(await labels()).includes('neu.js'), { what: 'neu.js verschwunden' });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SHOTS, 'tree-watch-3-geloescht.png') });
  console.log('nach dem Loeschen:', await labels());
  console.log(
    'Vorschau sichtbar:',
    await page.evaluate(() => !document.getElementById('file-preview').classList.contains('hidden'))
  );
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
