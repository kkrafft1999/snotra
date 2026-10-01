'use strict';

/**
 * The secret protection for text the prompt embeds by itself (#528).
 *
 * Skills, AGENTS.md and the memory files reach the provider with every
 * request, without the model asking for them. A file read with a tool passes
 * two checks on its way to the model (concept §4/§5); the same file embedded
 * here passed none. This module applies the same two to embedded text:
 *
 *  - an **own secret** (a provider key, an MCP secret, the web search key)
 *    leaves the whole text out — as with a tool result, it cannot be approved;
 *  - a **credential pattern** (a token, a private key, `password = …`) is
 *    masked, and the rest of the text goes along. Embedded text has no card
 *    that could hold it back, and an AGENTS.md is only useful in full.
 *
 * Text that is too large to scan is left out as well: unchecked content does
 * not go out (`scannable === false`, see `sensitive-content.js`).
 */

const {
  scanSensitiveContent,
  maskSensitiveContent,
  containsOwnSecret,
} = require('../../shared/runtime/sensitive-content');

const EMBEDDED_TEXT_GUARDS = Object.freeze({
  MASKED: 'masked',
  WITHHELD: 'withheld',
});

/**
 * What the model reads instead of a text that was left out. It says why, so
 * that the model neither guesses the content nor claims to have followed it.
 */
const WITHHELD_EMBEDDED_TEXT =
  '[Left out by Snotra AI: this text contains a key the app keeps for itself, '
  + 'or it could not be checked for one. Do not guess what it says.]';

/**
 * @param {string} text
 * @param {string[]} ownSecrets  the app's own secrets, compared verbatim
 * @returns {{ text: string, guard: string|null }}
 */
function guardEmbeddedText(text, ownSecrets) {
  if (typeof text !== 'string' || !text) return { text: typeof text === 'string' ? text : '', guard: null };
  if (containsOwnSecret(text, ownSecrets)) {
    return { text: WITHHELD_EMBEDDED_TEXT, guard: EMBEDDED_TEXT_GUARDS.WITHHELD };
  }
  const scan = scanSensitiveContent(text);
  if (!scan.scannable) return { text: WITHHELD_EMBEDDED_TEXT, guard: EMBEDDED_TEXT_GUARDS.WITHHELD };
  if (scan.sensitive) return { text: maskSensitiveContent(text), guard: EMBEDDED_TEXT_GUARDS.MASKED };
  return { text, guard: null };
}

/** The stronger of two guards: withheld over masked over none. */
function strongerGuard(a, b) {
  if (a === EMBEDDED_TEXT_GUARDS.WITHHELD || b === EMBEDDED_TEXT_GUARDS.WITHHELD) return EMBEDDED_TEXT_GUARDS.WITHHELD;
  if (a === EMBEDDED_TEXT_GUARDS.MASKED || b === EMBEDDED_TEXT_GUARDS.MASKED) return EMBEDDED_TEXT_GUARDS.MASKED;
  return null;
}

/** Files from the project-instructions or memory port, each with its text guarded. */
function guardEmbeddedFiles(files, ownSecrets) {
  if (!Array.isArray(files)) return [];
  return files.map((file) => {
    if (!file || typeof file.text !== 'string') return file;
    const { text, guard } = guardEmbeddedText(file.text, ownSecrets);
    return guard ? { ...file, text, guard } : file;
  });
}

/**
 * The switched-on skills with body and description guarded. A skill whose
 * text was left out keeps its name, so the catalogue still lists it.
 */
function guardEmbeddedSkills(skills, ownSecrets) {
  if (!Array.isArray(skills)) return [];
  return skills.map((skill) => {
    if (!skill || typeof skill !== 'object') return skill;
    const body = guardEmbeddedText(skill.body, ownSecrets);
    const description = guardEmbeddedText(skill.description, ownSecrets);
    const guard = strongerGuard(body.guard, description.guard);
    if (!guard) return skill;
    return { ...skill, body: body.text, description: description.text, guard };
  });
}

module.exports = {
  EMBEDDED_TEXT_GUARDS,
  WITHHELD_EMBEDDED_TEXT,
  guardEmbeddedText,
  guardEmbeddedFiles,
  guardEmbeddedSkills,
};
