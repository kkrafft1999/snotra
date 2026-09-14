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
