const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Die Landingpage uebersetzt sich zur Laufzeit aus zwei Woerterbuechern in
// app.js. Faellt ein Schluessel in einem davon aus, bleibt die Stelle in dieser
// Sprache auf dem im HTML eingebackenen Deutsch stehen — sichtbar erst, wenn
// jemand die Seite auf Englisch aufruft (Issue #118 war genau das).

const WEB_DIR = path.join(__dirname, '..', 'website');

// Zeilenenden normalisieren: Unter Windows checkt Git die Dateien per
// core.autocrlf mit CRLF aus, sonst laufen die zeilenweisen Muster ins Leere.
function lies(datei) {
  return fs.readFileSync(path.join(WEB_DIR, datei), 'utf8').replace(/\r\n/g, '\n');
}

// Die beiden Literale `var DE = { … };` / `var EN = { … };` aus app.js
// herausschneiden und ihre Schluessel einsammeln. Bewusst ueber den Quelltext
// statt durch Ausfuehren: app.js ist eine IIFE, die ein echtes window erwartet.
function schluessel(name) {
  const src = lies('app.js');
  const start = src.indexOf(`  var ${name} = {`);
  assert.notEqual(start, -1, `Woerterbuch ${name} nicht gefunden`);
  const ende = src.indexOf('\n  };', start);
  assert.notEqual(ende, -1, `Ende von ${name} nicht gefunden`);
  const block = src.slice(start, ende);
  return new Set([...block.matchAll(/^\s{4}'([^']+)':/gm)].map((treffer) => treffer[1]));
}

// Jede Stelle, die eine Seite uebersetzt haben will: der Textinhalt per
// data-i18n und einzelne Attribute per data-i18n-attr="attribut:schluessel".
function angeforderteSchluessel(datei) {
  const html = lies(datei);
  const ausText = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((treffer) => treffer[1]);
  const ausAttr = [...html.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((treffer) =>
    treffer[1].split(/\s+/).map((paar) => paar.split(':')[1]).filter(Boolean),
  );
  return [...ausText, ...ausAttr];
}

function htmlSeiten() {
  return fs.readdirSync(WEB_DIR).filter((datei) => datei.endsWith('.html')).sort();
}

test('beide Woerterbuecher fuehren dieselben Schluessel', () => {
  const de = schluessel('DE');
  const en = schluessel('EN');

  assert.ok(de.size > 100, 'das deutsche Woerterbuch ist unerwartet klein');
  assert.deepEqual(
    [...de].filter((k) => !en.has(k)).sort(),
    [],
    'Schluessel fehlen im englischen Woerterbuch',
  );
  assert.deepEqual(
    [...en].filter((k) => !de.has(k)).sort(),
    [],
    'Schluessel fehlen im deutschen Woerterbuch',
  );
});

test('jeder im HTML angeforderte Schluessel steht im Woerterbuch', () => {
  const de = schluessel('DE');

  for (const datei of htmlSeiten()) {
    const fehlend = [...new Set(angeforderteSchluessel(datei))].filter((k) => !de.has(k)).sort();
    assert.deepEqual(fehlend, [], `${datei} fordert Schluessel an, die es nicht gibt`);
  }
});

test('kein Woerterbuch-Schluessel liegt unbenutzt herum', () => {
  const imHtml = new Set(htmlSeiten().flatMap(angeforderteSchluessel));

  // Einige Schluessel setzt erst app.js ein — etwa die Hinweistexte, die beim
  // Modellwechsel in der Demo ausgetauscht werden. Gesucht wird nur unterhalb
  // der beiden Woerterbuecher, sonst zaehlte jede Definition als Verwendung.
  const src = lies('app.js');
  const code = src.slice(src.indexOf('  var DICT = {'));

  // Ein paar Schluessel setzt app.js aus einem Praefix zusammen
  // (`t('hero.cta.platform.' + key)`), deshalb zaehlt auch das Praefix.
  function benutzt(k) {
    if (imHtml.has(k) || code.includes(`'${k}'`)) return true;
    const praefix = k.slice(0, k.lastIndexOf('.') + 1);
    return praefix.length > 1 && code.includes(`'${praefix}'`);
  }

  const unbenutzt = [...schluessel('DE')].filter((k) => !benutzt(k)).sort();

  assert.deepEqual(unbenutzt, [], 'Schluessel ohne Verwendung — entfernen oder einsetzen');
});
