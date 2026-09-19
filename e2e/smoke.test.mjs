// Ein Durchlauf durch die echte App (Issue #78, Schritt 2).
//
// Bewusst **ein** Test statt vieler: die Electron-Ebene ist die teuerste pro
// gefundenem Fehler, und ein Lauf, der beim Start alles einmal anfasst, holt
// den Grossteil davon. Er faehrt die Strecke aus dem Issue — Start, Ordner,
// Datei oeffnen, Chat abbrechen, Einstellungen — und prueft zusaetzlich das
// Sanitizing, das der happy-dom-Stack nicht leisten kann (siehe
// test/helpers/dom.js): DOMPurify braucht echtes Chromium.
//
// Laeuft nicht in `npm test` mit, sondern ueber `npm run test:e2e`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const README = '# Testprojekt\n\nZeile aus der Vorschau.\n';

// Die Fragen dienen dem Fake-Modell als Schluessel: welche Antwort es schickt,
// haengt an der Frage und nicht an der Reihenfolge der Anfragen.
const LONG_QUESTION = 'Erzaehl mir etwas Langes.';
const LINK_QUESTION = 'Zeig mir Links.';

/**
 * Antwort der zweiten Runde: genau das, was der Sanitizer beschneiden muss.
 *
 * `tel:` steht hier nicht zufaellig. DOMPurify wirft `javascript:` schon von
 * sich aus weg — an dem Link haengt also nur die Grundausstattung, nicht die
 * Regel der App. `tel:` laesst DOMPurify hingegen stehen; dass es trotzdem
 * verschwindet, kann nur der eigene Hook aus helpers.js gewesen sein
 * (ALLOWED_LINK_PROTOS: http, https, mailto — sonst nichts).
 */
const ANSWER_WITH_LINKS = [
  'Siehe [die Doku](https://example.com/docs).',
  '',
  '[Bitte klicken](javascript:alert(1))',
  '',
  '[Anrufen](tel:+4912345)',
  '',
  '<img src=x onerror="globalThis.__pwned = true">',
  '',
  '<iframe src="https://example.com"></iframe>',
].join('\n');

/** Frage abschicken — `page.evaluate` sieht nur, was man ihm mitgibt. */
function ask(page, question) {
  return page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, question);
}

async function createWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'snotra-smoke-ws-'));
  await writeFile(path.join(dir, 'README.md'), README, 'utf8');
  await mkdir(path.join(dir, 'notizen'));
  await writeFile(path.join(dir, 'notizen', 'liste.md'), '- eins\n', 'utf8');
  return dir;
}

test('Smoke-Test: Start, Datei oeffnen, Chat abbrechen, Antwort sanitizen, Einstellungen', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await createWorkspace();
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-smoke-userdata-'));
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  });
  const { page } = snotra;
  const readOpenedLinks = await snotra.captureExternalLinks();
  const started = Date.now();
  const step = (name) => t.diagnostic(`${String(Date.now() - started).padStart(6)} ms  ${name}`);
  step('App gestartet');

  // --- Fenstertitel: Name plus laufende Version -----------------------------
  // Der Titel kommt aus dem Main-Prozess, nicht aus dem <title> des Renderers
  // (siehe src/main/window.js) — deshalb hier ueber `app.evaluate` gelesen.
  const { windowTitle, appVersion } = await snotra.app.evaluate(async ({ app, BrowserWindow }) => ({
    windowTitle: BrowserWindow.getAllWindows()[0].getTitle(),
    appVersion: app.getVersion(),
  }));
  assert.equal(windowTitle, `Snotra AI ${appVersion}`);

  // --- Start: der vorgemerkte Ordner ist offen und der Baum gezeichnet -------
  const labels = await poll(
    async () => {
      const found = await page.evaluate(() =>
        [...document.querySelectorAll('#tree-container .tree-item .label')].map((el) => el.textContent)
      );
      return found.length > 0 ? found : null;
    },
    { what: 'gezeichneter Dateibaum' }
  );
  assert.deepEqual(labels, ['notizen', 'README.md']);
  assert.equal(await page.evaluate(() => document.getElementById('project-name').textContent),
    path.basename(workspace));

  // --- Datei oeffnen: die Vorschau zeigt den echten Inhalt ------------------
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#tree-container .tree-item')]
      .find((el) => el.querySelector('.label')?.textContent === 'README.md');
    row.click();
  });
  const preview = await poll(
    async () => {
      const state = await page.evaluate(() => ({
        hidden: document.getElementById('file-preview').classList.contains('hidden'),
        name: document.getElementById('preview-filename').textContent,
        content: document.getElementById('preview-content').textContent,
      }));
      return state.hidden ? null : state;
    },
    { what: 'Dateivorschau' }
  );
  assert.equal(preview.name, 'README.md');
  assert.equal(preview.content, README);
  step('Vorschau geprueft');

  // --- Chat abbrechen: der Stream laeuft, der Stop-Knopf beendet ihn --------
  model.queueAnswer({ match: LONG_QUESTION, text: 'Diese Antwort '.repeat(40), chunkDelayMs: 120 });
  await ask(page, LONG_QUESTION);
  step('lange Frage abgeschickt');

  await poll(() => page.evaluate(() =>
    document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
    { what: 'laufende Antwort (Stop-Knopf)' });
  // Die letzte Bubble, nicht die erste: die erste ist die Begruessung, die die
  // App beim Oeffnen eines Ordners selbst in den Chat schreibt.
  await poll(() => page.evaluate(() => {
    const bubbles = document.querySelectorAll('#chat-messages .chat-msg.assistant');
    return (bubbles[bubbles.length - 1]?.textContent || '').includes('Diese Antwort');
  }), { what: 'erste Textstuecke im Chat' });

  await page.evaluate(() => document.getElementById('btn-chat-send').click());

  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
    { what: 'beendeter Lauf nach dem Abbruch' });
  // Der Abbruch muss bis zum Server durchschlagen, nicht nur die Anzeige stoppen.
  await poll(() => model.requestFor(LONG_QUESTION)?.aborted,
    { what: 'abgebrochene Anfrage am Modellserver' });
  assert.equal(model.requestFor(LONG_QUESTION).finished, false,
    'die abgebrochene Runde darf nicht zu Ende laufen');
  step('Abbruch am Server angekommen');

  // --- Sanitizing in echtem Chromium ---------------------------------------
  model.queueAnswer({ match: LINK_QUESTION, text: ANSWER_WITH_LINKS });
  await ask(page, LINK_QUESTION);
  step('Link-Frage abgeschickt');

  const rendered = await poll(
    async () => {
      const state = await page.evaluate(() => {
        const bubbles = document.querySelectorAll('#chat-messages .chat-msg.assistant');
        const last = bubbles[bubbles.length - 1];
        if (!last) return null;
        const links = [...last.querySelectorAll('a')].map((a) => ({
          text: a.textContent,
          href: a.getAttribute('href'),
          target: a.getAttribute('target'),
          rel: a.getAttribute('rel'),
        }));
        return {
          busy: document.getElementById('chat-messages').getAttribute('aria-busy') === 'true',
          links,
          hasIframe: !!last.querySelector('iframe'),
          hasOnerror: !!last.querySelector('[onerror]'),
          pwned: globalThis.__pwned === true,
        };
      });
      return state && !state.busy && state.links.length >= 3 ? state : null;
    },
    { what: 'fertig gerenderte Antwort mit Links' }
  );

  const doku = rendered.links.find((l) => l.text.includes('die Doku'));
  assert.equal(doku.href, 'https://example.com/docs');
  assert.equal(doku.target, '_blank');
  assert.equal(doku.rel, 'noopener noreferrer');

  const skript = rendered.links.find((l) => l.text.includes('Bitte klicken'));
  assert.equal(skript.href, null, 'javascript: haette entfernt werden muessen');

  const anruf = rendered.links.find((l) => l.text.includes('Anrufen'));
  assert.equal(anruf.href, null, 'tel: laesst DOMPurify stehen — der Hook der App muss es wegnehmen');

  assert.equal(rendered.hasIframe, false, 'iframe haette entfernt werden muessen');
  assert.equal(rendered.hasOnerror, false, 'onerror haette entfernt werden muessen');
  assert.equal(rendered.pwned, false, 'das onerror-Skript ist gelaufen');
  step('Sanitizing geprueft');

  // --- Umgebungsangaben im Systemprompt (Issue #138) -----------------------
  // Nur hier pruefbar: Pfad, Plattform und Datum entstehen erst im echten
  // Main-Prozess. Geprueft wird, was wirklich beim Modell ankommt.
  const systemMessage = model.requestFor(LINK_QUESTION).body.messages
    .find((m) => m.role === 'system')?.content || '';
  assert.match(systemMessage, /Umgebung, in der du gerade läufst \(Snotra AI/);
  assert.ok(
    systemMessage.includes(`- Arbeitsverzeichnis: ${workspace}`),
    'der Block nennt den wirklich geoeffneten Ordner'
  );
  assert.match(systemMessage, new RegExp(`- Plattform: ${process.platform}\\b`));
  assert.match(systemMessage, /- Betriebssystem: \S+ \S+/);
  assert.match(systemMessage, /- Heutiges Datum: \w+, \d{4}-\d{2}-\d{2}/);
  // Der Ordner ist frisch angelegt und kein Repo — die Zeile muss das sagen.
  assert.match(systemMessage, /- Git-Repository: nein/);
  // `shell_execute` ist in der Testkonfiguration aus; dann darf der Block
  // keine Shell versprechen (Nachtrag zu #138).
  assert.ok(!systemMessage.includes('Shell für shell_execute'),
    'ohne eingeschaltetes shell_execute keine Shell-Angabe');
  step('Umgebungsblock im Systemprompt geprueft');

  // --- Klick auf den Link geht bis in den Main-Prozess ----------------------
  await page.evaluate(() => {
    const links = document.querySelectorAll('#chat-messages .chat-msg.assistant a');
    [...links].find((a) => a.textContent.includes('die Doku')).click();
  });
  const opened = await poll(async () => {
    const urls = await readOpenedLinks();
    return urls.length > 0 ? urls : null;
  }, { what: 'an den Main-Prozess gereichter Link' });
  assert.deepEqual(opened, ['https://example.com/docs']);
  step('Link-Klick geprueft');

  // --- Einstellungen: oeffnen, Tab wechseln, mit Escape schliessen ----------
  await page.evaluate(() => document.getElementById('btn-chat-settings').click());
  await poll(() => page.evaluate(() =>
    !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'geoeffneter Einstellungsdialog' });

  // Der Dialog zieht den Fokus zu sich, aber erst am Ende seines Aufbaus — und
  // der laedt vorher Tool-, Skill- und Python-Zustand nach. Darauf warten, sonst
  // laeuft Escape spaeter ins Leere: der Handler haengt am Dialog, nicht am
  // Dokument, und bekommt die Taste ohne Fokus darin nie zu sehen.
  await poll(() => page.evaluate(() => !!document.activeElement?.closest('#modal-settings')),
    { what: 'Fokus im Einstellungsdialog' });

  await page.evaluate(() =>
    document.querySelector('.settings-nav-item[data-settings-panel="tools"]').click());
  const tabs = await page.evaluate(() => ({
    toolsVisible: !document.getElementById('panel-settings-tools').hidden,
    modelsHidden: document.getElementById('panel-settings-models').hidden,
    heading: document.getElementById('settings-panel-heading').textContent,
  }));
  assert.deepEqual(tabs, { toolsVisible: true, modelsHidden: true, heading: 'Tools' });

  // Die Grundausstattung steht nicht in der Liste (#195). Hier statt im
  // Unit-Test, weil erst die gerenderte Liste beweist, dass der Katalog aus
  // dem Main-Prozess auch so ankommt — ein taubes Haekchen waere eine Falle:
  // abgewaehlt wuerde `load_skill` jede Skill-Anleitung voll in den Prompt
  // zurueckholen.
  const toolRows = await poll(async () => {
    const names = await page.evaluate(() =>
      [...document.querySelectorAll('#settings-tool-list input[data-tool-name]')].map(
        (input) => input.dataset.toolName
      )
    );
    return names.length > 0 ? names : null;
  }, { what: 'gerenderte Tool-Liste' });
  for (const hidden of ['list_directory', 'load_skill']) {
    assert.equal(toolRows.includes(hidden), false, `${hidden} steht nicht in der Tool-Liste`);
  }
  // Gegenprobe: die Liste ist nicht einfach leer.
  assert.ok(toolRows.includes('read_file_text'), 'read_file_text steht in der Tool-Liste');
  step('Tool-Liste ohne Grundausstattung geprueft');

  await page.keyboard.press('Escape');
  await poll(() => page.evaluate(() =>
    document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'geschlossener Einstellungsdialog' });
});
