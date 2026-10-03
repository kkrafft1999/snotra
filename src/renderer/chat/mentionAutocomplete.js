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
  return rankMentionCandidates(entries, query).slice(0, Math.max(0, Math.floor(limit)));
}

/**
 * Every match in the order of `filterMentionCandidates`, without the cut. The
 * tree's filter (#350) shows more than the eight of the `@` menu and says how
 * many there are; both read the same ranking, so both find the same files.
 */
export function rankMentionCandidates(entries, query) {
  const list = Array.isArray(entries) ? entries : [];
  const q = (typeof query === 'string' ? query : '').toLowerCase();
  if (!q) return list.slice();

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
  return scored.map((item) => item.entry);
}

/**
 * Which characters of a path the query matched (#350), as `[start, end)`
 * ranges over the whole path — the same tiers as the ranking, so what lights
 * up is what put the entry there: the name's prefix or occurrence, the
 * path's, or the letters one by one. Empty when nothing matches.
 */
export function mentionMatchRanges(relPath, query) {
  if (typeof relPath !== 'string' || typeof query !== 'string' || !query) return [];
  const q = query.toLowerCase();
  const lowerPath = relPath.toLowerCase();
  const nameStart = lowerPath.lastIndexOf('/') + 1;
  const lowerName = lowerPath.slice(nameStart);
  if (lowerName.startsWith(q)) return [[nameStart, nameStart + q.length]];
  if (lowerPath.startsWith(q)) return [[0, q.length]];
  const inName = lowerName.indexOf(q);
  if (inName >= 0) return [[nameStart + inName, nameStart + inName + q.length]];
  const inPath = lowerPath.indexOf(q);
  if (inPath >= 0) return [[inPath, inPath + q.length]];

  // Letters in order: taken as late as possible, so they gather in the name
  // where they can rather than in the first folder that happens to have them.
  const positions = [];
  let j = lowerPath.length - 1;
  for (let i = q.length - 1; i >= 0; i -= 1) {
    while (j >= 0 && lowerPath[j] !== q[i]) j -= 1;
    if (j < 0) return [];
    positions.unshift(j);
    j -= 1;
  }
  const ranges = [];
  for (const pos of positions) {
    const last = ranges.at(-1);
    if (last && last[1] === pos) last[1] = pos + 1;
    else ranges.push([pos, pos + 1]);
  }
  return ranges;
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

/**
 * Fügt eine Referenz an der Cursorposition ein, ohne dass eine offene
 * @-Abfrage im Text steht (Issue #56: Drag & Drop aus dem Baum, @-Knopf in der
 * Zeile). Steht direkt vor dem Cursor ein Zeichen, das kein „@“ einleiten darf,
 * kommt ein Leerzeichen davor — sonst wäre die Referenz für findMentionQuery
 * und für das Modell keine.
 *
 * Eingefügt wird über applyMention, damit beide Wege dieselbe Schreibweise
 * erzeugen (Ordner mit „/“, Dateien mit Leerzeichen dahinter).
 * @returns {{ text: string, caret: number }}
 */
export function insertReferenceAt(text, caret, entry) {
  const source = typeof text === 'string' ? text : '';
  const pos = Math.max(0, Math.min(Number.isFinite(caret) ? caret : source.length, source.length));
  const needsLeadIn = pos > 0 && !MENTION_LEAD_IN.test(source[pos - 1]);
  const prepared = needsLeadIn ? `${source.slice(0, pos)} ${source.slice(pos)}` : source;
  const start = needsLeadIn ? pos + 1 : pos;
  return applyMention(prepared, start, start, entry);
}
