/**
 * Reine Logik der @-Vervollständigung (Issue #52), ohne DOM — damit sie sich
 * unter node:test prüfen lässt. Die Komponente MentionAutocomplete.js hängt
 * die Funktionen an das Eingabefeld.
 *
 * Ein Eintrag hat die Form { path: 'docs/roadmap.md', kind: 'file' | 'directory' },
 * der Pfad ist relativ zur Workspace-Wurzel in POSIX-Schreibweise.
 */

// Ein „@“ zählt nur am Textanfang oder nach Leerraum bzw. einer öffnenden
// Klammer/einem Anführungszeichen — so bleiben E-Mail-Adressen normaler Text.
const MENTION_LEAD_IN = /[\s(["'`„‚«‹]/;

/**
 * Sucht die noch offene @-Referenz unmittelbar vor der Cursorposition.
 * Leerraum zwischen „@“ und Cursor beendet die Referenz (dann null).
 * @returns {{ start: number, query: string } | null} start = Index des „@“
 */
export function findMentionQuery(text, caret) {
  if (typeof text !== 'string') return null;
  const pos = Math.max(0, Math.min(Number.isFinite(caret) ? caret : text.length, text.length));
  const before = text.slice(0, pos);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !MENTION_LEAD_IN.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

function basenameOf(relPath) {
  const slash = relPath.lastIndexOf('/');
  return slash >= 0 ? relPath.slice(slash + 1) : relPath;
}

function isSubsequence(needle, haystack) {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Bewertet einen Pfad gegen die (kleingeschriebene) Anfrage; null = kein Treffer.
 * Reihenfolge: Dateiname beginnt mit Anfrage > Pfad beginnt mit Anfrage >
 * Dateiname enthält Anfrage > Pfad enthält Anfrage > Buchstaben in Reihenfolge.
 */
function scoreMention(relPath, query) {
  const lowerPath = relPath.toLowerCase();
  const lowerName = basenameOf(lowerPath);
  if (lowerName.startsWith(query)) return 400;
  if (lowerPath.startsWith(query)) return 300;
  if (lowerName.includes(query)) return 200;
  if (lowerPath.includes(query)) return 100;
  if (isSubsequence(query, lowerPath)) return 10;
  return null;
}

/**
 * Filtert und sortiert die Einträge zur Anfrage. Ohne Anfrage bleibt die
 * gelieferte Reihenfolge erhalten (Breitensuche: Wurzel zuerst).
 */
export function filterMentionCandidates(entries, query, limit = 8) {
  const list = Array.isArray(entries) ? entries : [];
  const max = Math.max(0, Math.floor(limit));
  const q = (typeof query === 'string' ? query : '').toLowerCase();
  if (!q) return list.slice(0, max);

  const scored = [];
  for (const entry of list) {
    if (!entry || typeof entry.path !== 'string') continue;
    const score = scoreMention(entry.path, q);
    if (score === null) continue;
    scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.path.length - b.entry.path.length ||
      a.entry.path.localeCompare(b.entry.path)
  );
  return scored.slice(0, max).map((item) => item.entry);
}

/**
 * Ersetzt die offene Referenz (von start bis caret) durch „@pfad “.
 * Ordner werden als „@pfad/“ ohne Leerzeichen eingefügt, damit die Liste offen
 * bleibt und der Nutzer direkt in den Ordner weitertippen kann.
 * @returns {{ text: string, caret: number }}
 */
export function applyMention(text, start, caret, entry) {
  const source = typeof text === 'string' ? text : '';
  const from = Math.max(0, Math.min(start, source.length));
  let to = Math.max(from, Math.min(caret, source.length));
  const isDirectory = entry?.kind === 'directory';
  let insert = `@${entry?.path ?? ''}`;
  if (isDirectory) {
    insert += '/';
  } else {
    // Vorhandenes Leerzeichen hinter dem Cursor übernehmen statt ein zweites einzufügen.
    if (source[to] === ' ') to += 1;
    insert += ' ';
  }
  return {
    text: source.slice(0, from) + insert + source.slice(to),
    caret: from + insert.length,
  };
}
