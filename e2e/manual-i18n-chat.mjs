// Hinsehen statt vertrauen (#290): faehrt die echte App hoch, laesst das
// gefakte Modell Tools aufrufen und eine Freigabe ausloesen, und legt je einen
// Screenshot der Chat-Spalte auf Deutsch und auf Englisch ab — hell und dunkel.
// Kein Test — ein Blick.
//
//   node e2e/manual-i18n-chat.mjs
//
// Ergebnis: out/mockup/i18n-chat-*.png

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-i18n-chat-ws-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-i18n-chat-userdata-'));
await mkdir(SHOTS, { recursive: true });

await writeFile(path.join(workspace, 'README.md'), `# Beispielprojekt\n\nEin Absatz.\n`, 'utf8');
await mkdir(path.join(workspace, 'src'));
await writeFile(path.join(workspace, 'src', 'app.js'), "console.log('hallo');\n", 'utf8');
await writeFile(path.join(workspace, 'notizen.md'), 'Ein bestehender Stand.\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

function ask(question) {
  return page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, question);
}

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
  await wait(400);
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

const setTheme = (mode) => page.evaluate((value) => {
  if (value === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}, mode);

const newChat = () => page.evaluate(() => document.getElementById('btn-chat-new')?.click());

/** Nur die Chat-Spalte ins Bild — dort spielt sich alles ab. */
async function shot(name) {
  const column = await page.$('#chat-panel') || await page.$('.chat-column') || null;
  if (column) await column.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  else await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const QUESTION = 'Sieh dir das Projekt an und schreib eine Notiz.';

try {
  await poll(() => page.evaluate(() =>
    document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'gezeichneter Baum' });

  for (const locale of ['en', 'de']) {
    await applyLocale(locale);
    const stored = JSON.parse(await readFile(path.join(userDataDir, 'ui-preferences.json'), 'utf8'));
    console.log(locale, 'gespeicherte Sprache:', stored.appLocale);
    await newChat();
    await wait(500);

    // Erst ein paar harmlose Schritte fuer das Tool-Log, dann ein Schreibaufruf
    // — der braucht im Modus „Smart" eine Freigabe und baut die Karte auf.
    model.queueAnswer({
      match: QUESTION,
      toolCalls: [
        { name: 'list_directory', arguments: { relative_path: '.' } },
        { name: 'read_file_text', arguments: { relative_path: 'README.md' } },
        { name: 'search_in_files', arguments: { query: 'console' } },
      ],
    });
    model.queueAnswer({
      match: 'search_in_files',
      toolCalls: [{
        name: 'write_file_text',
        arguments: {
          relative_path: 'notizen.md',
          content: [
            'Ein Beispielinhalt, der lang genug ist, damit die Vorschau der Karte',
            'mehrere Zeilen hoch wird und der Schalter zum Aufklappen etwas zu tun',
            'bekommt. Genau darum geht es beim Blick auf die lange Karte.',
            '',
            ...Array.from({ length: 12 }, (_, i) => `Zeile ${i + 1}: noch etwas Text.`),
          ].join('\n'),
        },
      }],
    });
    model.queueAnswer({ match: 'write_file_text', text: 'Fertig.' });

    await ask(QUESTION);
    await poll(() => page.evaluate(() => !!document.querySelector('.chat-approval-card')),
      { what: 'Freigabekarte' });
    await wait(600);

    // Die Vorschau aufklappen: erst dann ist die Karte so lang, wie sie im
    // Alltag wird — und der Schalter „Vollständig anzeigen" steht im Bild.
    await page.evaluate(() => {
      const details = document.querySelector('.chat-approval-card__preview');
      if (details) details.open = true;
    });
    await wait(300);

    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      await wait(250);
      await shot(`i18n-chat-approval-${locale}-${theme}`);
    }

    console.log(locale, 'Karte:', await page.evaluate(() => {
      const card = document.querySelector('.chat-approval-card');
      return {
        title: card.querySelector('.chat-approval-card__title')?.textContent,
        headline: card.querySelector('.chat-approval-card__headline')?.textContent,
        actions: [...card.querySelectorAll('.chat-approval-card__actions button')].map((b) => b.textContent),
        status: card.querySelector('.chat-approval-card__status')?.textContent,
      };
    }));

    // Der Punkt aus der Definition of Done: ein Sprachwechsel zeichnet die
    // offene Karte neu, ohne die Entscheidung anzufassen (#290).
    if (locale === 'en') {
      await applyLocale('de');
      await wait(400);
      console.log('Karte nach dem Wechsel auf Deutsch:', await page.evaluate(() => {
        const card = document.querySelector('.chat-approval-card');
        return {
          title: card.querySelector('.chat-approval-card__title')?.textContent,
          headline: card.querySelector('.chat-approval-card__headline')?.textContent,
          status: card.querySelector('.chat-approval-card__status')?.textContent,
        };
      }));
      await shot('i18n-chat-approval-switched-to-de-light');
      await applyLocale('en');
      await wait(400);
    }

    await page.evaluate(() =>
      document.querySelector('.chat-approval-card button[data-response="allow-once"]').click());
    await poll(() => page.evaluate(() => !!document.querySelector('.chat-approval-card__result')),
      { what: 'aufgeloeste Karte' });
    await wait(900);

    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      await wait(250);
      await shot(`i18n-chat-log-${locale}-${theme}`);
    }

    console.log(locale, 'Tool-Log:', await page.evaluate(() => ({
      summary: document.querySelector('.chat-tool-summary')?.textContent?.replace(/\s+/g, ' '),
      lines: [...document.querySelectorAll('.chat-tool-line-text')].map((e) => e.textContent),
      outcome: document.querySelector('.chat-approval-card__result')?.textContent,
    })));
  }

  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop();
  await model.close();
}
