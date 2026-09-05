/**
 * Pfad-Hilfen für native Dateisystempfade im Renderer (Issue #73).
 *
 * Der Main-Prozess liefert absolute Pfade so, wie das Betriebssystem sie
 * schreibt: unter Windows mit Backslash (`C:\repo\src\app.js`), sonst mit
 * Slash. Der Renderer hat kein `path`-Modul und darf Pfade deshalb nie nur an
 * `/` zerlegen. Diese Hilfen behandeln beide Trenner und erhalten den Stil des
 * Eingabepfads, damit zusammengesetzte Pfade wieder zu denen aus dem
 * Main-Prozess passen (z. B. für Vergleiche mit `appStore.selectedPath`).
 *
 * Relative POSIX-Pfade (Tool-Ergebnisse, @-Referenzen) sind davon nicht
 * betroffen – sie werden vom Main-Prozess bereits normalisiert.
 */

const ANY_SEP = /[\\/]+/;
const TRAILING_SEPS = /[\\/]+$/;
const DRIVE_ONLY = /^[A-Za-z]:$/;

/** Trenner, der zum Stil des Pfads passt: `\` für Windows-Pfade, sonst `/`. */
export function separatorOf(p) {
  const s = String(p ?? '');
  return s.includes('\\') || /^[A-Za-z]:/.test(s) ? '\\' : '/';
}

/** Segmente ohne Leereinträge, unabhängig vom Trenner. */
export function segmentsOf(p) {
  return String(p ?? '')
    .split(ANY_SEP)
    .filter(Boolean);
}

/** Letztes Segment (`app.js`), für Wurzeln der Pfad selbst (`/`, `C:`). */
export function basenameOf(p) {
  const segments = segmentsOf(p);
  return segments.length ? segments[segments.length - 1] : String(p ?? '');
}

/**
 * Elternordner im Stil des Eingabepfads. `/a/b` → `/a`, `/a` → `/`,
 * `C:\a\b` → `C:\a`, `C:\a` → `C:\`, `\\srv\share\x` → `\\srv\share`.
 */
export function parentDirOf(p) {
  const s = String(p ?? '').replace(TRAILING_SEPS, '');
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (idx < 0) return s && DRIVE_ONLY.test(s) ? `${s}\\` : '/';
  const parent = s.slice(0, idx);
  if (parent === '') return '/';
  if (DRIVE_ONLY.test(parent)) return `${parent}\\`;
  return parent;
}

/** Verschachtelungstiefe – zum Sortieren von Ordnern (flach vor tief). */
export function depthOf(p) {
  return segmentsOf(p).length;
}

/**
 * Hängt einen relativen POSIX-Pfad (`src/app.js`, `./x`, `/x`) an einen
 * nativen Ordnerpfad und übernimmt dessen Trenner.
 */
export function joinNative(dir, relPosix) {
  const sep = separatorOf(dir);
  const base = String(dir ?? '').replace(TRAILING_SEPS, '');
  const rel = segmentsOf(String(relPosix ?? '').replace(/^\.\/?/, '')).join(sep);
  if (!rel) return base || sep;
  return `${base}${sep}${rel}`;
}
