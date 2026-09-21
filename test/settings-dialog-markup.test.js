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

// Issue #102: Die Shell-Ausfuehrung ist die weitreichendste Einstellung der
// App — sie braucht einen eigenen Bereich mit sichtbarer Warnung.
test('die Tool-Einstellungen haben eine Karte für Shell-Befehle mit Warnhinweis (#102)', () => {
  assert.equal(html.split('id="settings-shell-card"').length - 1, 1);
  assert.equal(html.split('id="input-shell-enabled"').length - 1, 1);
  assert.equal(html.split('id="settings-shell-status"').length - 1, 1);

  const cardStart = html.indexOf('id="settings-shell-card"');
  const cardEnd = html.indexOf('id="settings-web-search-card"');
  const card = html.slice(cardStart, cardEnd);
  assert.match(card, /settings-note--warning/, 'die Warnung ist als solche ausgezeichnet');
  assert.match(card, /shell_execute/);
  assert.match(card, /keine<\/strong> Projektordner-Grenze/);
});

// Issue #138: Der Schalter steht im Bereich „Allgemein“ neben dem
// System-Prompt — er betrifft genau den, nicht die Tools. Und er muss sagen,
// dass der absolute Pfad den Anbieter erreicht; sonst ist er eine Falle.
test('der Bereich „Allgemein“ hat einen Schalter für Umgebungsinformationen (#138)', () => {
  assert.equal(html.split('id="input-environment-info"').length - 1, 1);

  const panelStart = html.indexOf('id="panel-settings-general"');
  const panelEnd = html.indexOf('</section>', panelStart);
  const panel = html.slice(panelStart, panelEnd);
  assert.ok(panel.includes('id="input-environment-info"'), 'der Schalter liegt im Allgemein-Panel');

  const toggleAt = panel.indexOf('id="input-environment-info"');
  assert.ok(
    toggleAt > panel.indexOf('id="input-global-system-prompt"'),
    'er steht hinter dem System-Prompt, den er ergänzt'
  );

  const hintAt = panel.indexOf('id="hint-environment-info"');
  assert.ok(hintAt > -1, 'zum Schalter gehört ein Erklärtext');
  assert.match(panel.slice(toggleAt, hintAt + 400), /aria-describedby="hint-environment-info"/);
  const hint = panel.slice(hintAt, panel.indexOf('</details>', hintAt));
  assert.match(hint, /absolute[rn]? Pfad|absolute<\/strong>|<strong>absolute/i);
  assert.match(hint, /Benutzernamen/, 'die Preisgabe wird benannt');
  assert.match(hint, /Anbieter/, 'und wohin sie geht');
});

// Issue #212: Derselbe Platz, dieselbe Begruendungspflicht — der Schalter
// entscheidet, ob fremde Anweisungen aus einem geoeffneten Ordner wirken.
test('der Bereich „Allgemein“ hat einen Schalter für AGENTS.md (#212)', () => {
  assert.equal(html.split('id="input-project-instructions"').length - 1, 1);

  const panelStart = html.indexOf('id="panel-settings-general"');
  const panelEnd = html.indexOf('</section>', panelStart);
  const panel = html.slice(panelStart, panelEnd);
  const toggleAt = panel.indexOf('id="input-project-instructions"');
  assert.ok(toggleAt > -1, 'der Schalter liegt im Allgemein-Panel');
  assert.ok(
    toggleAt > panel.indexOf('id="input-global-system-prompt"'),
    'er steht hinter dem System-Prompt, den er ergänzt'
  );

  const hintAt = panel.indexOf('id="hint-project-instructions"');
  assert.ok(hintAt > -1, 'zum Schalter gehört ein Erklärtext');
  assert.match(
    panel.slice(toggleAt, hintAt + 400),
    /aria-describedby="hint-project-instructions"/
  );
  const hint = panel.slice(hintAt, panel.indexOf('</details>', hintAt));
  // Alle vier Stufen der Kette müssen dort stehen — sonst sucht der Nutzer
  // die Datei an der falschen Stelle.
  for (const pfad of [
    '~/.agents/AGENTS.md',
    '~/.snotra/AGENTS.md',
    '&lt;Ordner&gt;/AGENTS.md',
    '&lt;Ordner&gt;/.agents/AGENTS.md',
  ]) {
    assert.ok(hint.includes(pfad), `der Erklärtext nennt ${pfad}`);
  }
  assert.match(hint, /Anweisung, keine Daten|Anweisung<\/strong>, keine Daten/,
    'und sagt, dass der Inhalt das Verhalten ändert');
});

// Der Umschalter fuer hell/dunkel sass bis v1.7.3 als Knopf in der
// Titelleiste. Er steht jetzt unter „Allgemein" — und nur dort, sonst gaebe es
// zwei Bedienstellen fuer eine Einstellung.
test('das Erscheinungsbild wird unter „Allgemein“ gewählt, nicht in der Titelleiste', () => {
  assert.equal(html.split('id="select-app-theme"').length - 1, 1);
  assert.ok(!html.includes('id="theme-toggle"'), 'in der Titelleiste steht kein Knopf mehr');

  const panelStart = html.indexOf('id="panel-settings-general"');
  const panel = html.slice(panelStart, html.indexOf('</section>', panelStart));
  const selectAt = panel.indexOf('id="select-app-theme"');
  assert.ok(selectAt > -1, 'die Auswahl liegt im Allgemein-Panel');

  const select = panel.slice(selectAt, panel.indexOf('</select>', selectAt));
  assert.match(select, /value="light"/);
  assert.match(select, /value="dark"/);

  // Ohne sichtbares Label braucht die Auswahl eines fuer den Screenreader.
  assert.match(panel.slice(0, selectAt), /for="select-app-theme"[^>]*>Erscheinungsbild/);
});
