/**
 * Hints for knowledge (#1277): a fact that reads like a rule or a procedure,
 * and an entry that reads like an episode. Nothing is refused for its kind —
 * telling the kinds apart needs the model and the user; these only point it
 * out, on the result of `remember`, on its card and in the knowledge panel
 * (#1279). English and German, like the users.
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
  /\b(?:you (?:should|must|have to)|make sure to|never|always)\b/i,
  /^(?:wenn|sobald|bevor|nachdem|immer|nie|niemals|bitte)\b/i,
  /\b(?:du (?:sollst|musst)|achte darauf)\b/i,
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
];

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
  if (!DECISION.test(value) && matches(value, EPISODE_SHAPE)) hints.push(KNOWLEDGE_HINTS.LOOKS_LIKE_EPISODE);
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
