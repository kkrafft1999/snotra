/**
 * Aufschlüsselung des Kontextfensters (Issue #174).
 *
 * Die Anbieter liefern zur Groesse des Prompts nur eine einzige Zahl
 * (`usage.prompt_tokens`) und keine Aufteilung. Woraus der Prompt besteht —
 * welcher Skill, welches Tool-Schema, wie viel Verlauf — weiss deshalb nur die
 * Engine, die ihn zusammengesetzt hat. Sie zaehlt die Zeichen ihrer Bausteine
 * und legt sie hier als DTO ab; die Anzeige rechnet daraus Anteile.
 *
 * Zwei Sorten Zahlen, die nie vermischt werden duerfen:
 *  - `promptTokens` ist die **echte** Zahl des Anbieters.
 *  - `tokens` je Zeile ist eine **Schaetzung** aus der Zeichenzahl.
 * Die Schaetzungen werden auf die echte Summe skaliert, damit die Anteile zu
 * 100 % aufgehen; die Anzeige kennzeichnet sie trotzdem als Schaetzung.
 *
 * CommonJS, damit Main (require) und Renderer (generiertes ESM-Bundle)
 * dieselbe Rechnung benutzen.
 */
'use strict';

const CONTEXT_BREAKDOWN_VERSION = 1;

/** Grobe Blöcke des Prompts — die Anzeige gruppiert danach. */
const CONTEXT_PART_GROUPS = Object.freeze({
  SYSTEM: 'system',
  SKILLS: 'skills',
  TOOLS: 'tools',
  HISTORY: 'history',
});

const CONTEXT_PART_GROUP_ORDER = Object.freeze([
  CONTEXT_PART_GROUPS.SYSTEM,
  CONTEXT_PART_GROUPS.SKILLS,
  CONTEXT_PART_GROUPS.TOOLS,
  CONTEXT_PART_GROUPS.HISTORY,
]);

const CONTEXT_PART_GROUP_LABELS = Object.freeze({
  [CONTEXT_PART_GROUPS.SYSTEM]: 'System-Prompt',
  [CONTEXT_PART_GROUPS.SKILLS]: 'Skills',
  [CONTEXT_PART_GROUPS.TOOLS]: 'Tool-Definitionen',
  [CONTEXT_PART_GROUPS.HISTORY]: 'Verlauf',
});

/**
 * Inhaltsarten mit unterschiedlicher Tokendichte.
 *
 * „1 Token ≈ 4 Zeichen" (chat-history-trim.js) gilt fuer Fliesstext. Fuer
 * JSON-Tool-Schemas ist sie um Faktor zwei zu optimistisch: gemessen am
 * 2026-09-18 waren es 2,28 Zeichen je Token (Issue #169). Eine Anzeige, die
 * zum Abschalten verleiten soll, darf Tools nicht halb so teuer aussehen
 * lassen, wie sie sind — deshalb je Inhaltsart ein eigener Teiler.
 */
const CONTEXT_CONTENT_KINDS = Object.freeze({
  PROSE: 'prose',
  MARKDOWN: 'markdown',
  JSON: 'json',
});

const CHARS_PER_TOKEN = Object.freeze({
  [CONTEXT_CONTENT_KINDS.PROSE]: 4,
  // Markdown traegt Auszeichnung und Code — dichter als Fliesstext, aber
  // weit entfernt von der Dichte eines JSON-Schemas.
  [CONTEXT_CONTENT_KINDS.MARKDOWN]: 3.4,
  [CONTEXT_CONTENT_KINDS.JSON]: 2.3,
});

function isContentKind(value) {
  return Object.prototype.hasOwnProperty.call(CHARS_PER_TOKEN, value);
}

function charsPerToken(contentKind) {
  return isContentKind(contentKind)
    ? CHARS_PER_TOKEN[contentKind]
    : CHARS_PER_TOKEN[CONTEXT_CONTENT_KINDS.PROSE];
}

function toCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/** Schaetzt Tokens aus einer Zeichenzahl. Mindestens 1, solange Zeichen da sind. */
function estimateTokensFromChars(chars, contentKind) {
  const count = toCount(chars);
  if (count === 0) return 0;
  return Math.max(1, Math.round(count / charsPerToken(contentKind)));
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Ein Baustein des Prompts. `chars` ist die einzige Pflichtangabe der Engine —
 * alles Weitere ist Beschriftung fuer die Anzeige.
 */
function createContextPart({
  id,
  group,
  label,
  detail = '',
  chars = 0,
  contentKind = CONTEXT_CONTENT_KINDS.PROSE,
  skillName = '',
  count,
} = {}) {
  const part = {
    id: text(id) || text(label),
    group: CONTEXT_PART_GROUP_ORDER.includes(group) ? group : CONTEXT_PART_GROUPS.SYSTEM,
    label: text(label),
    detail: text(detail),
    chars: toCount(chars),
    contentKind: isContentKind(contentKind) ? contentKind : CONTEXT_CONTENT_KINDS.PROSE,
  };
  if (skillName) part.skillName = text(skillName);
  if (Number.isFinite(count)) part.count = toCount(count);
  return part;
}

/**
 * Verteilt die echte Gesamtzahl auf die Bausteine.
 *
 * Ohne echte Zahl (`promptTokens === 0`, etwa bei einem Anbieter ohne Usage)
 * bleiben die rohen Schaetzungen stehen; `scaled` sagt der Anzeige, welcher
 * Fall vorliegt. Der Rundungsrest landet beim groessten Posten, damit die
 * Summe der Zeilen exakt der angezeigten Gesamtzahl entspricht.
 */
function createContextBreakdown({ parts = [], promptTokens = 0 } = {}) {
  const usable = (Array.isArray(parts) ? parts : [])
    .map((part) => createContextPart(part))
    .filter((part) => part.chars > 0);

  const estimated = usable.map((part) => ({
    ...part,
    tokens: estimateTokensFromChars(part.chars, part.contentKind),
  }));
  const estimatedTotal = estimated.reduce((sum, part) => sum + part.tokens, 0);
  const real = toCount(promptTokens);
  const scaled = real > 0 && estimatedTotal > 0;

  let rows = estimated;
  if (scaled) {
    const factor = real / estimatedTotal;
    // Mindestens 1 Token je Zeile: Ein Baustein, der im Prompt steht, kostet
    // etwas. Ohne die Untergrenze verschwaenden ganze Skills aus der Liste,
    // sobald ein Anbieter eine sehr kleine Gesamtzahl meldet — und dann fehlt
    // genau die Zeile, wegen der jemand hinsieht.
    rows = estimated.map((part) => ({
      ...part,
      tokens: Math.max(1, Math.round(part.tokens * factor)),
    }));
    const drift = real - rows.reduce((sum, part) => sum + part.tokens, 0);
    if (drift !== 0 && rows.length > 0) {
      let biggest = 0;
      for (let i = 1; i < rows.length; i += 1) {
        if (rows[i].tokens > rows[biggest].tokens) biggest = i;
      }
      rows[biggest] = { ...rows[biggest], tokens: Math.max(0, rows[biggest].tokens + drift) };
    }
  }

  const total = scaled ? real : estimatedTotal;
  return {
    version: CONTEXT_BREAKDOWN_VERSION,
    promptTokens: real,
    estimatedTokens: estimatedTotal,
    scaled,
    total,
    parts: rows.map((part) => ({
      ...part,
      share: total > 0 ? part.tokens / total : 0,
    })),
  };
}

/**
 * Defensive Annahme im Renderer: Der Wert kommt ueber IPC und wird wie jede
 * fremde Eingabe geprueft, statt ihm zu glauben.
 */
function normalizeContextBreakdown(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const parts = Array.isArray(raw.parts) ? raw.parts : [];
  if (parts.length === 0) return null;
  const promptTokens = toCount(raw.promptTokens);
  const estimatedTokens = toCount(raw.estimatedTokens);
  const scaled = raw.scaled === true && promptTokens > 0;
  const total = scaled ? promptTokens : estimatedTokens;
  const rows = parts
    .map((part) => {
      const normalized = createContextPart(part);
      const tokens = toCount(part?.tokens);
      if (tokens === 0) return null;
      return { ...normalized, tokens, share: total > 0 ? tokens / total : 0 };
    })
    .filter(Boolean);
  if (rows.length === 0) return null;
  return {
    version: CONTEXT_BREAKDOWN_VERSION,
    promptTokens,
    estimatedTokens,
    scaled,
    total,
    parts: rows,
  };
}

/**
 * Anzeige-Reihenfolge: Gruppen in fester Folge, innerhalb einer Gruppe der
 * teuerste Posten zuerst — die Frage lautet „was kostet am meisten", nicht
 * „was kam zuerst". Gruppen ohne Zeilen fallen weg.
 */
function groupContextParts(breakdown) {
  const parts = Array.isArray(breakdown?.parts) ? breakdown.parts : [];
  return CONTEXT_PART_GROUP_ORDER.map((group) => {
    const rows = parts
      .filter((part) => part.group === group)
      .sort((a, b) => b.tokens - a.tokens);
    const tokens = rows.reduce((sum, part) => sum + part.tokens, 0);
    return {
      group,
      label: CONTEXT_PART_GROUP_LABELS[group],
      tokens,
      share: breakdown?.total > 0 ? tokens / breakdown.total : 0,
      parts: rows,
    };
  }).filter((entry) => entry.parts.length > 0);
}

module.exports = {
  CONTEXT_BREAKDOWN_VERSION,
  CONTEXT_PART_GROUPS,
  CONTEXT_PART_GROUP_ORDER,
  CONTEXT_PART_GROUP_LABELS,
  CONTEXT_CONTENT_KINDS,
  CHARS_PER_TOKEN,
  estimateTokensFromChars,
  createContextPart,
  createContextBreakdown,
  normalizeContextBreakdown,
  groupContextParts,
};
