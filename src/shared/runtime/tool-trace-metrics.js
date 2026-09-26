'use strict';

/**
 * Turns stored tool traces into numbers (#187).
 *
 * The expensive part of a weak tool description is not the wrong parameter
 * but the extra round it causes. Two kinds of evidence are already in the
 * history: refusals with `reason: 'invalid_arguments'` in the permission
 * audit, and — since #187 — the round each call came in and the schema
 * violations the planner let through. This module only reads them; it is the
 * predicate the A/B measurement (#186) builds on.
 *
 * Works on the trace as the engine produces it and as the history stores it;
 * plain string entries from old histories count as calls without details.
 */

const { PERMISSION_DENIAL_REASONS } = require('../contracts/tool-permissions');

const VIOLATION_KINDS = Object.freeze(['unknownProperties', 'nonInteger', 'invalidItems']);

function emptyViolationCounts() {
  return { unknownProperties: 0, nonInteger: 0, invalidItems: 0 };
}

/**
 * @param {Array<string|object>} toolTrace  the trace of one assistant turn
 * @returns {{
 *   calls: number,
 *   rounds: number|null,
 *   invalidArgumentDenials: number,
 *   callsWithSchemaViolations: number,
 *   schemaViolations: { unknownProperties: number, nonInteger: number, invalidItems: number },
 * }}  `rounds` is the number of tool rounds, null when no entry records one
 *   (histories from before #187)
 */
function summarizeToolTrace(toolTrace) {
  const summary = {
    calls: 0,
    rounds: null,
    invalidArgumentDenials: 0,
    callsWithSchemaViolations: 0,
    schemaViolations: emptyViolationCounts(),
  };
  if (!Array.isArray(toolTrace)) return summary;
  const rounds = new Set();
  for (const entry of toolTrace) {
    if (typeof entry === 'string') {
      if (entry) summary.calls += 1;
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    summary.calls += 1;
    if (Number.isInteger(entry.round) && entry.round > 0) rounds.add(entry.round);
    if (entry.permission?.reason === PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS) {
      summary.invalidArgumentDenials += 1;
    }
    let violated = false;
    for (const kind of VIOLATION_KINDS) {
      const paths = entry.schema?.[kind];
      if (Array.isArray(paths) && paths.length > 0) {
        summary.schemaViolations[kind] += paths.length;
        violated = true;
      }
    }
    if (violated) summary.callsWithSchemaViolations += 1;
  }
  if (rounds.size > 0) summary.rounds = Math.max(...rounds);
  return summary;
}

/**
 * Sums the assistant turns of a conversation.
 *
 * @param {Array<{ role?: string, toolTrace?: Array }>} messages  stored or live chat messages
 * @returns {{ turns: Array<ReturnType<typeof summarizeToolTrace>>, total: object }}
 *   one summary per assistant turn that called a tool, plus their sum;
 *   `total.rounds` adds up the turns that record rounds
 */
function summarizeConversation(messages) {
  const turns = (Array.isArray(messages) ? messages : [])
    .filter((m) => m?.role === 'assistant' && Array.isArray(m.toolTrace) && m.toolTrace.length > 0)
    .map((m) => summarizeToolTrace(m.toolTrace));
  const total = {
    calls: 0,
    rounds: null,
    invalidArgumentDenials: 0,
    callsWithSchemaViolations: 0,
    schemaViolations: emptyViolationCounts(),
  };
  for (const turn of turns) {
    total.calls += turn.calls;
    if (turn.rounds !== null) total.rounds = (total.rounds || 0) + turn.rounds;
    total.invalidArgumentDenials += turn.invalidArgumentDenials;
    total.callsWithSchemaViolations += turn.callsWithSchemaViolations;
    for (const kind of VIOLATION_KINDS) total.schemaViolations[kind] += turn.schemaViolations[kind];
  }
  return { turns, total };
}

module.exports = {
  summarizeToolTrace,
  summarizeConversation,
  VIOLATION_KINDS,
};
