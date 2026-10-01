'use strict';

/**
 * How a provider round ended (#538).
 *
 * Every provider maps its own stop reasons onto this small vocabulary instead
 * of passing raw strings through, so the chat engine can tell a finished
 * answer from one that was cut off. `INCOMPLETE` means the stream ended
 * without the event that closes a round — the connection dropped, or the
 * server stopped mid-answer.
 */
const FINISH_REASONS = Object.freeze({
  STOP: 'stop',
  TOOL_CALLS: 'tool_calls',
  LENGTH: 'length',
  CONTENT_FILTER: 'content_filter',
  INCOMPLETE: 'incomplete',
});

const CUT_OFF_REASONS = new Set([
  FINISH_REASONS.LENGTH,
  FINISH_REASONS.CONTENT_FILTER,
  FINISH_REASONS.INCOMPLETE,
]);

/** true when the round did not end on its own: its text and tool calls are partial. */
function isCutOff(finishReason) {
  return CUT_OFF_REASONS.has(finishReason);
}

/**
 * The finish reason of a round that streamed to its end. `cutOff` wins over
 * tool calls — a call that was cut off mid-argument must not run.
 */
function finishReasonOf({ cutOff = null, toolCalls = false } = {}) {
  if (cutOff && CUT_OFF_REASONS.has(cutOff)) return cutOff;
  return toolCalls ? FINISH_REASONS.TOOL_CALLS : FINISH_REASONS.STOP;
}

module.exports = {
  FINISH_REASONS,
  isCutOff,
  finishReasonOf,
};
