const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

// Issue #97: Die Meldung lag im Panel "Modelle". Auf jedem anderen Tab ist
// dieses Panel `hidden` — der Nutzer klickte "Übernehmen" und sah nichts.
test('die Speicher-Fehlermeldung steht in der Dialog-Fußzeile, nicht in einem Tab-Panel (#97)', () => {
  const occurrences = html.split('id="modal-save-error"').length - 1;
  assert.equal(occurrences, 1, 'die Meldung gibt es genau einmal');

  const errorAt = html.indexOf('id="modal-save-error"');
  const footerStart = html.indexOf('<footer class="settings-dialog__footer');
  const footerEnd = html.indexOf('</footer>', footerStart);
  assert.ok(footerStart !== -1 && footerEnd !== -1, 'die Fußzeile des Einstellungsdialogs existiert');
  assert.ok(
    errorAt > footerStart && errorAt < footerEnd,
    'die Meldung muss neben "Übernehmen" in der Fußzeile stehen'
  );

  const lastPanelAt = html.lastIndexOf('class="settings-panel"');
  assert.ok(errorAt > lastPanelAt, 'die Meldung darf in keinem der ausblendbaren Tab-Panels liegen');
});

test('die Speicher-Fehlermeldung wird Screenreadern angesagt (#97)', () => {
  const errorAt = html.indexOf('id="modal-save-error"');
  const tagStart = html.lastIndexOf('<p', errorAt);
  const tag = html.slice(tagStart, html.indexOf('>', errorAt) + 1);
  assert.match(tag, /role="alert"/);
});

// Issue #104: Der Dialog zeigte ganze Absaetze, bevor man den ersten Schalter
// sah. Erklaertext gehoert jetzt hinter einen Aufklapper — wie im Tool-Katalog.
test('lange Erklaertexte stehen hinter einem Aufklapper mit Kurzsatz (#104)', () => {
  const notes = html.match(/<details[^>]*class="settings-note[^"]*"/g) || [];
  assert.ok(notes.length >= 10, `zu wenige Aufklapper gefunden: ${notes.length}`);

  const summaries = html.match(/<summary class="settings-note__summary"/g) || [];
  assert.equal(summaries.length, notes.length, 'jeder Aufklapper hat genau eine sichtbare Zeile');

  const bodies = html.match(/<div class="settings-note__body">/g) || [];
  assert.equal(bodies.length, notes.length, 'jeder Aufklapper hat genau einen Textkoerper');
});

test('die sichtbare Zeile eines Hinweises bleibt ein kurzer Satz (#104)', () => {
  const matches = [...html.matchAll(/<summary class="settings-note__summary">([\s\S]*?)<\/summary>/g)];
  assert.ok(matches.length > 0, 'es gibt Aufklapper mit Kurzsatz');
  for (const [, inner] of matches) {
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.ok(text.length > 0, 'die Kurzzeile ist nicht leer');
    assert.ok(text.length <= 130, `Kurzzeile zu lang (${text.length} Zeichen): ${text}`);
  }
});

// Issue #103: Snotra liest keine .claude-Verzeichnisse mehr — die
// Skills-Beschreibung im Dialog darf sie nicht als Quelle nennen.
test('der Skills-Bereich nennt .claude nicht mehr als Quelle (#103)', () => {
  assert.equal(html.includes('.claude/skills'), false);
  assert.ok(html.includes('.agents/skills'), 'die verbleibende Quelle steht im Dialog');
});
