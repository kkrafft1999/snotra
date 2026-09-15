const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Die oeffentlichen Standardpfade der Landingpage: Crawler, Browser und iOS
// fragen sie ungefragt an, und was fehlt, erscheint als 404 im Hosting-Log
// (Issues #116, #119, #127). Die Dateien liegen statisch in website/ — dieser
// Test haelt sie und ihre Verweise zusammen.

const WEB_DIR = path.join(__dirname, '..', 'website');
const ORIGIN = 'https://snotra-ai.dev';

function lies(datei) {
  return fs.readFileSync(path.join(WEB_DIR, datei), 'utf8');
}

function htmlSeiten() {
  return fs.readdirSync(WEB_DIR).filter((datei) => datei.endsWith('.html')).sort();
}

// Firebase Hosting laeuft mit cleanUrls: index.html ist "/", jede weitere Seite
// verliert ihre Endung.
function cleanUrl(datei) {
  return datei === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${datei.replace(/\.html$/, '')}`;
}

test('die Sitemap fuehrt genau die indexierbaren Seiten', () => {
  const sitemap = lies('sitemap.xml');
  const gelistet = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((treffer) => treffer[1]).sort();

  const erwartet = htmlSeiten()
    .filter((datei) => !/<meta\s+name="robots"\s+content="[^"]*noindex/i.test(lies(datei)))
    .map(cleanUrl)
    .sort();

  assert.ok(erwartet.length > 0, 'mindestens eine indexierbare Seite');
  assert.deepEqual(gelistet, erwartet);
  assert.match(sitemap, /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
});

test('robots.txt verweist auf die Sitemap', () => {
  assert.match(lies('robots.txt'), new RegExp(`^Sitemap: ${ORIGIN}/sitemap\\.xml$`, 'm'));
});

test('das Apple-Touch-Icon liegt vor und ist 180x180 und deckend', () => {
  const png = fs.readFileSync(path.join(WEB_DIR, 'apple-touch-icon.png'));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG-Signatur');

  // IHDR folgt direkt auf die Signatur: 4 Byte Laenge, 4 Byte Typ, dann Breite,
  // Hoehe, Bittiefe und Farbtyp.
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 180);
  assert.equal(png.readUInt32BE(20), 180);
  // Farbtyp 2 = RGB ohne Alphakanal. iOS hinterlegt Transparenz mit Schwarz,
  // ein Alphakanal wuerde also als dunkler Rand sichtbar.
  assert.equal(png.readUInt8(25), 2);
});

test('jede Seite bindet das Apple-Touch-Icon ein', () => {
  for (const datei of htmlSeiten()) {
    assert.match(lies(datei), /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/, datei);
  }
});

test('der Precomposed-Pfad wird auf das Apple-Touch-Icon umgeleitet', () => {
  const hosting = require('../firebase.json').hosting;
  const weiterleitung = (hosting.redirects || []).find((r) => r.source === '/apple-touch-icon-precomposed.png');
  assert.ok(weiterleitung, 'Weiterleitung fuer /apple-touch-icon-precomposed.png');
  assert.equal(weiterleitung.destination, '/apple-touch-icon.png');
  assert.equal(weiterleitung.type, 301);
});
