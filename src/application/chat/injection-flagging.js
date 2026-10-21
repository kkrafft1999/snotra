/**
 * Asks every injection-flag source about one tool result and merges what
 * they found (#1011, AR-36).
 *
 * Fail-open for the warning only: a source that throws or answers with
 * something that is not a flag adds nothing, and the others still count.
 * The result is a flag for the tool row or null — it is never handed to the
 * policy, the approvals or the model, so neither its presence nor its absence
 * can move a boundary.
 */
'use strict';

const { mergeInjectionFlags } = require('../../shared/contracts/injection-flag');

/**
 * @param {ReadonlyArray<import('../ports/injection-flag-port').InjectionFlagPort>|null|undefined} sources
 * @param {import('../ports/injection-flag-port').InjectionInspection} inspection
 * @returns {Promise<import('../../shared/contracts/injection-flag').InjectionFlag|null>}
 */
async function flagToolResult(sources, inspection) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  if (typeof inspection?.content !== 'string' || !inspection.content) return null;
  /** @type {unknown[]} */
  const flags = [];
  for (const source of sources) {
    if (!source || typeof source.inspect !== 'function') continue;
    try {
      flags.push(await source.inspect(inspection));
    } catch {
      // Best effort: a broken source costs the warning, nothing else.
    }
  }
  return mergeInjectionFlags(flags);
}

module.exports = { flagToolResult };
