/**
 * Übersetzt einen Baum-Eintrag (nativer, absoluter Pfad) in eine
 * @-Referenz für die Chat-Eingabe (Issue #56) — DOM-frei, damit es sich
 * unter node:test prüfen lässt.
 *
 * Der Dateibaum arbeitet mit nativen Pfaden aus dem Main-Prozess (Windows mit
 * Backslash), die Chat-Referenz ist dagegen immer relativ zur Workspace-Wurzel
 * und in POSIX-Schreibweise — genau wie die Einträge aus
 * `fs:listWorkspacePaths`, die die @-Liste füllen.
 */

import { segmentsOf } from '../utils/nativePath.js';

/**
 * Eigener MIME-Typ für den Drag aus dem Baum. Er unterscheidet den internen
 * Drag von einem fremden Text-Drag: nur mit diesem Typ fängt die Chat-Eingabe
 * den Drop ab, alles andere bleibt der normale Browser-Weg.
 */
export const TREE_DRAG_MIME = 'application/x-snotra-path';

/** Packt Pfad und Ordner-Kennzeichen in die Drag-Nutzlast. */
export function encodeTreeDragPayload({ path, isDirectory = false } = {}) {
  return JSON.stringify({ path: String(path ?? ''), isDirectory: Boolean(isDirectory) });
}

/**
 * Liest die Drag-Nutzlast zurück. Alles Unerwartete (leer, kaputtes JSON,
 * fremder Inhalt) ergibt null — der Drop wird dann nicht abgefangen.
 * @returns {{ path: string, isDirectory: boolean } | null}
 */
export function decodeTreeDragPayload(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.path !== 'string' || !parsed.path) return null;
  return { path: parsed.path, isDirectory: Boolean(parsed.isDirectory) };
}

/**
 * Rechnet einen absoluten Pfad in eine @-Referenz relativ zur Wurzel um.
 *
 * Verglichen wird Segment für Segment (wie `isInsideDir`), damit gemischte und
 * mehrfache Trenner sowie ein Schrägstrich am Ende der Wurzel nichts ändern.
 * Alles außerhalb des Workspace — und die Wurzel selbst — ergibt null, denn
 * dafür gibt es keine relative Schreibweise.
 *
 * @returns {{ path: string, kind: 'file' | 'directory' } | null} Eintrag im
 *   Format der @-Vervollständigung (siehe mentionAutocomplete.js).
 */
export function workspaceReferenceFor(absPath, rootPath, { isDirectory = false } = {}) {
  if (typeof absPath !== 'string' || typeof rootPath !== 'string') return null;
  const root = segmentsOf(rootPath);
  const target = segmentsOf(absPath);
  if (!root.length || target.length <= root.length) return null;
  if (!root.every((segment, i) => target[i] === segment)) return null;
  return {
    path: target.slice(root.length).join('/'),
    kind: isDirectory ? 'directory' : 'file',
  };
}
