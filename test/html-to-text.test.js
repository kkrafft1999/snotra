const test = require('node:test');
const assert = require('node:assert/strict');
const { htmlToText, extractTitle, decodeEntities } = require('../src/shared/runtime/html-to-text');

// Issue #95: Rohes HTML kostet ein Vielfaches an Token und besteht
// groesstenteils aus Markup. Geprueft wird, dass Inhalt bleibt und Beiwerk geht.

test('htmlToText wirft Skripte, Styles und Kopfdaten weg', () => {
  const text = htmlToText(`
    <html><head><title>T</title><style>.a{color:red}</style></head>
    <body><script>evil()</script><noscript>bitte JS</noscript>
    <p>Sichtbarer Text.</p></body></html>`);

  assert.equal(text, 'Sichtbarer Text.');
});

test('htmlToText behält Überschriften, Absätze und Listen als Struktur', () => {
  const text = htmlToText(
    '<h2>Titel</h2><p>Erster Absatz.</p><p>Zweiter Absatz.</p><ul><li>A</li><li>B</li></ul>'
  );

  assert.match(text, /^## Titel/);
  assert.match(text, /Erster Absatz\.\n\nZweiter Absatz\./);
  assert.match(text, /- A\n- B/);
});

test('htmlToText macht aus <br> Zeilenumbrüche und räumt Weißraum auf', () => {
  const text = htmlToText('<p>Zeile 1<br>Zeile 2</p>\n\n\n\n<p>   viel    Luft   </p>');

  assert.match(text, /Zeile 1\nZeile 2/);
  assert.doesNotMatch(text, /\n{3,}/);
  assert.doesNotMatch(text, / {2,}/);
});

test('htmlToText löst Entities auf', () => {
  assert.equal(htmlToText('<p>Caf&eacute; &amp; Bar &ndash; 5&nbsp;&euro;</p>'), 'Café & Bar – 5 €');
  assert.equal(htmlToText('<p>&#228;&#x00F6;&#252;</p>'), 'äöü');
});

test('decodeEntities lässt Unbekanntes stehen, statt zu raten', () => {
  assert.equal(decodeEntities('&gibtsnicht; &amp;'), '&gibtsnicht; &');
  assert.equal(decodeEntities('&#999999999;'), '&#999999999;');
});

test('htmlToText verträgt Bruchstücke und leere Eingaben', () => {
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText('<p>offen ohne Ende'), 'offen ohne Ende');
  assert.equal(htmlToText('nur Text ohne Markup'), 'nur Text ohne Markup');
});

test('extractTitle liefert den Seitentitel entschlüsselt und gekürzt', () => {
  assert.equal(extractTitle('<html><head><title>Snotra &amp; Co</title></head></html>'), 'Snotra & Co');
  assert.equal(extractTitle('<title>\n  mehrzeilig\n  gesetzt\n</title>'), 'mehrzeilig gesetzt');
  assert.equal(extractTitle('<html><body>ohne Titel</body></html>'), '');
  assert.equal(extractTitle(`<title>${'x'.repeat(400)}</title>`).length, 300);
});
