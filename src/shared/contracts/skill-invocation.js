/**
 * Aufruf eines Skills per `/name` im Chat (Issue #124, Teil von #89).
 *
 * Dies ist ein Vertrag zwischen zwei Seiten: Der Renderer *schreibt* `/name`
 * beim Auswählen aus der Vervollständigung in die Nachricht, der Main *liest*
 * es beim Zusammenbauen des Systemprompts wieder heraus. Beide müssen
 * dieselbe Regel anwenden, deshalb steht sie hier und nicht in einer der
 * beiden Schichten.
 *
 * Bewusst kein zusätzliches Payload-Feld: Der Aufruf bleibt als Text in der
 * Nachricht stehen. Damit ist er für den Nutzer sichtbar, übersteht das
 * Speichern und Neuladen eines Chats und gilt ohne weiteres Zutun für den
 * gesamten Verlauf — ein einmal aufgerufener Skill wirkt also auch in den
 * Folgeantworten.
 *
 * CommonJS, damit Main (require) und der Renderer (generiertes ESM-Bundle)
 * dieselben Werte sehen.
 */
'use strict';

const { isValidSkillName } = require('./skills');

// Ein „/“ zählt nur am Textanfang oder nach Leerraum bzw. einer öffnenden
// Klammer/einem Anführungszeichen — analog zur @-Referenz (Issue #52).
const INVOCATION_LEAD_IN = /[\s(["'`„‚«‹]/;

// Zeichen, die in einem Skill-Namen vorkommen dürfen (siehe isValidSkillName).
// Alles andere beendet die Referenz — so bleibt „/usr/bin“ normaler Text,
// weil der Schrägstrich hinter „usr“ nicht mehr zum Namen gehört.
const NAME_CHAR = /[A-Za-z0-9._-]/;

function isLeadIn(text, index) {
  return index === 0 || INVOCATION_LEAD_IN.test(text[index - 1]);
}

/**
 * Sucht den noch offenen `/`-Aufruf unmittelbar vor der Cursorposition.
 * Ein Zeichen, das nicht in einen Skill-Namen gehört, beendet ihn (dann null).
 * @returns {{ start: number, query: string } | null} start = Index des „/“
 */
function findSkillQuery(text, caret) {
  if (typeof text !== 'string') return null;
  const pos = Math.max(0, Math.min(Number.isFinite(caret) ? caret : text.length, text.length));
  const before = text.slice(0, pos);
  const slash = before.lastIndexOf('/');
  if (slash < 0) return null;
  if (!isLeadIn(before, slash)) return null;
  const query = before.slice(slash + 1);
  for (const char of query) {
    if (!NAME_CHAR.test(char)) return null;
  }
  return { start: slash, query };
}

/**
 * Alle per `/name` aufgerufenen Skills eines Textes, in Reihenfolge des
 * Auftretens und ohne Dopplungen. Geprüft wird nur die Form des Namens — ob
 * ein Skill dieses Namens existiert und aufrufbar ist, entscheidet die
 * Registry.
 * @returns {string[]}
 */
function extractInvokedSkillNames(text) {
  if (typeof text !== 'string' || !text) return [];
  const names = [];
  const seen = new Set();
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '/' || !isLeadIn(text, i)) continue;
    let end = i + 1;
    while (end < text.length && NAME_CHAR.test(text[end])) end += 1;
    const name = text.slice(i + 1, end);
    // Weiter hinter dem Namen, nicht hinter dem „/“ — „/a/b“ soll nicht in
    // einem zweiten Durchlauf noch „b“ liefern.
    i = end - 1;
    if (end < text.length && text[end] === '/') continue; // Pfad, kein Aufruf
    if (!isValidSkillName(name) || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function isSubsequence(needle, haystack) {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Ab dieser Länge zählt auch ein Treffer in der Beschreibung. Kürzere
 * Anfragen kommen in jedem zweiten Beschreibungstext vor und würden die auf
 * acht Zeilen begrenzte Liste mit Rauschen füllen.
 */
const MIN_DESCRIPTION_QUERY_LENGTH = 3;

/**
 * Trifft die Anfrage den Anfang eines Wortes der Beschreibung?
 *
 * Nur Wortanfänge, nicht irgendein Teilstück: „/rel“ soll `release` finden,
 * aber nicht jeden Skill, in dessen Beschreibung „korrelieren“ steht.
 */
function matchesDescription(description, query) {
  if (query.length < MIN_DESCRIPTION_QUERY_LENGTH) return false;
  let from = 0;
  for (;;) {
    const at = description.indexOf(query, from);
    if (at < 0) return false;
    if (at === 0 || !NAME_CHAR.test(description[at - 1])) return true;
    from = at + 1;
  }
}

/**
 * Bewertet einen Skill gegen die (kleingeschriebene) Anfrage; null = kein
 * Treffer. Der Name wiegt schwerer als die Beschreibung: Wer tippt, meint in
 * aller Regel den Namen — die Beschreibung hilft nur beim Wiederfinden.
 */
function scoreSkill(skill, query) {
  const name = String(skill.name || '').toLowerCase();
  const description = String(skill.description || '').toLowerCase();
  if (name.startsWith(query)) return 400;
  if (name.includes(query)) return 300;
  if (matchesDescription(description, query)) return 200;
  if (isSubsequence(query, name)) return 100;
  return null;
}

/**
 * Filtert und sortiert die Skills zur Anfrage. Ohne Anfrage bleibt die
 * gelieferte Reihenfolge erhalten (Quellpriorität).
 */
function filterSkillCandidates(skills, query, limit = 8) {
  const list = Array.isArray(skills) ? skills : [];
  const max = Math.max(0, Math.floor(limit));
  const q = (typeof query === 'string' ? query : '').toLowerCase();
  if (!q) return list.slice(0, max);

  const scored = [];
  for (const skill of list) {
    if (!skill || typeof skill.name !== 'string') continue;
    const score = scoreSkill(skill, q);
    if (score === null) continue;
    scored.push({ skill, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.skill.name.length - b.skill.name.length ||
      a.skill.name.localeCompare(b.skill.name)
  );
  return scored.slice(0, max).map((item) => item.skill);
}

/**
 * Ersetzt den offenen Aufruf (von start bis caret) durch „/name “.
 * @returns {{ text: string, caret: number }}
 */
function applySkillInvocation(text, start, caret, skill) {
  const source = typeof text === 'string' ? text : '';
  const from = Math.max(0, Math.min(start, source.length));
  let to = Math.max(from, Math.min(caret, source.length));
  // Vorhandenes Leerzeichen hinter dem Cursor übernehmen statt ein zweites
  // einzufügen (wie bei der @-Referenz).
  if (source[to] === ' ') to += 1;
  const insert = `/${skill?.name ?? ''} `;
  return {
    text: source.slice(0, from) + insert + source.slice(to),
    caret: from + insert.length,
  };
}

module.exports = {
  findSkillQuery,
  extractInvokedSkillNames,
  filterSkillCandidates,
  applySkillInvocation,
};
