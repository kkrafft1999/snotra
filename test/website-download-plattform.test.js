// Plattformgenauer Download-Knopf der Landingpage (Issue #199).
//
// Android meldet sich als "Linux", iPhone und iPad als "Mac OS X" — wer nur
// diese Namen prueft, bietet einem Telefon ein .deb oder ein DMG an. Der Test
// laedt die echte website/app.js gegen die echte index.html und prueft, was
// der Besucher am Ende im Hero-Knopf liest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Window } = require('happy-dom');

const WEB_DIR = path.join(__dirname, '..', 'website');

// Zeilenenden normalisieren: unter Windows checkt Git per core.autocrlf mit
// CRLF aus.
function lies(datei) {
  return fs.readFileSync(path.join(WEB_DIR, datei), 'utf8').replace(/\r\n/g, '\n');
}

const HTML = lies('index.html');
const APP_JS = lies('app.js');

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  // iPadOS gibt sich ab Version 13 vollstaendig als Mac aus — nur der
  // Touchscreen unterscheidet die beiden.
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
};

function oeffne(userAgent, maxTouchPoints = 0) {
  // Sprache festnageln: happy-dom meldet navigator.language als Englisch,
  // die Seite waehlt sonst das englische Woerterbuch.
  const win = new Window({
    url: 'https://snotra-ai.dev/?lang=de',
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      navigator: { userAgent },
    },
  });
  Object.defineProperty(win.navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
  // Kein Netz im Test: die Seite faellt dann auf die im HTML hinterlegten
  // Links zurueck, genau wie bei Rate-Limit oder Blocker.
  win.fetch = () => Promise.reject(new Error('im Test kein Netz'));
  win.document.write(HTML);
  win.eval(APP_JS);
  return {
    knopf: win.document.getElementById('hero-cta'),
    zweitknopf: win.document.getElementById('hero-cta-alt'),
    hinweis: win.document.getElementById('dl-mobile'),
    schliessen: () => win.happyDOM.close(),
  };
}

test('Telefone und Tablets bekommen kein Desktop-Paket angeboten', () => {
  const geraete = [
    ['iPhone', UA.iphone, 0],
    ['Android-Telefon', UA.android, 5],
    ['iPad', UA.ipad, 5],
  ];

  for (const [name, ua, touch] of geraete) {
    const seite = oeffne(ua, touch);
    assert.equal(seite.knopf.textContent, 'Zu den Downloads', name);
    assert.equal(seite.knopf.getAttribute('href'), '#download', name);
    assert.equal(seite.zweitknopf.hidden, true, `${name}: zweiter Knopf zeigt auf dasselbe Ziel`);
    assert.equal(seite.hinweis.hidden, false, `${name}: Hinweis fehlt`);
    seite.schliessen();
  }
});

test('Rechner bekommen weiterhin ihr Paket, ohne Telefon-Hinweis', () => {
  const geraete = [
    ['macOS', UA.mac, 'Für macOS laden'],
    ['Windows', UA.windows, 'Für Windows laden'],
    ['Linux', UA.linux, 'Für Linux laden'],
  ];

  for (const [name, ua, beschriftung] of geraete) {
    const seite = oeffne(ua, 0);
    assert.ok(seite.knopf.textContent.startsWith(beschriftung), `${name}: "${seite.knopf.textContent}"`);
    assert.equal(seite.zweitknopf.hidden, false, name);
    assert.equal(seite.hinweis.hidden, true, `${name}: Hinweis gehoert nur auf Handhelds`);
    seite.schliessen();
  }
});

test('ohne JS bleibt der Telefon-Hinweis verborgen', () => {
  // Der Hinweis darf nur erscheinen, wenn app.js ein Handheld erkannt hat —
  // ohne JS steht im Hero ohnehin die unveraenderte Vorgabe.
  assert.match(HTML, /id="dl-mobile"\s+hidden\b/);
});
