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
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const README = '# Testprojekt\n\nZeile aus der Vorschau.\n';

// Projektanweisungen (Issue #212, #253): zwei Dateien mit unterscheidbarem
// Inhalt. Nur die aus `.agents/` zaehlt — die in der Ordnerwurzel liegt als
// Koeder daneben und muss ungelesen bleiben.
const WORKSPACE_ROOT_AGENTS_MD = '# Wurzel\n\nAnweisung-aus-der-Ordnerwurzel.\n';
const AGENTS_DIR_AGENTS_MD = '# Projekt\n\nAnweisung-aus-dot-agents.\n';

// Gedaechtnis (Issue #166): eine Ebene mit Eintraegen, damit die Karte in den
// Einstellungen etwas zu zeigen hat. Der zweite Eintrag traegt die Markierung
// „selbst gemerkt" — sie unterscheidet, was Snotra von sich aus notiert hat.
const WORKSPACE_MEMORY_MD = [
  '# Gedächtnis · Projekt',
  '',
  '- 2026-09-21 — Gemerkt-fuer-dieses-Projekt.',
  '- 2026-09-19 (selbst gemerkt) — Von-selbst-gemerkt.',
  '',
].join('\n');

// Die Fragen dienen dem Fake-Modell als Schluessel: welche Antwort es schickt,
// haengt an der Frage und nicht an der Reihenfolge der Anfragen.
const LONG_QUESTION = 'Erzaehl mir etwas Langes.';
// A run that has to survive a chat switch (#320).
const BACKGROUND_QUESTION = 'Arbeite im Hintergrund weiter.';
const BACKGROUND_ANSWER = 'Hintergrund-Antwort '.repeat(30).trim();
const LINK_QUESTION = 'Zeig mir Links.';
const IMAGE_QUESTION = 'Zeig mir das Diagramm.';
const MEMORY_QUESTION = 'Bitte merke dir etwas.';
const MEMORY_NEW_ENTRY = 'Frisch-gemerkt-im-Smoke-Test.';

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

/**
 * Baut ein echtes, graues PNG der gewuenschten Groesse. Selbst gebaut statt
 * einbasierter Konstante, weil die Breite hier die Aussage traegt: Ein Bild,
 * das breiter ist als das Chat-Panel, muss auf dessen Breite schrumpfen — das
 * zeigt nur ein grosses Bild in echtem Chromium.
 */
function makePng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 8 Bit je Kanal
  ihdr[9] = 2;   // Truecolor (RGB)
  // Eine Bildzeile ist ein Filter-Byte plus drei Bytes je Pixel.
  const raw = Buffer.alloc(height * (1 + width * 3), 0x80);
  for (let y = 0; y < height; y += 1) raw[y * (1 + width * 3)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Puts the timestamps of an abort trace (#327) relative to the click on stop,
 * so a CI log reads as one timeline: IPC, signal, reader, server socket.
 */
function describeAbortTrace({ stopClickedAt, main, server }) {
  const rel = (at) => (typeof at === 'number' ? at - stopClickedAt : at);
  const relFields = (obj) => Object.fromEntries(Object.entries(obj).map(([key, value]) =>
    [key, key === 'at' || key.endsWith('At') ? rel(value) : value]));
  const fromArrival = ({ arrivedAt, lastWriteMs, resCloseMs, socketCloseMs, endMs, ...rest }) => {
    const at = (ms) => (typeof ms === 'number' ? rel(arrivedAt + ms) : null);
    return {
      ...rest,
      arrivedAt: rel(arrivedAt),
      lastWriteAt: at(lastWriteMs),
      resCloseAt: at(resCloseMs),
      socketCloseAt: at(socketCloseMs),
      endAt: at(endMs),
    };
  };
  return {
    note: 'ms relative to the stop click',
    ipc: main?.ipc?.map(relFields) ?? main,
    fetches: main?.fetches?.map(relFields) ?? null,
    server: server.map(fromArrival),
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Breiter als jedes Chat-Panel in diesem Test — genau darum geht es. */
const BREITES_PNG = makePng(1200, 60);

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
  // Die Projekt-Quelle der AGENTS.md-Kette (Issue #212) und daneben der
  // Koeder in der Ordnerwurzel, der seit #253 nicht mehr zaehlt. Die globalen
  // Quellen liegen im echten Home des Ausfuehrenden und werden hier bewusst
  // nicht angelegt — der Test schreibt nicht nach `~`.
  await writeFile(path.join(dir, 'AGENTS.md'), WORKSPACE_ROOT_AGENTS_MD, 'utf8');
  await mkdir(path.join(dir, '.agents'));
  await writeFile(path.join(dir, '.agents', 'AGENTS.md'), AGENTS_DIR_AGENTS_MD, 'utf8');
  await writeFile(path.join(dir, '.agents', 'memory.md'), WORKSPACE_MEMORY_MD, 'utf8');
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
  const { page, app } = snotra;
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
  // `.agents` ist versteckt und taucht nicht auf; die AGENTS.md der
  // Ordnerwurzel schon (Issue #212).
  assert.deepEqual(labels, ['notizen', 'AGENTS.md', 'README.md']);
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

  // --- Der Baum folgt dem Dateisystem (Issue #158) --------------------------
  // Kein Klick in der App: Die Datei entsteht daneben, so wie sie im Terminal,
  // im Finder oder unter der Hand der KI entstuende. Der Watcher im Main muss
  // sie melden, der Renderer sie zeichnen.
  const treeLabels = () => page.evaluate(() =>
    [...document.querySelectorAll('#tree-container .tree-item .label')].map((el) => el.textContent)
  );
  const vonAussen = path.join(workspace, 'von-aussen.md');
  await writeFile(vonAussen, '# Von aussen\n', 'utf8');
  await poll(async () => {
    const labels = await treeLabels();
    return labels.includes('von-aussen.md') ? labels : null;
  }, { what: 'von aussen angelegte Datei im Baum' });
  step('angelegte Datei erscheint im Baum');

  await rm(vonAussen);
  await poll(async () => {
    const labels = await treeLabels();
    return labels.includes('von-aussen.md') ? null : labels;
  }, { what: 'von aussen geloeschte Datei aus dem Baum verschwunden' });
  step('geloeschte Datei verschwindet aus dem Baum');

  // --- Chat abbrechen: der Stream laeuft, der Stop-Knopf beendet ihn --------
  // Streams until aborted (#327): on a slow Linux runner the click on stop came
  // after a fixed-length answer had already ended, and nothing was left to abort.
  model.queueAnswer({ match: LONG_QUESTION, text: 'Diese Antwort ', chunkDelayMs: 120, untilAbortedMs: 60000 });
  // #327: record main's and the server's view of this abort, to tell on a
  // failed run whether the abort got lost on its way or the socket stayed open.
  const readAbortTrace = await snotra.traceChatAbort(LONG_QUESTION);
  await ask(page, LONG_QUESTION);
  step('lange Frage abgeschickt');
  // #327: how far the server's stream got at each wait, logged with the step.
  const serverChunks = () => model.requestFor(LONG_QUESTION)?.trace.chunksWritten ?? 0;

  await poll(() => page.evaluate(() =>
    document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
    { what: 'laufende Antwort (Stop-Knopf)' });
  step(`stop button shown (server chunks: ${serverChunks()})`);
  // Wait for the stream at the server, not for text in the bubble (#327): on
  // the xvfb runner Chromium sometimes draws no frame for over ten seconds, and
  // streamed text only reaches the DOM with the next animation frame. Three
  // chunks leave the first one a quarter of a second to arrive in the renderer.
  await poll(() => serverChunks() >= 3, { what: 'laufender Stream am Modellserver' });
  step(`stream running (server chunks: ${serverChunks()})`);

  const stopClickedAt = Date.now();
  await page.evaluate(() => document.getElementById('btn-chat-send').click());

  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
    { what: 'beendeter Lauf nach dem Abbruch' });
  // Der Abbruch muss bis zum Server durchschlagen, nicht nur die Anzeige stoppen.
  const abortDiagnosis = async () => describeAbortTrace({
    stopClickedAt,
    main: await readAbortTrace().catch((err) => ({ unreadable: String(err) })),
    server: model.requests
      .filter((r) => !r.isTitleRequest && JSON.stringify(r.body).includes(LONG_QUESTION))
      .map((r) => ({ aborted: r.aborted, finished: r.finished, ...r.trace })),
  });
  try {
    await poll(() => model.requestFor(LONG_QUESTION)?.aborted,
      { what: 'abgebrochene Anfrage am Modellserver' });
  } catch (err) {
    err.message += `\nAbort trace (#327): ${JSON.stringify(await abortDiagnosis())}`;
    throw err;
  }
  t.diagnostic(`abort trace (#327): ${JSON.stringify(await abortDiagnosis())}`);
  assert.equal(model.requestFor(LONG_QUESTION).finished, false,
    'die abgebrochene Runde darf nicht zu Ende laufen');
  // The abort writes the partial answer into the bubble synchronously, no
  // frame needed. Die letzte Bubble, nicht die erste: die erste ist die
  // Begruessung, die die App beim Oeffnen eines Ordners selbst schreibt.
  const partialAnswer = await page.evaluate(() => {
    const bubbles = document.querySelectorAll('#chat-messages .chat-msg.assistant');
    return bubbles[bubbles.length - 1]?.textContent || '';
  });
  assert.match(partialAnswer, /Diese Antwort/, 'die Teilantwort bleibt nach dem Abbruch im Chat stehen');
  step('Abbruch am Server angekommen');

  // --- Chatwechsel mitten im Lauf (#320): der Lauf arbeitet weiter ---------
  model.queueAnswer({ match: BACKGROUND_QUESTION, text: BACKGROUND_ANSWER, chunkDelayMs: 100 });
  const historyWasClosed = await page.evaluate(() => {
    const closed = document.getElementById('app').classList.contains('app--no-history');
    if (closed) document.getElementById('btn-toggle-chat-history').click();
    return closed;
  });
  await ask(page, BACKGROUND_QUESTION);
  await poll(() => page.evaluate(() => {
    const bubbles = document.querySelectorAll('#chat-messages .chat-msg.assistant');
    return (bubbles[bubbles.length - 1]?.textContent || '').includes('Hintergrund-Antwort');
  }), { what: 'erste Textstuecke des Hintergrundlaufs' });
  const runningChatId = await poll(() => page.evaluate(() =>
    document.querySelector('.chat-history-row--current[data-chat-id]')?.dataset.chatId || null),
    { what: 'laufender Chat im Verlauf' });

  await page.evaluate(() => document.getElementById('btn-chat-new').click());
  const background = await poll(() => page.evaluate((id) => {
    const row = document.querySelector(`.chat-history-row[data-chat-id="${id}"]`);
    if (!row || row.classList.contains('chat-history-row--current')) return null;
    return {
      state: row.dataset.runState || null,
      label: row.querySelector('.chat-history-row-run')?.textContent || '',
      composerBusy: document.getElementById('btn-chat-send').classList.contains('chat-send--stop'),
    };
  }, runningChatId), { what: 'Hintergrundlauf im Verlauf markiert' });
  assert.equal(background.state, 'running', 'die Zeile zeigt den laufenden Chat');
  assert.ok(background.label.length > 0, 'der Zustand steht auch als Text da');
  assert.equal(background.composerBusy, false, 'der neue Chat ist sofort frei');
  assert.equal(model.requestFor(BACKGROUND_QUESTION).aborted, false, 'der Wechsel bricht nichts ab');

  await poll(() => {
    const request = model.requestFor(BACKGROUND_QUESTION);
    // An aborted request never finishes; say so instead of waiting out the clock.
    assert.equal(request?.aborted, false, 'der Hintergrundlauf wurde unterwegs abgebrochen');
    return request?.finished;
  }, { what: 'Hintergrundlauf am Modellserver zu Ende' });
  await poll(() => page.evaluate((id) =>
    !document.querySelector(`.chat-history-row[data-chat-id="${id}"]`)?.dataset.runState, runningChatId),
    { what: 'Markierung nach dem Ende verschwunden' });

  await page.evaluate((id) =>
    document.querySelector(`.chat-history-row[data-chat-id="${id}"]`)?.click(), runningChatId);
  const answer = await poll(() => page.evaluate(({ id, question }) => {
    // Wait for the switch itself: until then the new chat's greeting is the last bubble.
    // The highlighted row alone does not say so — a history render still due from the
    // background run's own write can mark the row while the switch is still waiting
    // on main, before the list is drawn. The chat's own question does.
    if (!document.querySelector(`.chat-history-row--current[data-chat-id="${id}"]`)) return null;
    const list = document.getElementById('chat-messages');
    const shown = [...list.querySelectorAll('.chat-msg.user')]
      .some((bubble) => (bubble.textContent || '').includes(question));
    if (!shown || list.getAttribute('aria-busy') === 'true') return null;
    const bubbles = list.querySelectorAll('.chat-msg.assistant');
    return { text: bubbles[bubbles.length - 1]?.textContent ?? '' };
  }, { id: runningChatId, question: BACKGROUND_QUESTION }), { what: 'zurueck im ersten Chat' });
  assert.ok(answer.text.includes(BACKGROUND_ANSWER), 'die im Hintergrund fertig gewordene Antwort steht im eigenen Chat');
  if (historyWasClosed) await page.evaluate(() => document.getElementById('btn-toggle-chat-history').click());
  step('Hintergrundlauf ueberlebt den Chatwechsel');

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
  assert.match(systemMessage, /The environment you are running in \(Snotra AI/);
  assert.ok(
    systemMessage.includes(`- Working directory: ${workspace}`),
    'der Block nennt den wirklich geoeffneten Ordner'
  );
  assert.match(systemMessage, new RegExp(`- Platform: ${process.platform}\\b`));
  assert.match(systemMessage, /- Operating system: \S+ \S+/);
  assert.match(systemMessage, /- Today's date: \w+, \d{4}-\d{2}-\d{2}/);
  // Der Ordner ist frisch angelegt und kein Repo — die Zeile muss das sagen.
  assert.match(systemMessage, /- Git repository: no/);
  // `shell_execute` ist in der Testkonfiguration aus; dann darf der Block
  // keine Shell versprechen (Nachtrag zu #138).
  assert.ok(!systemMessage.includes('Shell for shell_execute'),
    'ohne eingeschaltetes shell_execute keine Shell-Angabe');
  step('Umgebungsblock im Systemprompt geprueft');

  // Der Systemprompt nennt die System-Skills nur mit ihrer Kurzbeschreibung;
  // der Text selbst kommt erst auf `load_skill` (Issue #173).
  assert.match(systemMessage, /- snotra-capabilities: What Snotra AI itself can do/);
  assert.equal(systemMessage.includes('{menu:'), false, 'kein ungefuellter Platzhalter beim Modell');

  // --- Projektanweisungen aus AGENTS.md (Issue #212, #253) -----------------
  // Auch das entsteht erst im echten Main-Prozess: Welche Dateien gefunden
  // werden, weiss nur der Adapter am Dateisystem.
  assert.match(systemMessage, /Project instructions from AGENTS\.md/);
  assert.match(systemMessage, /## AGENTS\.md \(project\)/);
  assert.ok(
    systemMessage.includes('Anweisung-aus-dot-agents.'),
    'die AGENTS.md aus .agents steht im Prompt'
  );
  // Der Koeder in der Ordnerwurzel darf nicht mitkommen (#253).
  assert.ok(
    !systemMessage.includes('Anweisung-aus-der-Ordnerwurzel.'),
    'eine AGENTS.md in der Ordnerwurzel wird nicht mehr gelesen'
  );
  // Vor dem Ordner-/Tool-Block, damit ihn keine fremde AGENTS.md ueberschreibt.
  assert.ok(
    systemMessage.indexOf('Project instructions from AGENTS.md')
      < systemMessage.indexOf('folder currently open in the app')
  );
  step('AGENTS.md im Systemprompt geprueft');

  // --- Gedaechtnis im Systemprompt (Issue #166) ----------------------------
  // Dieselbe Begruendung: Welche memory.md gefunden wird, entscheidet der
  // Adapter am Dateisystem, nicht der Core.
  assert.match(systemMessage, /Your memory/);
  assert.match(systemMessage, /## Memory \(project\)/);
  assert.ok(
    systemMessage.includes('Gemerkt-fuer-dieses-Projekt.'),
    'die memory.md aus .agents steht im Prompt'
  );
  // Direkt hinter dem eigenen Prompt des Nutzers und damit vor allem Fremden.
  assert.ok(
    systemMessage.indexOf('Your memory') < systemMessage.indexOf('Project instructions from AGENTS.md')
  );
  step('Gedaechtnis im Systemprompt geprueft');

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

  // --- Bilder aus dem Arbeitsordner in der Antwort (Issue #244) -------------
  // Nur hier pruefbar: happy-dom rendert keine Bilder. Erst Chromium sagt, ob
  // aus dem data:-URI wirklich Pixel werden — `naturalWidth > 0`.
  await mkdir(path.join(workspace, 'bilder'), { recursive: true });
  // Leerzeichen im Namen: Im Markdown steht dafuer `%20`, und nur eine
  // Ruecknahme dieser Kodierung findet die Datei wieder.
  await writeFile(path.join(workspace, 'bilder', 'mein plot.png'), BREITES_PNG);
  await writeFile(path.join(workspace, 'diagramm.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const absolutesBild = path.join(workspace, 'bilder', 'mein plot.png');
  model.queueAnswer({
    match: IMAGE_QUESTION,
    text: [
      '![Relativ](bilder/mein%20plot.png)',
      '',
      `![Absolut](${encodeURI(absolutesBild.split(path.sep).join('/'))})`,
      '',
      '![Fehlt](bilder/gibtsnicht.png)',
      '',
      '![Vektor](diagramm.svg)',
      '',
      '![Draussen](../../etc/hosts)',
      '',
      // Nicht wegen des Ergebnisses, sondern wegen des Weges: DOMPurify liest
      // `C:` als unbekanntes URL-Schema und wuerde das `src` wegwerfen. Ob die
      // Datei dann existiert, haengt an der Plattform — dass der Pfad
      // ueberhaupt beim Aufloeser ankommt, nicht.
      '![Laufwerk](C:/ws/bilder/plot.png)',
    ].join('\n'),
  });
  await ask(page, IMAGE_QUESTION);
  step('Bild-Frage abgeschickt');

  const bilder = await poll(
    async () => {
      const state = await page.evaluate(() => {
        const bubbles = document.querySelectorAll('#chat-messages .chat-msg.assistant');
        const last = bubbles[bubbles.length - 1];
        if (!last) return null;
        return {
          busy: document.getElementById('chat-messages').getAttribute('aria-busy') === 'true',
          geladen: [...last.querySelectorAll('img')].map((img) => ({
            alt: img.getAttribute('alt'),
            istDataUri: (img.getAttribute('src') || '').startsWith('data:image/png;base64,'),
            breite: img.naturalWidth,
            passtInDieBlase: img.getBoundingClientRect().width <= last.getBoundingClientRect().width,
          })),
          platzhalter: [...last.querySelectorAll('.chat-md-image--placeholder')].map((box) => ({
            alt: box.querySelector('.chat-md-image-alt')?.textContent || '',
            grund: box.querySelector('.chat-md-image-reason')?.textContent || '',
            rolle: box.getAttribute('role'),
          })),
        };
      });
      // Das Aufloesen laeuft ueber IPC und ist einen Tick spaeter dran als das
      // fertige Markup; direkt danach steht das Dekodieren noch aus. Vor
      // beidem saehe man 5 rohe <img> und haette nichts gemessen.
      const fertig = state
        && !state.busy
        && state.geladen.length === 2
        && state.platzhalter.length === 4
        && state.geladen.every((bild) => bild.breite > 0);
      return fertig ? state : null;
    },
    { what: 'aufgeloeste Bilder in der Antwort' }
  );

  // Relativ und absolut: beide kommen an, beide sind wirklich dekodiert.
  assert.deepEqual(bilder.geladen.map((b) => b.alt).sort(), ['Absolut', 'Relativ']);
  for (const bild of bilder.geladen) {
    assert.equal(bild.istDataUri, true, `${bild.alt}: kommt als data:-URI`);
    assert.ok(bild.breite > 0, `${bild.alt}: Chromium hat das Bild wirklich dekodiert`);
    assert.equal(bild.passtInDieBlase, true, `${bild.alt}: sprengt die Blase nicht`);
  }

  // Fehlend, SVG und ausserhalb: Platzhalter mit Grund statt Broken-Image-Icon.
  const gruende = Object.fromEntries(bilder.platzhalter.map((p) => [p.alt, p.grund]));
  assert.deepEqual(Object.keys(gruende).sort(), ['Draussen', 'Fehlt', 'Laufwerk', 'Vektor']);
  assert.equal(gruende.Fehlt, 'Bild nicht gefunden');
  assert.equal(gruende.Vektor, 'Dieses Bildformat wird nicht angezeigt');
  assert.equal(gruende.Draussen, 'Außerhalb des Arbeitsordners');
  // Der Laufwerkspfad darf alles sein, nur nicht „gar nicht erst gefragt“ —
  // genau das waere er ohne die Ausnahme im Sanitizer.
  assert.notEqual(gruende.Laufwerk, 'Nur Bilder aus dem Arbeitsordner werden angezeigt');
  for (const p of bilder.platzhalter) {
    assert.equal(p.rolle, 'img', `${p.alt}: der Platzhalter meldet sich als Bild`);
  }
  step('Bilder aus dem Arbeitsordner geprueft');

  // --- Einstellungen: oeffnen, Tab wechseln, mit Escape schliessen ----------
  // Es gibt keinen Knopf mehr dafuer: Der Dialog haengt am Menueeintrag
  // "Einstellungen…" (Cmd/Ctrl+Komma). Das Kuerzel selbst laesst sich von
  // aussen nicht druecken, der Eintrag dahinter schon. Wo er steht, haengt an
  // der Plattform (Issue #266) — auf macOS im App-Menue, sonst unter
  // "Ansicht" —, deshalb wird die ganze Leiste durchsucht statt ein Menue
  // geraten. Dass es genau eine Fundstelle gibt, prueft der Unit-Test.
  const settingsMenu = await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => i.label?.startsWith('Einstellungen'));
      if (item) {
        item.click();
        return top.label;
      }
    }
    return null;
  });
  assert.ok(settingsMenu, 'Einstellungen stehen in keinem Menue');
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

  // Gedaechtnis (Issue #166): beide Ebenen als eigene Karte, die Eintraege aus
  // der Datei als Text. Hier statt im Unit-Test, weil erst die gerenderte
  // Liste beweist, dass die Datei ueber den Main-Prozess bis ins DOM kommt —
  // und dass der Eintragstext als Text ankommt und nicht als Markup.
  await page.evaluate(() =>
    document.querySelector('.settings-nav-item[data-settings-panel="memory"]').click());
  const memory = await poll(async () => {
    const found = await page.evaluate(() => ({
      heading: document.getElementById('settings-panel-heading').textContent,
      karten: [...document.querySelectorAll('#settings-memory-scopes .memory-card__path')].map(
        (el) => el.textContent
      ),
      eintraege: [...document.querySelectorAll('#settings-memory-scopes .memory-item__text')].map(
        (el) => el.textContent
      ),
      badges: [...document.querySelectorAll('.memory-item__origin')].map((el) => el.textContent),
      selbstSchalter: document.getElementById('input-memory-self')?.checked,
    }));
    return found.eintraege.length > 0 ? found : null;
  }, { what: 'gerendertes Gedaechtnis' });
  assert.equal(memory.heading, 'Gedächtnis');
  // Beide Ebenen stehen da, auch die leere globale.
  assert.deepEqual(memory.karten, ['.agents/memory.md', '~/.snotra/memory.md']);
  assert.ok(memory.eintraege.some((t) => t.includes('Gemerkt-fuer-dieses-Projekt.')), memory.eintraege.join(' | '));
  assert.deepEqual(memory.badges, ['selbst gemerkt']);
  // Der Schalter fuer selbststaendiges Merken steht voreingestellt an.
  assert.equal(memory.selbstSchalter, true);
  step('Gedaechtnis-Einstellungen geprueft');

  await page.keyboard.press('Escape');
  await poll(() => page.evaluate(() =>
    document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'geschlossener Einstellungsdialog' });

  // --- Zitierte Menuepfade im Skill-Text (Issue #294) -----------------------
  // Erst `load_skill` bringt den Text ans Modell. Der Satz darum bleibt
  // englisch (#276); die Einstellungsseite heisst so, wie sie in der
  // eingestellten Sprache heisst — hier Deutsch.
  const SKILL_QUESTION = 'Was kannst du eigentlich alles?';
  model.queueAnswer({
    match: SKILL_QUESTION,
    toolCalls: [{ name: 'load_skill', arguments: { name: 'snotra-capabilities' } }],
  });
  model.queueAnswer({ match: 'load_skill', text: 'Einiges.' });
  await ask(page, SKILL_QUESTION);

  const skillResult = await poll(() => {
    for (const request of model.requests) {
      const message = request.body?.messages?.findLast?.((m) => m.role === 'tool');
      if (typeof message?.content === 'string' && message.content.includes('"skill":"snotra-capabilities"')) {
        return message.content;
      }
    }
    return null;
  }, { what: 'Skill-Text beim Modell' });
  assert.match(skillResult, /Einstellungen › Tools/, 'zitierter Menuepfad in der Oberflaechensprache');
  assert.equal(skillResult.includes('{menu:'), false, 'kein ungefuellter Platzhalter beim Modell');
  // Der Satz darum ist und bleibt englisch. (Dass im Quelltext des Skills
  // keine Seite fest in einer Sprache steht, haelt test/ui-quotes.test.js.)
  assert.match(skillResult, /The tool list of this conversation is what counts/);
  step('Menuepfade im Skill-Text geprueft');

  // --- „merk dir das": Modell → Freigabe → Datei (Issue #166) ---------------
  // Die teuerste Strecke des Gedaechtnisses und die einzige, die kein
  // Unit-Test erreicht: Erst hier faellt auf, wenn die Berechtigungspruefung
  // dazwischengeht. Genau das tat sie anfangs — ein Schreib-Tool ohne
  // Pfadziel gilt dort als ungueltig, bis `pathlessWrite` es ausnimmt.
  model.queueAnswer({
    match: MEMORY_QUESTION,
    toolCalls: [{
      name: 'remember',
      arguments: { scope: 'workspace', text: MEMORY_NEW_ENTRY, origin: 'requested' },
    }],
  });
  model.queueAnswer({ match: 'remember', text: 'Hab ich mir gemerkt.' });
  await ask(page, MEMORY_QUESTION);

  const approval = await poll(() => page.evaluate(() => {
    const card = document.querySelector('.chat-approval-card');
    if (!card) return null;
    return {
      text: card.textContent.replace(/\s+/g, ' '),
      antworten: [...card.querySelectorAll('button[data-response]')].map((b) => b.dataset.response),
    };
  }), { what: 'Freigabekarte fuer remember' });
  // Die Karte nennt die Reichweite und den Merksatz — einen Pfad gibt es
  // nicht, weil das Tool keinen bildet.
  assert.match(approval.text, /Reichweite/);
  assert.match(approval.text, /gilt nur im geöffneten Ordner/);
  assert.equal(approval.text.includes('ohne Dateiziel'), false, 'kein "ohne Dateiziel" auf der Karte');
  assert.ok(approval.antworten.includes('allow-once'), approval.antworten.join(','));

  await page.evaluate(() =>
    document.querySelector('.chat-approval-card button[data-response="allow-once"]').click());

  const gemerkt = await poll(async () => {
    try {
      const text = await readFile(path.join(workspace, '.agents', 'memory.md'), 'utf8');
      return text.includes(MEMORY_NEW_ENTRY) ? text : null;
    } catch {
      return null;
    }
  }, { what: 'in die memory.md geschriebener Eintrag' });
  // Angehaengt, mit Datum, ohne das Bestehende anzuruehren.
  assert.match(gemerkt, new RegExp(`- \\d{4}-\\d{2}-\\d{2} — ${MEMORY_NEW_ENTRY}`));
  assert.ok(gemerkt.includes('Gemerkt-fuer-dieses-Projekt.'), 'der alte Eintrag steht noch da');
  step('„merk dir das" bis in die Datei geprueft');

  // --- Alle Spalten weg: der Liegestuhl kommt (Issue #315) ------------------
  // Steht am Ende, weil es jede Spalte wegschaltet. Der Unit-Test haelt den
  // Vertrag zwischen Markup, Stylesheet und Datei; hier laeuft Chromium, also
  // ist erst hier pruefbar, was ihn ausmacht: dass die Maske wirklich geladen
  // wird und die Flaeche nicht leer bleibt.
  // Jeder Knopf traegt die Klasse, die er an #app setzt. Geklickt wird, bis
  // alle vier stehen: Das Wegschalten einer Spalte kann eine andere
  // nachtraeglich wieder aufmachen (der Resizer raeumt die Breiten neu auf),
  // und ein Nutzer klickt in dem Fall auch einfach noch einmal.
  const TOGGLE_CLASSES = {
    'btn-toggle-sidebar': 'app--no-sidebar',
    'btn-toggle-content-pane': 'app--no-preview',
    'btn-toggle-chat-panel': 'app--no-chat',
    'btn-toggle-chat-history': 'app--no-history',
  };
  const hideAllPanels = () => poll(async () => {
    const missing = await page.evaluate((map) => {
      const app = document.getElementById('app');
      const open = Object.entries(map).filter(([, cls]) => !app.classList.contains(cls));
      for (const [id] of open) document.getElementById(id).click();
      return open.map(([, cls]) => cls);
    }, TOGGLE_CLASSES);
    return missing.length === 0 ? true : null;
  }, { what: 'alle vier Spalten weggeschaltet' });

  const canvasState = () => page.evaluate(() => {
    const el = document.getElementById('empty-canvas');
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el, '::before');
    return {
      display: getComputedStyle(el).display,
      width: Math.round(box.width),
      height: Math.round(box.height),
      mask: style.maskImage || style.webkitMaskImage,
      ink: style.backgroundColor,
    };
  });

  await hideAllPanels();
  const bare = await poll(async () => {
    const state = await canvasState();
    return state.display === 'flex' ? state : null;
  }, { what: 'sichtbarer Liegestuhl' });
  assert.ok(bare.width > 200 && bare.height > 100, `Flaeche zu klein: ${bare.width}x${bare.height}`);
  assert.match(bare.mask, /empty-canvas\.svg/, 'die Maske haengt am ::before');
  // Deckkraft klar unter 1: Die Zeichnung ist Grund, nicht Inhalt. Chromium
  // gibt color-mix als `color(srgb r g b / a)` zurueck, nicht als rgba().
  const alphaMatch = bare.ink.match(/\/\s*([\d.]+)\s*\)/)
    || bare.ink.match(/rgba\([^)]*,\s*([\d.]+)\s*\)/);
  const alpha = Number(alphaMatch?.[1] ?? 1);
  assert.ok(alpha > 0.2 && alpha < 0.7, `Tinte unerwartet deckend: ${bare.ink}`);

  // Und es ist auch wirklich etwas zu sehen. Eine Maske, die nicht laedt,
  // faerbt nichts — im DOM sieht dann trotzdem alles richtig aus. Deshalb der
  // Blick auf die Pixel: ein Ausschnitt mit Zeichnung komprimiert deutlich
  // schlechter als dieselbe Flaeche ohne sie.
  const clip = await page.evaluate(() => {
    const { x, y, width, height } = document.getElementById('empty-canvas').getBoundingClientRect();
    return { x, y, width, height };
  });
  const mitZeichnung = await page.screenshot({ clip });
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'ohne-zeichnung';
    style.textContent = '#empty-canvas::before { display: none; }';
    document.head.appendChild(style);
  });
  const ohneZeichnung = await page.screenshot({ clip });
  await page.evaluate(() => document.getElementById('ohne-zeichnung').remove());
  assert.ok(mitZeichnung.length > ohneZeichnung.length * 3,
    `Flaeche sieht leer aus: ${mitZeichnung.length} vs. ${ohneZeichnung.length} Bytes`);

  // Eine Spalte zurueck, und die Zeichnung ist wieder weg — ohne Neuladen.
  await page.evaluate(() => document.getElementById('btn-toggle-chat-panel').click());
  const wieder = await poll(async () => {
    const state = await canvasState();
    return state.display === 'none' ? state : null;
  }, { what: 'wieder versteckter Liegestuhl' });
  assert.equal(wieder.display, 'none');
  step('leere Flaeche mit Liegestuhl geprueft');

  // --- File > New Chat with the chat column hidden (issue #381) ------------
  // Like the settings: the shortcut cannot be pressed from outside, the menu
  // item behind it can. The chat still holds the earlier rounds, so an empty
  // list proves the reset; the column has to come back and take the focus.
  await page.evaluate(() => document.getElementById('btn-toggle-chat-panel').click());
  await poll(() => page.evaluate(() =>
    document.getElementById('app').classList.contains('app--no-chat')),
    { what: 'hidden chat column' });
  assert.ok(await page.evaluate(() =>
    document.querySelectorAll('#chat-messages .chat-msg.user').length > 0),
    'the chat should still hold the earlier questions');

  const newChatMenu = await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => i.label === 'Neuer Chat');
      if (item) {
        item.click();
        return { menu: top.label, accelerator: item.accelerator };
      }
    }
    return null;
  });
  assert.deepEqual(newChatMenu, {
    menu: process.platform === 'darwin' ? 'Ablage' : 'Datei',
    accelerator: 'CmdOrCtrl+N',
  });
  const fresh = await poll(async () => {
    const state = await page.evaluate(() => ({
      chatVisible: !document.getElementById('app').classList.contains('app--no-chat'),
      userMessages: document.querySelectorAll('#chat-messages .chat-msg.user').length,
      focus: document.activeElement?.id,
    }));
    return state.chatVisible && state.userMessages === 0 && state.focus === 'chat-input' ? state : null;
  }, { what: 'new chat with the column back and the focus in the input' });
  assert.equal(fresh.focus, 'chat-input');
  step('Datei > Neuer Chat geprueft');
});
