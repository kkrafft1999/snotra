'use strict';

/**
 * Welche Dateien als Quellcode zaehlen (Issue #78).
 *
 * Eine Stelle fuer zwei Leser: `test/source-files-load.test.js` laedt diese
 * Dateien, damit sie im Coverage-Nenner stehen, und `scripts/coverage.js`
 * prueft, dass genau sie im Bericht auftauchen. Zwei Listen waeren zwei
 * Wahrheiten.
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');

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

/** Alle Quelldateien unter src/, als Pfade relativ zu src/ mit "/" als Trenner. */
function collectSourceFiles(dir = SRC_DIR, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(SRC_DIR, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (!GENERATED_DIRS.includes(rel)) collectSourceFiles(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(rel);
    }
  }
  return out;
}

module.exports = { SRC_DIR, GENERATED_DIRS, ELECTRON_ENTRY_POINTS, collectSourceFiles };
