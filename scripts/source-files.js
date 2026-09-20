'use strict';

/**
 * Welche Dateien als Quellcode zaehlen (Issue #78).
 *
 * Eine Stelle fuer zwei Leser: `test/source-files-load.test.js` laedt diese
 * Dateien, damit sie im Coverage-Nenner stehen, und `scripts/coverage.js`
 * prueft, dass genau sie im Bericht auftauchen. Zwei Listen waeren zwei
 * Wahrheiten.
 *
 * Daneben steht `collectTestFiles()` fuer die Dateien unter `test/`. Sie
 * gehoeren nicht in den Coverage-Nenner — Tests messen sich nicht selbst —,
 * aber der Steuerzeichen-Waechter in `test/source-files-load.test.js` liest
 * sie mit, weil ein NUL eine Testdatei genauso zur Binaerdatei macht wie eine
 * Quelldatei (Issue #206).
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const TEST_DIR = path.join(__dirname, '..', 'test');

/** Erzeugte Dateien gehoeren nicht in den Nenner: sie stammen aus dem Build. */
const GENERATED_DIRS = ['renderer/vendor', 'renderer/generated'];

/**
 * Die Einstiegspunkte der App. Sie verdrahten beim Laden die Runtime von
 * Electron und lassen sich ausserhalb davon nicht laden — hier steht, woran es
 * jeweils scheitert, damit die Liste nicht unbesehen waechst.
 */
const ELECTRON_ENTRY_POINTS = new Map([
  ['main/index.js', 'ruft beim Laden app.setName() — braucht den Electron-Main-Prozess'],
  ['preload/index.js', 'braucht contextBridge aus dem Preload-Kontext'],
  ['preload/bundle.js', 'erzeugtes Preload-Bundle, ebenfalls contextBridge'],
  ['renderer/app.js', 'verdrahtet die Oberflaeche beim Laden, braucht window.electronAPI'],
]);

/** Alle .js-Dateien unter `base`, als Pfade relativ zu `base` mit "/" als Trenner. */
function collectJsFiles(base, skipDirs, dir = base, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (!skipDirs.includes(rel)) collectJsFiles(base, skipDirs, full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(rel);
    }
  }
  return out;
}

/** Alle Quelldateien unter src/, als Pfade relativ zu src/ mit "/" als Trenner. */
function collectSourceFiles() {
  return collectJsFiles(SRC_DIR, GENERATED_DIRS);
}

/** Alle Testdateien unter test/, als Pfade relativ zu test/ mit "/" als Trenner. */
function collectTestFiles() {
  return collectJsFiles(TEST_DIR, []);
}

module.exports = {
  SRC_DIR,
  TEST_DIR,
  GENERATED_DIRS,
  ELECTRON_ENTRY_POINTS,
  collectSourceFiles,
  collectTestFiles,
};
