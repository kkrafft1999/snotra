// Tool-Log im Chat: die DOM-Schicht am echten DOM (Issue #81).
//
// Bis #81 steckten diese Funktionen als Modul-Interna in ChatStream.js und
// waren nur mittelbar über die ganze Chat-Verdrahtung erreichbar — geprüft
// wurde deshalb nur die DOM-freie Entscheidungslogik (test/tool-log-summary.
// test.js). Seit der Herauslösung nach src/renderer/chat/toolLogView.js lässt
// sich prüfen, was daraus tatsächlich an Knoten entsteht: Zustände der Zeilen,
// Barrierefreiheits-Attribute, der Einzeiler in der <summary> und das
// Abschließen eines abgebrochenen Laufs.
//
// Grenzen des Stacks (siehe test/helpers/dom.js): happy-dom kennt kein Layout,
// deshalb bleibt alles außen vor, was an scrollHeight/clientHeight hängt
// (der Fade am unteren Rand der Schrittliste).

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

async function withDom(fn) {
  const dom = setupRendererDom();
  try {
    const view = await importRenderer('chat', 'toolLogView.js');
    await fn(view, dom);
  } finally {
    dom.cleanup();
  }
}

const textOf = (row) => row.querySelector('.chat-tool-line-text')?.textContent ?? '';
const summaryTextOf = (log) => textOf(log.querySelector('.chat-tool-summary-line'));
const stepRows = (log) => [...log.querySelectorAll('.chat-tool-lines > .chat-tool-line')];

test('buildToolLine zeigt einen laufenden Schritt als beschäftigt an', async () => {
  await withDom(({ buildToolLine }) => {
    const row = buildToolLine('Liest README.md', 'running', 2, 'read');
    assert.ok(row.classList.contains('chat-tool-line--running'));
    assert.equal(row.getAttribute('role'), 'listitem');
    assert.equal(row.getAttribute('aria-busy'), 'true');
    assert.equal(row.getAttribute('aria-label'), 'Running: Liest README.md');
    assert.equal(row.dataset.callIndex, '2');
    assert.equal(row.dataset.category, 'read');
    assert.ok(row.querySelector('.chat-tool-line-icon'), 'Symbol der Kategorie');
    // Die Erledigt-Marke ist ausschließlich für Screenreader und darf noch fehlen.
    assert.equal(row.querySelector('.chat-tool-line-status'), null);
  });
});

test('buildToolLine schließt einen erledigten Schritt mit Marke ab', async () => {
  await withDom(({ buildToolLine }) => {
    const row = buildToolLine('Hat README.md gelesen', 'done');
    assert.ok(row.classList.contains('chat-tool-line--done'));
    assert.equal(row.hasAttribute('aria-busy'), false);
    assert.equal(row.getAttribute('aria-label'), 'Finished: Hat README.md gelesen');
    const status = row.querySelector('.chat-tool-line-status');
    assert.equal(status.textContent, 'Finished');
    assert.ok(status.classList.contains('sr-only'), 'nur für Screenreader');
  });
});

test('buildToolLine hält den vorläufigen Aufruf optisch wie einen laufenden', async () => {
  await withDom(({ buildToolLine }) => {
    // 'pending': Das Modell streamt die Argumente noch, das Tool lief nie.
    const row = buildToolLine('Schreibt notiz.md', 'pending', 0, 'write');
    assert.ok(row.classList.contains('chat-tool-line--pending'));
    assert.equal(row.getAttribute('aria-busy'), 'true');
  });
});

test('applyPermissionToRow schreibt Zustand und Begründung an die Zeile', async () => {
  await withDom(({ buildToolLine }) => {
    const row = buildToolLine('Löscht alt.md · abgelehnt', 'done', 1, 'write', {
      decision: 'deny',
      status: 'denied',
      riskClasses: ['delete'],
      reason: 'user_denied',
    });
    assert.equal(row.dataset.permission, 'denied');
    assert.match(row.title, /Decision:/);
  });
});

test('ohne Audit bleibt die Zeile unverändert', async () => {
  await withDom(({ buildToolLine, applyPermissionToRow }) => {
    const row = buildToolLine('Liest a.md', 'done');
    applyPermissionToRow(row, null);
    assert.equal(row.dataset.permission, undefined);
    assert.equal(row.title, '');
  });
});

test('promoteToolLineToRunning macht aus dem Aufruf einen laufenden Schritt', async () => {
  await withDom(({ buildToolLine, promoteToolLineToRunning }) => {
    const row = buildToolLine('Schreibt …', 'pending', 0, 'write');
    promoteToolLineToRunning(row, 'Schreibt notiz.md');
    assert.equal(row.classList.contains('chat-tool-line--pending'), false);
    assert.ok(row.classList.contains('chat-tool-line--running'));
    assert.equal(textOf(row), 'Schreibt notiz.md');
    assert.equal(row.getAttribute('aria-label'), 'Running: Schreibt notiz.md');
  });
});

test('setToolLineDone übernimmt den Abschlusstext und rührt Erledigtes nicht an', async () => {
  await withDom(({ buildToolLine, setToolLineDone }) => {
    const row = buildToolLine('Liest README.md', 'running');
    setToolLineDone(row, 'Hat README.md gelesen (42 Zeilen)');
    assert.ok(row.classList.contains('chat-tool-line--done'));
    assert.equal(row.hasAttribute('aria-busy'), false);
    assert.equal(textOf(row), 'Hat README.md gelesen (42 Zeilen)');
    // Zweiter Aufruf: der Text bleibt, wie er ist.
    setToolLineDone(row, 'etwas anderes');
    assert.equal(textOf(row), 'Hat README.md gelesen (42 Zeilen)');
    assert.equal(row.querySelectorAll('.chat-tool-line-status').length, 1);
  });
});

test('findPendingToolLine findet die Zeile zum Aufruf, nicht die daneben', async () => {
  await withDom(({ buildToolLine, findPendingToolLine, appendToolLine }) => {
    const lines = document.createElement('div');
    appendToolLine(lines, buildToolLine('A', 'pending', 0));
    appendToolLine(lines, buildToolLine('B', 'pending', 1));
    appendToolLine(lines, buildToolLine('C', 'done', 2));
    assert.equal(textOf(findPendingToolLine(lines, 1)), 'B');
    // Ohne passenden Index nur mit ausdrücklichem Rückfall auf die erste.
    assert.equal(findPendingToolLine(lines, 9), null);
    assert.equal(textOf(findPendingToolLine(lines, undefined, true)), 'A');
    assert.equal(findPendingToolLine(null, 0), null);
  });
});

test('buildToolLog zeichnet den Trace und lässt den letzten Schritt laufen', async () => {
  await withDom(({ buildToolLog }) => {
    const log = buildToolLog(
      [{ line: 'Hat README.md gelesen', tool: 'read_file_text' }, { line: 'Liest docs/', tool: 'list_directory' }],
      'running',
      [{ line: 'Schreibt notiz.md', callIndex: 0, tool: 'write_file_text' }]
    );
    const rows = stepRows(log);
    assert.deepEqual(rows.map(textOf), ['Hat README.md gelesen', 'Liest docs/', 'Schreibt notiz.md']);
    assert.ok(rows[0].classList.contains('chat-tool-line--done'));
    assert.ok(rows[1].classList.contains('chat-tool-line--running'));
    assert.ok(rows[2].classList.contains('chat-tool-line--pending'));
    assert.ok(log.classList.contains('chat-tool-log--running'));
    assert.equal(log.getAttribute('aria-busy'), 'true');
    // Der Einzeiler zeigt den ersten noch offenen Schritt plus die Zahl der weiteren.
    assert.equal(summaryTextOf(log), 'Liest docs/');
    assert.equal(log.querySelector('.chat-tool-summary-extra').textContent, '+1');
  });
});

test('ein einzelner Schritt bekommt kein Aufklapp-Element', async () => {
  await withDom(({ buildToolLog }) => {
    const log = buildToolLog([{ line: 'Hat README.md gelesen', tool: 'read_file_text' }], 'done', []);
    assert.ok(log.classList.contains('chat-tool-log--single'));
    assert.equal(log.querySelector('.chat-tool-summary').tabIndex, -1);
    assert.equal(log.open, false);
  });
});

test('ab zwei Schritten ist der Log aufklappbar und bleibt offen', async () => {
  await withDom(({ buildToolLog }) => {
    const log = buildToolLog(
      [{ line: 'Hat a gelesen', tool: 'read_file_text' }, { line: 'Hat b gelesen', tool: 'read_file_text' }],
      'done',
      []
    );
    assert.equal(log.classList.contains('chat-tool-log--single'), false);
    assert.equal(log.querySelector('.chat-tool-summary').tabIndex, 0);
    log.open = true;
    log.dispatchEvent(new window.Event('toggle'));
    assert.equal(log.open, true);
  });
});

test('der Einzeiler ist eine Live-Region und sagt das Nachdenken an', async () => {
  await withDom(({ buildToolLog, syncToolLogSummary }) => {
    // Nachgedacht wird zwischen den Runden: alle Schritte sind erledigt.
    const log = buildToolLog(
      [{ line: 'Hat a gelesen', tool: 'read_file_text' }, { line: 'Hat b gelesen', tool: 'read_file_text' }],
      'done',
      []
    );
    const line = log.querySelector('.chat-tool-summary-line');
    assert.equal(line.getAttribute('role'), 'status');
    assert.equal(line.getAttribute('aria-live'), 'polite');

    syncToolLogSummary(log, { thinking: true, elapsedMs: 12_000 });
    assert.equal(summaryTextOf(log), 'Model is thinking …');
    assert.equal(line.getAttribute('aria-busy'), 'true');
    // Die tickende Dauer bleibt aus der Ansage heraus, sonst spräche der
    // Screenreader jede Sekunde.
    const elapsed = log.querySelector('.chat-tool-summary-elapsed');
    assert.equal(elapsed.hidden, false);
    assert.equal(elapsed.getAttribute('aria-hidden'), 'true');
    assert.match(elapsed.textContent, /0:12/);
  });
});

test('finalizeAllToolLines wirft nie gelaufene Aufrufe weg und schließt den Rest ab', async () => {
  await withDom(({ buildToolLog, finalizeAllToolLines }) => {
    const log = buildToolLog(
      [{ line: 'Hat a gelesen', tool: 'read_file_text' }, { line: 'Liest b', tool: 'read_file_text' }],
      'running',
      [{ line: 'Schreibt c', callIndex: 0, tool: 'write_file_text' }]
    );
    finalizeAllToolLines(log);
    const rows = stepRows(log);
    assert.deepEqual(rows.map(textOf), ['Hat a gelesen', 'Liest b']);
    assert.ok(rows.every((r) => r.classList.contains('chat-tool-line--done')));
    assert.equal(log.querySelector('.chat-tool-summary-line').getAttribute('aria-busy'), null);
    assert.equal(summaryTextOf(log), '2 files read');
  });
});

test('readToolLogSteps liest Text, Kategorie und Zustand aus dem Baum', async () => {
  await withDom(({ buildToolLog, readToolLogSteps }) => {
    const log = buildToolLog(
      [{ line: 'Hat a gelesen', tool: 'read_file_text' }, { line: 'Liest b', tool: 'read_file_text' }],
      'running',
      []
    );
    assert.deepEqual(readToolLogSteps(log), [
      { text: 'Hat a gelesen', category: 'read', state: 'done' },
      { text: 'Liest b', category: 'read', state: 'running' },
    ]);
  });
});

test('toolTraceEntryForStore behält nur Zeile, Tool und Audit', async () => {
  await withDom(({ toolTraceEntryForStore }) => {
    // Die Argumente aus dem Engine-Ergebnis bleiben draußen: write_file_text
    // trägt dort bis zu 2 MB Dateiinhalt.
    const entry = toolTraceEntryForStore({
      line: 'Hat notiz.md geschrieben',
      tool: 'write_file_text',
      args: { content: 'x'.repeat(1000) },
      permission: { decision: 'allow', status: 'ok' },
    });
    assert.deepEqual(Object.keys(entry).sort(), ['line', 'permission', 'tool']);
    assert.equal(entry.line, 'Hat notiz.md geschrieben');
    // Ohne Zusatzinfo bleibt es bei der reinen Zeile (Sessions vor #60).
    assert.equal(toolTraceEntryForStore({ line: 'Denkt nach' }), 'Denkt nach');
    assert.equal(toolTraceEntryForStore('alte Session'), 'alte Session');
  });
});

test('traceEntryCategory lässt Einträge ohne Tool-Namen ohne Symbol', async () => {
  await withDom(({ traceEntryCategory }) => {
    assert.equal(traceEntryCategory({ line: 'Hat a gelesen', tool: 'read_file_text' }), 'read');
    assert.equal(traceEntryCategory('alte Session ohne Tool-Namen'), null);
    assert.equal(traceEntryCategory({ line: 'nur eine Zeile' }), null);
    assert.equal(traceEntryCategory(null), null);
  });
});

test('isThinking gilt nur, solange nichts Sichtbares da ist', async () => {
  await withDom(({ isThinking }) => {
    assert.equal(isThinking({ streaming: true, phase: 'waiting' }), true);
    assert.equal(isThinking({ streaming: true, phase: 'generating', content: '' }), true);
    assert.equal(isThinking({ streaming: true, phase: 'generating', content: 'Hallo' }), false);
    assert.equal(isThinking({ streaming: true, phase: 'idle' }), false);
    assert.equal(isThinking({ streaming: false, phase: 'waiting' }), false);
    assert.equal(isThinking(null), false);
  });
});

test('syncPhaseLine zeigt die Phasenzeile nur vor dem ersten Tool-Schritt', async () => {
  await withDom(({ syncPhaseLine }) => {
    const phase = document.createElement('div');
    syncPhaseLine(phase, { streaming: true, phase: 'waiting' });
    assert.equal(phase.classList.contains('hidden'), false);
    assert.equal(phase.textContent, 'Model is thinking …');

    // Sobald ein Schritt im Tool-Log steht, zeigt dessen Einzeiler das Nachdenken.
    syncPhaseLine(phase, { streaming: true, phase: 'waiting', toolTrace: ['Hat a gelesen'] });
    assert.ok(phase.classList.contains('hidden'));
    assert.equal(phase.textContent, '');
  });
});

test('ab fünf Sekunden steht die Dauer hinter der Phasenzeile', async () => {
  await withDom(({ syncPhaseLine, thinkingElapsedMs }) => {
    const phase = document.createElement('div');
    const message = { streaming: true, phase: 'waiting', thinkingSince: Date.now() - 65_000 };
    assert.ok(thinkingElapsedMs(message) >= 65_000);
    syncPhaseLine(phase, message);
    assert.match(phase.textContent, /^Model is thinking … · 1:0\d$/);

    // Kurzes Nachdenken bleibt ohne Zahl — sonst flackerte dort eine Uhr.
    syncPhaseLine(phase, { streaming: true, phase: 'waiting', thinkingSince: Date.now() - 500 });
    assert.equal(phase.textContent, 'Model is thinking …');
    assert.equal(thinkingElapsedMs({}), 0);
  });
});
