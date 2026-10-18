/**
 * The reasoning level of a chat (#725).
 *
 * The level belongs to the chat, like its model and its mode (#211). A
 * provider says which levels it knows and which of its models take one:
 *
 *   reasoning: { levels: [...], defaultLevel: 'medium', appliesTo: (model) => boolean }
 *
 * `levels` and `defaultLevel` may also be functions of the model, for a
 * provider whose models differ in the levels they take (#994).
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
  if (!reasoning) return [];
  if (typeof reasoning.appliesTo === 'function' && !reasoning.appliesTo(model)) return [];
  const levels = typeof reasoning.levels === 'function' ? reasoning.levels(model) : reasoning.levels;
  if (!Array.isArray(levels)) return [];
  return levels.filter((level) => normalizeReasoningLevel(level) === level);
}

/** The level `model` runs with when the chat has chosen none. */
function reasoningDefaultFor(provider, model) {
  const raw = provider?.reasoning?.defaultLevel;
  const level = typeof raw === 'function' ? raw(model) : raw;
  return normalizeReasoningLevel(level) || DEFAULT_REASONING_LEVEL;
}

/**
 * The level a round runs with: the chat's own, else the provider's default —
 * the first that the model takes. Entries carry none since #726. `undefined`
 * when the model takes no level.
 */
function resolveReasoningLevel({ levels, own, defaultLevel }) {
  if (!Array.isArray(levels) || levels.length === 0) return undefined;
  return [own, defaultLevel, DEFAULT_REASONING_LEVEL]
    .find((level) => typeof level === 'string' && levels.includes(level))
    ?? levels[0];
}

module.exports = {
  DEFAULT_REASONING_LEVEL,
  normalizeReasoningLevel,
  reasoningDefaultFor,
  reasoningLevelsFor,
  resolveReasoningLevel,
};
