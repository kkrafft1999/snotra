// Jede Quelldatei muss sich laden lassen (Issue #78, Schritt 3).
//
// Zwei Gruende, warum dieser Test existiert:
//
// 1. **Ehrliche Coverage.** Node misst nur, was der Testlauf tatsaechlich
//    laedt. Dateien, die kein Test anfasst, tauchen im Bericht gar nicht auf —
//    die Gesamtzahl bezieht sich dann auf eine Auswahl und sieht besser aus,
//    als sie ist. Wer hier geladen wird, steht im Nenner, notfalls mit 0 %.
// 2. **Ein echter Befund.** Ein Tippfehler im Importpfad oder ein
//    Syntaxfehler in einer Datei, die sonst niemand importiert, faellt hier
//    auf — vorher erst beim Nutzer.
//
// Geladen heisst nicht getestet. Was diese Datei zur Coverage beitraegt, ist
// die Zeile im Bericht, nicht die Prozentzahl dahinter.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setupRendererDom } = require('./helpers/dom.js');

const { SRC_DIR, ELECTRON_ENTRY_POINTS, collectSourceFiles } = require('../scripts/source-files.js');

test('jede Quelldatei laesst sich laden', async (t) => {
  // Die Renderer-Module sind natives ESM und erwarten ein DOM; ohne das
  // scheitern sie schon am Import ihrer Nachbarn.
  const dom = setupRendererDom();
  t.after(dom.cleanup);

  const failures = [];
  for (const rel of collectSourceFiles()) {
    if (ELECTRON_ENTRY_POINTS.has(rel)) continue;
    const full = path.join(SRC_DIR, rel);
    try {
      if (rel.startsWith('renderer/')) await import(pathToFileURL(full).href);
      else require(full);
    } catch (err) {
      failures.push(`${rel}: ${err.message}`);
    }
  }

  assert.deepEqual(failures, [], `nicht ladbare Quelldateien:\n${failures.join('\n')}`);
});

test('die Ausnahmeliste zeigt auf Dateien, die es noch gibt', () => {
  for (const rel of ELECTRON_ENTRY_POINTS.keys()) {
    assert.ok(fs.existsSync(path.join(SRC_DIR, rel)), `${rel} steht in der Ausnahmeliste, existiert aber nicht mehr`);
  }
});

// Ein echtes Steuerzeichen im Quelltext - etwa ein NUL in einer Zeichenklasse,
// das als Escape-Sequenz gemeint war - macht die Datei fuer Git zur
// Binaerdatei. Der Code laeuft weiter, aber `git diff` zeigt nur noch
// "Bin 0 -> N bytes", die Datei faellt aus `git grep`, und ein Review sieht die
// Aenderung nicht mehr. Genau so ist es in #193 passiert (behoben in #202);
// dieser Waechter faengt den naechsten Fall beim Test statt im Review.
test('keine Quelldatei enthaelt echte Steuerzeichen', () => {
  // Tab, Zeilenumbruch und Wagenruecklauf sind gewoehnlicher Weissraum.
  const erlaubt = new Set([0x09, 0x0a, 0x0d]);
  const treffer = [];
  for (const rel of collectSourceFiles()) {
    const bytes = fs.readFileSync(path.join(SRC_DIR, rel));
    for (let i = 0; i < bytes.length; i += 1) {
      const byte = bytes[i];
      if ((byte < 0x20 || byte === 0x7f) && !erlaubt.has(byte)) {
        const zeile = bytes.subarray(0, i).toString('utf8').split('\n').length;
        treffer.push(`${rel}:${zeile} - 0x${byte.toString(16).padStart(2, '0')}`);
        break;
      }
    }
  }
  assert.deepEqual(
    treffer,
    [],
    `Steuerzeichen im Quelltext (als Escape-Sequenz schreiben):\n${treffer.join('\n')}`
  );
});
