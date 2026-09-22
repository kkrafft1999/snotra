// Hinsehen statt vertrauen: faehrt die echte App hoch, oeffnet Einstellungen ›
// Tools und legt je einen Screenshot auf Deutsch und auf Englisch ab. Dazu die
// Informations-Tabelle des Dateibaums in beiden Sprachen (Issues #291, #292).
// Kein Test — ein Blick.
//
//   node e2e/manual-i18n-language-switch.mjs
//
// Ergebnis: out/mockup/i18n-*.png

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-i18n-ws-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-i18n-userdata-'));
await mkdir(SHOTS, { recursive: true });

await writeFile(path.join(workspace, 'README.md'), `# Beispielprojekt\n${'x'.repeat(2000)}\n`, 'utf8');
await mkdir(path.join(workspace, 'src'));
await writeFile(path.join(workspace, 'src', 'app.js'), "console.log('hallo');\n", 'utf8');
// Eine Datei ohne Textvorschau: dann zeigt die mittlere Spalte die Info-Tafel.
await writeFile(path.join(workspace, 'bild.png'), Buffer.alloc(1468006, 7));

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function openSettings() {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() =>
    !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'geoeffneter Einstellungsdialog' });
  await wait(600);
}

async function applyLocale(locale) {
  await openSettings();
  await page.evaluate(() =>
    document.querySelector('.settings-nav-item[data-settings-panel="general"]').click());
  await wait(200);
  // Seit #298 ist die Sprache ein Segmented Control und wirkt sofort — kein
  // „Übernehmen" mehr, der Dialog wird einfach wieder geschlossen.
  await page.evaluate((value) => {
    const input = document.querySelector(`#choice-app-locale input[value="${value}"]`);
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, locale);
  await wait(400);
  await page.evaluate(() => document.getElementById('btn-settings-close').click());
  await poll(() => page.evaluate(() =>
    document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'geschlossener Einstellungsdialog' });
  await wait(400);
}

try {
  await poll(() => page.evaluate(() =>
    document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'gezeichneter Baum' });

  for (const locale of ['de', 'en']) {
    await applyLocale(locale);
    await openSettings();
    await page.evaluate(() =>
      document.querySelector('.settings-nav-item[data-settings-panel="tools"]').click());
    await wait(500);
    // Einen Volltext aufklappen, damit beide Texte im Bild stehen.
    await page.evaluate(() => { document.querySelector('.settings-tool-row__summary')?.click(); });
    await wait(200);
    await page.screenshot({ path: path.join(SHOTS, `i18n-tools-${locale}.png`) });
    console.log(locale, JSON.stringify(await page.evaluate(() =>
      [...document.querySelectorAll('.settings-tool-row')].slice(0, 2).map((li) => ({
        name: li.querySelector('.settings-tool-row__name')?.textContent,
        short: li.querySelector('.settings-tool-row__short')?.textContent,
        detail: li.querySelector('.settings-tool-row__desc')?.textContent?.slice(0, 80),
      }))), null, 2));
    await page.keyboard.press('Escape');
    await wait(400);
  }

  // --- Dateibaum: Info-Tafel und Vorschau in beiden Sprachen ---------------
  for (const locale of ['de', 'en']) {
    await applyLocale(locale);
    // Eine Datei ohne Textvorschau zeigt die Info-Tafel mit Groesse und Datum.
    await page.evaluate(() => {
      [...document.querySelectorAll('#tree-container .tree-item')]
        .find((el) => el.querySelector('.label')?.textContent === 'bild.png')
        ?.click();
    });
    await wait(400);
    console.log(locale, 'Dateibaum:', await page.evaluate(() => ({
      infoHidden: document.getElementById('file-info')?.classList.contains('hidden'),
      size: document.getElementById('info-size')?.textContent,
      modified: document.getElementById('info-modified')?.textContent,
      type: document.getElementById('info-type')?.textContent,
      reference: document.querySelector('.tree-item-reference')?.title,
    })));
    await page.screenshot({ path: path.join(SHOTS, `i18n-tree-${locale}.png`) });
  }

  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop();
  await model.close();
}
