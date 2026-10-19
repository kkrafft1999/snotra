/**
 * A flag on a tool result that looks like a prompt injection (#1011, AR-36).
 *
 * The flag is a warning for the user and nothing else: it travels with the
 * tool row to the chat and into the stored history, and it is never read by
 * anything that decides what a tool may do (docs/quality-requirements.md §3,
 * scenario SEC-4). What the model receives does not depend on it either.
 *
 * Each signal names what kind of text was found and quotes a short, cleaned
 * excerpt of it, so that the user can judge the hit without opening the tool
 * output. The source says who raised the flag: the built-in detector today,
 * a `PostToolUse` hook (#927) later.
 */
'use strict';

/** What a signal can be about; the renderer turns each into a sentence. */
const INJECTION_SIGNAL_KINDS = Object.freeze({
  // "Ignore all previous instructions", "disregard the system prompt".
  OVERRIDE: 'override',
  // A fake turn: chat-template tokens or a `system:` line that pose as the app.
  ROLE: 'role',
  // Orders aimed at the agent itself: "AI agents reading this must …".
  ADDRESSED: 'addressed',
  // Asks for secrets or the conversation to be sent somewhere.
  EXFILTRATE: 'exfiltrate',
  // Text the user cannot see: Unicode tag characters and similar.
  HIDDEN: 'hidden',
});

/** Who raised a flag. A hook source carries the hook's key after the colon. */
const INJECTION_FLAG_SOURCES = Object.freeze({
  BUILTIN: 'builtin',
  HOOK_PREFIX: 'hook:',
});

const INJECTION_FLAG_LIMITS = Object.freeze({
  // Signals per flag; one per kind is enough to tell the user what was found.
  SIGNALS: 5,
  // Characters of an excerpt as it is shown and stored.
  EXCERPT_CHARS: 160,
  SOURCES: 4,
  SOURCE_CHARS: 80,
});

/** @type {Set<string>} */
const KIND_VALUES = new Set(Object.values(INJECTION_SIGNAL_KINDS));

/**
 * @typedef {(typeof INJECTION_SIGNAL_KINDS)[keyof typeof INJECTION_SIGNAL_KINDS]} InjectionSignalKind
 *
 * @typedef {Object} InjectionSignal
 * @property {InjectionSignalKind} kind
 * @property {string} excerpt  the matched text, cleaned and cut; may be empty
 *
 * @typedef {Object} InjectionFlag
 * @property {InjectionSignal[]} signals  at least one
 * @property {string[]} sources           at least one, e.g. `builtin`
 */

/** @param {unknown} value */
function isInjectionSignalKind(value) {
  return typeof value === 'string' && KIND_VALUES.has(value);
}

/**
 * An excerpt as it may be shown: control and invisible characters replaced
 * by a space, whitespace runs folded, cut at the limit with an ellipsis.
 *
 * @param {unknown} value
 * @returns {string}
 */
function cleanInjectionExcerpt(value) {
  if (typeof value !== 'string') return '';
  const folded = value
    // Controls, zero-width and bidi characters, tag characters: nothing the
    // row should render as it came.
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁯﻿]|\udb40[\udc00-\udc7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const max = INJECTION_FLAG_LIMITS.EXCERPT_CHARS;
  if (folded.length <= max) return folded;
  return `${folded.slice(0, max - 1).trimEnd()}…`;
}

/** @param {unknown} value */
function isFlagSource(value) {
  if (typeof value !== 'string' || !value || value.length > INJECTION_FLAG_LIMITS.SOURCE_CHARS) return false;
  if (value === INJECTION_FLAG_SOURCES.BUILTIN) return true;
  return value.startsWith(INJECTION_FLAG_SOURCES.HOOK_PREFIX) && value.length > INJECTION_FLAG_SOURCES.HOOK_PREFIX.length;
}

/**
 * A flag as it may travel and be stored, or null when nothing usable is left.
 * Unknown kinds and sources are dropped rather than shown.
 *
 * @param {unknown} value
 * @returns {InjectionFlag|null}
 */
function normalizeInjectionFlag(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = /** @type {Record<string, unknown>} */ (value);
  if (!Array.isArray(raw.signals) || !Array.isArray(raw.sources)) return null;
  /** @type {InjectionSignal[]} */
  const signals = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of raw.signals) {
    if (signals.length >= INJECTION_FLAG_LIMITS.SIGNALS) break;
    if (!item || typeof item !== 'object') continue;
    const signal = /** @type {Record<string, unknown>} */ (item);
    if (!isInjectionSignalKind(signal.kind)) continue;
    const kind = /** @type {InjectionSignalKind} */ (signal.kind);
    const excerpt = cleanInjectionExcerpt(signal.excerpt);
    const key = `${kind}\u0000${excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    signals.push({ kind, excerpt });
  }
  const sources = [...new Set(raw.sources.filter(isFlagSource))].slice(0, INJECTION_FLAG_LIMITS.SOURCES);
  if (!signals.length || !sources.length) return null;
  return { signals, sources };
}

/**
 * Several flags on the same result — from the built-in detector and from
 * hooks — as one. Null when none of them holds anything.
 *
 * @param {unknown[]} flags
 * @returns {InjectionFlag|null}
 */
function mergeInjectionFlags(flags) {
  if (!Array.isArray(flags)) return null;
  const valid = flags.map(normalizeInjectionFlag).filter((flag) => flag !== null);
  if (!valid.length) return null;
  return normalizeInjectionFlag({
    signals: valid.flatMap((flag) => flag.signals),
    sources: valid.flatMap((flag) => flag.sources),
  });
}

module.exports = {
  INJECTION_SIGNAL_KINDS,
  INJECTION_FLAG_SOURCES,
  INJECTION_FLAG_LIMITS,
  isInjectionSignalKind,
  cleanInjectionExcerpt,
  normalizeInjectionFlag,
  mergeInjectionFlags,
};
