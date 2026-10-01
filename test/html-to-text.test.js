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

// #550: the page is written by a stranger and reduced in the main process, so
// unclosed markup must not make the work quadratic. 2 MB is the fetch limit.
test('htmlToText and extractTitle stay linear on 2 MB of unclosed markup (#550)', () => {
  const size = 2 * 1024 * 1024;
  for (const unit of ['<', '<a', '<!--', '<script>', '<style>', '<head>', '<form>', '<title>', '</', '<x ']) {
    const html = unit.repeat(Math.ceil(size / unit.length));
    const started = Date.now();
    htmlToText(html);
    extractTitle(html);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `${JSON.stringify(unit)} took ${elapsed} ms`);
  }
});

test('htmlToText drops what a browser would not show as text (#550)', () => {
  // Raw text runs to the end when it is never closed.
  assert.equal(htmlToText('<p>Visible</p><script>steal()'), 'Visible');
  assert.equal(htmlToText('<p>Visible</p><!-- open comment <p>hidden</p>'), 'Visible');
  // An ordinary element left open loses only its tag; `</head>` is optional.
  assert.equal(htmlToText('<head><meta charset="utf-8"><body><p>Body text</p>'), 'Body text');
  assert.equal(htmlToText('<form><label>Name</label>'), 'Name');
  // A self-closing svg is empty, not the start of everything after it.
  assert.equal(htmlToText('<p>Before <svg viewBox="0 0 1 1"/> after</p>'), 'Before after');
  // `<` that opens no markup is text.
  assert.equal(htmlToText('<p>a < b and c > d</p>'), 'a < b and c > d');
  // A tag cut off at the end takes nothing with it but itself.
  assert.equal(htmlToText('<p>Text</p><div class="cut'), 'Text');
});

test('htmlToText keeps headings, cells and line breaks in any letter case (#550)', () => {
  assert.equal(htmlToText('<H3 id="x">Head</H3><P>Para</P>'), '### Head\n\nPara');
  assert.equal(htmlToText('<table><tr><TD>a</TD><th>b</th></tr></table>'), 'a | b |');
  assert.equal(htmlToText('one<BR/>two<br class="x">three'), 'one\ntwo\nthree');
  assert.equal(htmlToText('<header>Kept</header><SCRIPT>gone()</SCRIPT>'), 'Kept');
});

test('extractTitle reads the first real title element (#550)', () => {
  assert.equal(extractTitle('<titlebar>no</titlebar><TITLE lang="en">Real</TITLE>'), 'Real');
  assert.equal(extractTitle('<title>never closed'), '');
});
