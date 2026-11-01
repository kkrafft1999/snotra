/**
 * Hints for knowledge (#1277): a fact that reads like a rule or a procedure,
 * and an entry that reads like an episode. Nothing is refused for its kind —
 * telling the kinds apart needs the model and the user; these only point it
 * out, on the result of `remember`, on its card and in the knowledge panel
 * (#1279). The word lists cover every language Snotra has a catalogue for —
 * English and German —, not only the interface language: an entry may be
 * written in another one. A third catalogue brings its own lines here.
 *
 * Deliberately cautious: a hint that is wrong teaches people to skip it. A
 * reason ("because …") does not make an entry an episode, nor does a decision
 * written in the past tense — its consequence lasts.
 *
 * CommonJS, so that main and renderer share it.
 */
'use strict';

const KNOWLEDGE_HINTS = Object.freeze({
  FACT_LOOKS_LIKE_RULE: 'factLooksLikeRule',
  FACT_LOOKS_LIKE_PROCEDURE: 'factLooksLikeProcedure',
  LOOKS_LIKE_EPISODE: 'looksLikeEpisode',
});

/** A condition or an order: what a rule is made of. */
const RULE_SHAPE = [
  /^(?:when|whenever|if|before|after|always|never|don't|do not|please)\b/i,
  /\b(?:you (?:should|must|have to)|make sure to|never|always|whenever|must(?:n't| not)?)\b/i,
  /^(?:wenn|sobald|bevor|nachdem|immer|nie|niemals|bitte)\b/i,
  /\b(?:du (?:sollst|musst)|achte darauf|immer wenn|jedes mal,? wenn|muss|müssen|darf nicht|dürfen nicht)\b/i,
  // Like "always" and "never" anywhere in an English entry — but not "wie immer",
  // "für immer", "immer noch", "immer mehr", "immer wieder", which state no rule.
  /(?<!\b(?:wie|für) )\b(?:immer(?! noch\b| mehr\b| wieder\b)|nie|niemals)\b/i,
];

/** Steps: numbered lines, or "first … then …". */
const PROCEDURE_SHAPE = [
  /(?:^|\n)\s*1[.)]\s[\s\S]*(?:^|\n)\s*2[.)]\s/m,
  /\bfirst\b[^.]{0,120}\bthen\b[^.]{0,120}\b(?:then|finally)\b/i,
  /\b(?:zuerst|erst)\b[^.]{0,120}\bdann\b[^.]{0,120}\b(?:dann|zum schluss|schließlich)\b/i,
];

/** Only true now, or once: today, the failing test, the next step. */
const EPISODE_SHAPE = [
  /\b(?:today|yesterday|this morning|tonight|right now|just now|at the moment|currently)\b/i,
  /\b(?:is|are) (?:failing|broken|red)\b/i,
  /\bnext,? we\b|\b(?:tomorrow|later today) we\b/i,
  /\b(?:heute|gestern|heute morgen|gerade eben|im moment|momentan)\b/i,
  /\b(?:schlägt|schlagen) (?:gerade )?fehl\b|\bist (?:gerade )?rot\b/i,
  /\bals nächstes\b|\bmorgen (?:machen|nehmen|bauen) wir\b/i,
  /\bnext (?:step|week)\b|\b(?:last|this) week\b|\blast night\b/i,
  /\bnächste(?:r|n)? (?:schritt|woche)\b|\b(?:letzte|diese) woche\b|\bvorhin\b/i,
];

/**
 * Something that happened once, told in the past tense: "we merged …",
 * "wir haben … repariert". Only without a reason — "we moved to pnpm because
 * npm was slow" keeps its consequence.
 */
const EVENT_SHAPE = [
  /\b(?:we|i) (?:just )?(?:fixed|merged|released|deployed|shipped|found|added|removed|changed|updated|tried|ran|moved|renamed|installed|upgraded|migrated|discussed|talked about|met)\b/i,
  /\b(?:(?:haben|hab|habe) (?:wir|ich)|(?:wir|ich) (?:haben|habe|hab))\b[^.]{0,80}\b(?:repariert|behoben|gemergt|veröffentlicht|deployt|gefunden|hinzugefügt|entfernt|geändert|aktualisiert|ausprobiert|probiert|verschoben|umbenannt|installiert|migriert|besprochen)\b/i,
];

/** A reason: what follows from it lasts. */
const REASON = /\b(?:because|since|so that|weil|denn|damit|da)\b/i;

/** A decision lasts, even in the past tense. */
const DECISION = /\b(?:decided|agreed|chose|entschieden|vereinbart|beschlossen)\b/i;

/** @param {string} text @param {RegExp[]} shapes */
const matches = (text, shapes) => shapes.some((shape) => shape.test(text));

/**
 * The hints an entry earns.
 *
 * @param {{ kind?: unknown, text?: unknown }} entry
 * @returns {string[]}  values of KNOWLEDGE_HINTS
 */
function knowledgeHints({ kind, text }) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return [];
  const hints = [];
  if (kind === 'fact' || kind === undefined) {
    if (matches(value, PROCEDURE_SHAPE)) hints.push(KNOWLEDGE_HINTS.FACT_LOOKS_LIKE_PROCEDURE);
    else if (matches(value, RULE_SHAPE)) hints.push(KNOWLEDGE_HINTS.FACT_LOOKS_LIKE_RULE);
  }
  const event = !REASON.test(value) && matches(value, EVENT_SHAPE);
  if (!DECISION.test(value) && (event || matches(value, EPISODE_SHAPE))) hints.push(KNOWLEDGE_HINTS.LOOKS_LIKE_EPISODE);
  return hints;
}

/**
 * The hints as the model reads them in the tool result — English, like every
 * sentence to the model.
 *
 * @type {Readonly<Record<string, string>>}
 */
const KNOWLEDGE_HINT_SENTENCES = Object.freeze({
  [KNOWLEDGE_HINTS.FACT_LOOKS_LIKE_RULE]:
    'This fact reads like a rule — something that can be followed or broken. If it is one, store it with kind "rule" and replaces.',
  [KNOWLEDGE_HINTS.FACT_LOOKS_LIKE_PROCEDURE]:
    'This fact reads like a procedure of several steps. If it is one, store it with kind "instruction" (a skill) and replaces.',
  [KNOWLEDGE_HINTS.LOOKS_LIKE_EPISODE]:
    'This reads like an episode — only true now, or something that happened once. The chats keep episodes; a chat can be distilled into lasting knowledge later.',
});

module.exports = {
  KNOWLEDGE_HINTS,
  KNOWLEDGE_HINT_SENTENCES,
  knowledgeHints,
};
