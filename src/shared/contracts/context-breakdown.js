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

const { isLocalEndpoint } = require('./provider-endpoint');

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

const CONTEXT_PART_GROUP_LABEL_KEYS = Object.freeze({
  [CONTEXT_PART_GROUPS.SYSTEM]: 'context.group.system',
  [CONTEXT_PART_GROUPS.SKILLS]: 'context.group.skills',
  [CONTEXT_PART_GROUPS.TOOLS]: 'context.group.tools',
  [CONTEXT_PART_GROUPS.HISTORY]: 'context.group.history',
});

/**
 * Inhaltsarten mit unterschiedlicher Tokendichte.
 *
 * „1 Token ≈ 4 Zeichen" (chat-history-trim.js) gilt fuer Fliesstext. Ob ein
 * JSON-Schema dichter packt, haengt am Tokenizer — deshalb je Inhaltsart ein
 * eigener Teiler, und je Anbieter ein eigener Satz davon.
 */
const CONTEXT_CONTENT_KINDS = Object.freeze({
  PROSE: 'prose',
  MARKDOWN: 'markdown',
  JSON: 'json',
});

/**
 * Teiler je Inhaltsart, gebuendelt zu Profilen — ein Profil je Tokenizer.
 *
 * Der Teiler ist keine Konstante der Welt, sondern eine Eigenschaft des
 * Tokenizers am anderen Ende (Issue #178). Ein global gesetzter Wert ist
 * deshalb fuer alle ausser einem Anbieter falsch: Die 2,3 fuer JSON stammen
 * aus einer Messung gegen ein lokales Qwen-Modell (Issue #169) und uebertreiben
 * den Block „Tool-Definitionen" gegen o200k um rund 80 %. Weil die Schaetzungen
 * anschliessend auf die echte `promptTokens` skaliert werden, untertreibt
 * derselbe Fehler im selben Zug Verlauf und Skills — wer die Anzeige zum
 * Aufraeumen benutzt, raeumt dann an der falschen Stelle auf.
 *
 * Messverfahren fuer beide Profile: denselben Text einmal zaehlen
 * (`text.length`) und einmal durch den Tokenizer schicken, Quotient bilden.
 */
const CHARS_PER_TOKEN_PROFILES = Object.freeze({
  /**
   * Lokale Modelle (MLX-LM, Ollama), gemessen gegen Qwen am 2026-09-18
   * (Issue #169). Deutscher Fliesstext und Markdown liegen nahe an der
   * Faustregel, JSON packt der Tokenizer deutlich dichter.
   */
  local: Object.freeze({
    [CONTEXT_CONTENT_KINDS.PROSE]: 4,
    // Markdown traegt Auszeichnung und Code — dichter als Fliesstext, aber
    // weit entfernt von der Dichte eines JSON-Schemas.
    [CONTEXT_CONTENT_KINDS.MARKDOWN]: 3.4,
    [CONTEXT_CONTENT_KINDS.JSON]: 2.3,
  }),
  /**
   * o200k_base — der Tokenizer der aktuellen OpenAI-Modelle. Gemessen am
   * 2026-09-18 mit `gpt-tokenizer` (cjs/encoding/o200k_base) gegen den
   * tatsaechlichen Inhalt dieses Repos:
   *  - JSON: alle 17 eingebauten Tool-Schemas, 17.210 Zeichen / 4.154 Token
   *    = 4,14 (je Tool zwischen 3,91 und 4,59).
   *  - Markdown: `system-skills/snotra-capabilities/SKILL.md` 3,77,
   *    `docs/security-concept.md` 3,98, `README.md` 3,91.
   *  - Prosa: der Tool-System-Prompt der Registry, 2.257 / 556 = 4,06.
   * Fuer JSON ist der konservativere (kleinere) Randwert der Messreihe
   * genommen, damit die teuerste Gruppe eher zu teuer als zu billig aussieht.
   */
  o200k: Object.freeze({
    [CONTEXT_CONTENT_KINDS.PROSE]: 4,
    [CONTEXT_CONTENT_KINDS.MARKDOWN]: 3.8,
    [CONTEXT_CONTENT_KINDS.JSON]: 4.1,
  }),
});

/**
 * Ohne Messung kein eigenes Profil.
 *
 * Eingetragen ist nur, wogegen tatsaechlich gemessen wurde. Anthropic und
 * Google bleiben bewusst draussen: Ihre Tokenizer liegen hier nicht vor, und
 * eine geschaetzte Zahl waere derselbe Fehler wie der, den Issue #178
 * behebt — nur mit besserem Gewissen. Sie fallen auf `local` zurueck, das von
 * beiden Profilen das konservativere ist (kleinerer Teiler = mehr geschaetzte
 * Tokens). Wer ein Profil ergaenzt, misst vorher und schreibt Datum und
 * Verfahren wie oben dazu.
 */
const DEFAULT_CHARS_PER_TOKEN_PROFILE = 'local';

const CHARS_PER_TOKEN_PROFILE_BY_PROVIDER = Object.freeze({
  openai: 'o200k',
  ollama: 'local',
});

/** Rueckwaertskompatibler Name fuer das Standardprofil. */
const CHARS_PER_TOKEN = CHARS_PER_TOKEN_PROFILES[DEFAULT_CHARS_PER_TOKEN_PROFILE];

/**
 * Profil eines Anbieters. Die Provider-ID ist der Normalfall; eine Server-URL,
 * die auf diesen Rechner zeigt, sticht sie (Issue #193).
 *
 * Grund: Seit es einen generischen Anbieter gibt, sagt die ID nicht mehr, was
 * am anderen Ende steht — dieselbe ID bedient LM Studio auf `localhost` und
 * ein Gateway im Netz. Zeigt sie auf diesen Rechner, laeuft dort ein lokal
 * geladenes Modell, und das ist genau der Fall, fuer den `local` gemessen ist.
 *
 * Fuer einen **entfernten** OpenAI-kompatiblen Endpunkt gibt es bewusst kein
 * eigenes Profil: Dahinter kann alles stecken, von einem OpenAI-Gateway bis zu
 * Llama bei einem Router. Ohne Messung bleibt es beim konservativeren
 * Standardprofil — dieselbe Regel, die auch Anthropic und Google draussen haelt.
 */
function charsPerTokenProfile(providerId, { baseUrl } = {}) {
  if (isLocalEndpoint(baseUrl)) return CHARS_PER_TOKEN_PROFILES.local;
  const key =
    (typeof providerId === 'string' && CHARS_PER_TOKEN_PROFILE_BY_PROVIDER[providerId])
    || DEFAULT_CHARS_PER_TOKEN_PROFILE;
  return CHARS_PER_TOKEN_PROFILES[key];
}

function isContentKind(value) {
  return Object.prototype.hasOwnProperty.call(CHARS_PER_TOKEN, value);
}

function charsPerToken(contentKind, providerId, options) {
  const profile = charsPerTokenProfile(providerId, options);
  return isContentKind(contentKind)
    ? profile[contentKind]
    : profile[CONTEXT_CONTENT_KINDS.PROSE];
}

function toCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/** Schaetzt Tokens aus einer Zeichenzahl. Mindestens 1, solange Zeichen da sind. */
function estimateTokensFromChars(chars, contentKind, providerId, options) {
  const count = toCount(chars);
  if (count === 0) return 0;
  return Math.max(1, Math.round(count / charsPerToken(contentKind, providerId, options)));
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * The second line of a row that names a file, as `detailKey` plus `params`
 * (#353). A file inside the open folder is written `<folder>/…`, and that
 * placeholder is a word — so it lives in the catalogue, not in the path.
 *
 * @param {string} shortPath  `.agents/memory.md` for a file in the folder,
 *   `~/.snotra/memory.md` for one outside it.
 */
function shortPathDetail(shortPath, { inFolder = false, truncated = false } = {}) {
  let detailKey;
  if (inFolder) detailKey = truncated ? 'context.detail.folderPathTruncated' : 'context.detail.folderPath';
  else detailKey = truncated ? 'context.detail.pathTruncated' : 'context.detail.path';
  return { detailKey, params: { path: text(shortPath) } };
}

/**
 * Ein Baustein des Prompts. `chars` ist die einzige Pflichtangabe der Engine —
 * alles Weitere ist Beschriftung fuer die Anzeige.
 */
function createContextPart({
  id,
  group,
  label,
  labelKey = '',
  detail = '',
  detailKey = '',
  params,
  chars = 0,
  contentKind = CONTEXT_CONTENT_KINDS.PROSE,
  skillName = '',
  count,
} = {}) {
  const part = {
    id: text(id) || text(label) || text(labelKey),
    group: CONTEXT_PART_GROUP_ORDER.includes(group) ? group : CONTEXT_PART_GROUPS.SYSTEM,
    label: text(label),
    detail: text(detail),
    chars: toCount(chars),
    contentKind: isContentKind(contentKind) ? contentKind : CONTEXT_CONTENT_KINDS.PROSE,
  };
  // A part whose heading comes from a contract carries the catalogue key
  // instead of a finished sentence; the panel translates it and falls back to
  // `label` for the producers that still hand over text (issue #293).
  if (labelKey) part.labelKey = text(labelKey);
  // The same for the second line of a row: a key plus the values that fill it,
  // so that "3 schemas" is counted here and worded where it is shown (#290).
  if (detailKey) part.detailKey = text(detailKey);
  if (params && typeof params === 'object' && Object.keys(params).length > 0) part.params = { ...params };
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
 *
 * `providerId` — und bei einem generischen Anbieter die Server-URL — waehlt das
 * Teiler-Profil (Issue #178, #193). Auf die Gesamtzahl hat
 * es keinen Einfluss — solange skaliert wird, verschiebt ein anderes Profil
 * nur die Gewichte zwischen den Zeilen. Genau darum geht es: Bisher bekam der
 * Block „Tool-Definitionen" bei OpenAI rund 80 % zu viel Gewicht, und Verlauf
 * und Skills entsprechend zu wenig.
 */
function createContextBreakdown({ parts = [], promptTokens = 0, providerId = '', baseUrl = '' } = {}) {
  const usable = (Array.isArray(parts) ? parts : [])
    .map((part) => createContextPart(part))
    .filter((part) => part.chars > 0);

  const estimated = usable.map((part) => ({
    ...part,
    tokens: estimateTokensFromChars(part.chars, part.contentKind, providerId, { baseUrl }),
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
      labelKey: CONTEXT_PART_GROUP_LABEL_KEYS[group],
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
  CONTEXT_PART_GROUP_LABEL_KEYS,
  CONTEXT_CONTENT_KINDS,
  CHARS_PER_TOKEN,
  CHARS_PER_TOKEN_PROFILES,
  CHARS_PER_TOKEN_PROFILE_BY_PROVIDER,
  DEFAULT_CHARS_PER_TOKEN_PROFILE,
  charsPerTokenProfile,
  estimateTokensFromChars,
  createContextPart,
  shortPathDetail,
  createContextBreakdown,
  normalizeContextBreakdown,
  groupContextParts,
};
