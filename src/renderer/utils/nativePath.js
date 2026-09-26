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

/**
 * Liegt `childPath` unterhalb von `dirPath`? Vergleicht Segment für Segment,
 * damit gemischte Trenner und Mehrfach-Trenner nicht stören. Der Ordner selbst
 * zählt nicht als „innerhalb“.
 */
export function isInsideDir(childPath, dirPath) {
  const dir = segmentsOf(dirPath);
  const child = segmentsOf(childPath);
  if (!dir.length || child.length <= dir.length) return false;
  return dir.every((segment, i) => child[i] === segment);
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

/**
 * Resolves a relative POSIX path from a document (`../img/a.png`, `./b.md`)
 * against the native folder it sits in, including `.` and `..` (#344). Keeps
 * the separator of `dir`. A path that climbs above the root of `dir` stays at
 * the root, the way `path.resolve` does — whether the result is still inside
 * the workspace is for the caller to check (`isInsideDir`), and the main
 * process checks again.
 */
export function resolveNative(dir, relPosix) {
  const sep = separatorOf(dir);
  const base = String(dir ?? '');
  // The prefix that `segmentsOf` would drop: `/`, `C:`, or `\\` of a UNC path.
  const uncPrefix = /^[\\/]{2}(?=[^\\/])/.test(base) ? sep + sep : '';
  const rootPrefix = uncPrefix || (/^[\\/]/.test(base) ? sep : '');
  const segments = segmentsOf(base);
  // A UNC path keeps server and share as its root; a drive keeps its letter.
  const fixed = uncPrefix ? Math.min(2, segments.length) : (DRIVE_ONLY.test(segments[0] ?? '') ? 1 : 0);
  for (const part of String(relPosix ?? '').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length > fixed) segments.pop();
      continue;
    }
    segments.push(part);
  }
  const joined = segments.join(sep);
  if (fixed === 1 && segments.length === 1) return `${joined}${sep}`;
  return `${rootPrefix}${joined}` || sep;
}
