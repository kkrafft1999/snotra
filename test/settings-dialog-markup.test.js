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
