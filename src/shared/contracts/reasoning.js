/**
 * The reasoning level of a chat (#725).
 *
 * The level belongs to the chat, like its model and its mode (#211). A
 * provider says which levels it knows and which of its models take one:
 *
 *   reasoning: { levels: [...], defaultLevel: 'medium', appliesTo: (model) => boolean }
 *
 * A model that takes none gets no level, whatever the chat has stored — the
 * chat keeps it for the next model that does.
 */
'use strict';

const DEFAULT_REASONING_LEVEL = 'medium';

/** A level as the history and the IPC take it: a short lower-case word. */
function normalizeReasoningLevel(raw) {
  if (typeof raw !== 'string') return undefined;
  const level = raw.trim();
  return /^[a-z]{1,16}$/.test(level) ? level : undefined;
}

/** The levels `model` takes with this provider; empty when it takes none. */
function reasoningLevelsFor(provider, model) {
  const reasoning = provider?.reasoning;
  if (!reasoning || !Array.isArray(reasoning.levels)) return [];
  if (typeof reasoning.appliesTo === 'function' && !reasoning.appliesTo(model)) return [];
  return reasoning.levels.filter((level) => normalizeReasoningLevel(level) === level);
}

/**
 * The level a round runs with: the chat's own, else the entry's, else the
 * provider's default — the first that the model takes. The entry's level only
 * bridges the time until entries carry none (#726). `undefined` when the model
 * takes no level.
 */
function resolveReasoningLevel({ levels, own, fromEntry, defaultLevel }) {
  if (!Array.isArray(levels) || levels.length === 0) return undefined;
  return [own, fromEntry, defaultLevel, DEFAULT_REASONING_LEVEL]
    .find((level) => typeof level === 'string' && levels.includes(level))
    ?? levels[0];
}

module.exports = {
  DEFAULT_REASONING_LEVEL,
  normalizeReasoningLevel,
  reasoningLevelsFor,
  resolveReasoningLevel,
};
