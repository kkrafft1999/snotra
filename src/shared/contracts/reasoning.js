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
 *
 * Where the capability register leaves reasoning levels to the connection
 * (`supported: 'per-connection'`, an OpenAI-compatible entry, #1148), an
 * entry whose switch is off offers none either.
 */
'use strict';

const { PER_CONNECTION } = require('./provider-capabilities');

const DEFAULT_REASONING_LEVEL = 'medium';

/**
 * What a provider declares about reasoning — the part of `ProviderAdapter`
 * this file reads.
 *
 * @typedef {Object} ReasoningDeclaration
 * @property {readonly string[] | ((model: string) => readonly string[])} [levels]
 * @property {string | ((model: string) => string)} [defaultLevel]
 * @property {(model: string) => boolean} [appliesTo]
 *
 * @typedef {{ reasoning?: ReasoningDeclaration,
 *   capabilities?: { reasoningLevels?: { supported?: boolean|string, setting?: string } } }} ReasoningProvider
 */

/**
 * A level as the history and the IPC take it: a short lower-case word.
 * @param {unknown} raw
 * @returns {string | undefined}
 */
function normalizeReasoningLevel(raw) {
  if (typeof raw !== 'string') return undefined;
  const level = raw.trim();
  return /^[a-z]{1,16}$/.test(level) ? level : undefined;
}

/**
 * Whether the entry's connection lets the levels through: always, unless the
 * provider leaves them to a connection setting that is not switched on.
 * @param {ReasoningProvider | null | undefined} provider
 * @param {Record<string, unknown> | null | undefined} connection
 */
function connectionTakesLevels(provider, connection) {
  const declared = provider?.capabilities?.reasoningLevels;
  if (declared?.supported !== PER_CONNECTION) return true;
  return typeof declared.setting === 'string' && connection?.[declared.setting] === true;
}

/**
 * The levels `model` takes with this provider over this connection; empty
 * when it takes none.
 * @param {ReasoningProvider | null | undefined} provider
 * @param {string} model
 * @param {Record<string, unknown> | null} [connection]  the entry's connection settings
 * @returns {string[]}
 */
function reasoningLevelsFor(provider, model, connection) {
  const reasoning = provider?.reasoning;
  if (!reasoning) return [];
  if (!connectionTakesLevels(provider, connection)) return [];
  if (typeof reasoning.appliesTo === 'function' && !reasoning.appliesTo(model)) return [];
  const levels = typeof reasoning.levels === 'function' ? reasoning.levels(model) : reasoning.levels;
  if (!Array.isArray(levels)) return [];
  return levels.filter((level) => normalizeReasoningLevel(level) === level);
}

/**
 * The level `model` runs with when the chat has chosen none.
 * @param {{ reasoning?: ReasoningDeclaration } | null | undefined} provider
 * @param {string} model
 * @returns {string}
 */
function reasoningDefaultFor(provider, model) {
  const raw = provider?.reasoning?.defaultLevel;
  const level = typeof raw === 'function' ? raw(model) : raw;
  return normalizeReasoningLevel(level) || DEFAULT_REASONING_LEVEL;
}

/**
 * The level a round runs with: the chat's own, else the provider's default —
 * the first that the model takes. Entries carry none since #726. `undefined`
 * when the model takes no level.
 *
 * @param {{ levels: readonly string[] | null | undefined, own?: unknown, defaultLevel?: unknown }} params
 * @returns {string | undefined}
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
