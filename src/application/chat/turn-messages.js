/**
 * What a turn leaves in its chat (#981): the answer as it grows from the
 * engine's events, and as it stands once the run is settled. The rules are
 * the ones the renderer applied until #981 (`onChatDelta`, `onChatToolLine`,
 * `settleRunMessages` in `ChatStream.js`), without what only the screen needs
 * — phases, pending lines, the thinking clock.
 *
 * The messages are in the form the history stores; main's store normalises
 * each trace entry and marks a message still `streaming` as cut off (#979).
 */

/**
 * @typedef {{ type?: string, payload?: any }} EngineEvent
 * @typedef {Object} TurnAnswer
 * @property {'assistant'} role
 * @property {string} content
 * @property {Array<string|Record<string, unknown>>} toolTrace
 * @property {string} reasoningText
 * @property {boolean} streaming
 * @property {boolean} [toolRunning]  a step has started and not finished yet
 * @property {boolean} [isError]
 * @property {number} [durationMs]  how long the turn took, on its last message (#1254)
 * @property {true} [stopped]  the turn was stopped or cancelled before it answered (#1254)
 *
 * @typedef {Record<string, unknown> & { role: string, content?: unknown }} ChatMessage
 */

/** The event types of `CHAT_ENGINE_EVENTS`, named here so the module needs no engine. */
const EVENT = Object.freeze({ DELTA: 'delta', PROGRESS: 'progress', TOOL_LINE: 'tool-line' });

/** @returns {TurnAnswer} */
function createTurnAnswer() {
  return { role: 'assistant', content: '', toolTrace: [], reasoningText: '', streaming: true };
}

/**
 * A step's line as the history keeps it: the display line and what the store
 * normalises — tool, skill, category, audit, changes, what the sandbox
 * refused. Arguments never come along.
 *
 * @param {Record<string, unknown>} payload
 */
function traceEntryOf(payload) {
  const { phase: _phase, callIndex: _callIndex, chatId: _chatId, runId: _runId, args: _args, ...entry } = payload;
  return entry;
}

/**
 * Applies one engine event to the growing answer. Returns true when a step
 * has just finished — the moment the renderer saved the turn so far (#979).
 *
 * @param {TurnAnswer} answer
 * @param {EngineEvent} event
 * @returns {boolean}
 */
function applyTurnEvent(answer, event) {
  if (!answer.streaming || !event || typeof event.type !== 'string') return false;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  if (event.type === EVENT.DELTA) {
    answer.content += typeof payload.text === 'string' ? payload.text : '';
    return false;
  }
  if (event.type === EVENT.PROGRESS) {
    if (payload.type === 'reasoning' && typeof payload.text === 'string') answer.reasoningText += payload.text;
    return false;
  }
  if (event.type !== EVENT.TOOL_LINE || typeof payload.line !== 'string' || !payload.line) return false;
  const phase = payload.phase || 'start';
  if (phase === 'start') {
    answer.toolTrace.push(traceEntryOf(payload));
    answer.toolRunning = true;
    return false;
  }
  if (phase === 'done') {
    const entry = traceEntryOf(payload);
    if (answer.toolTrace.length > 0) answer.toolTrace[answer.toolTrace.length - 1] = entry;
    else answer.toolTrace.push(entry);
    delete answer.toolRunning;
    return true;
  }
  return false;
}

/**
 * The answer as it may be written while the run goes on (#979): the step
 * still running has no result yet; written down, it would come back after a
 * crash looking finished.
 *
 * @param {TurnAnswer} answer
 * @returns {TurnAnswer}
 */
function answerForCheckpoint(answer) {
  if (!answer.streaming || !answer.toolRunning) return { ...answer, toolTrace: [...answer.toolTrace] };
  return { ...answer, toolTrace: answer.toolTrace.slice(0, -1) };
}

/** @param {TurnAnswer} answer */
function finish(answer) {
  answer.streaming = false;
  delete answer.toolRunning;
}

/**
 * The messages a settled turn leaves behind, after `history` (everything up to
 * and including the question).
 *
 * - Stopped by the user: the answer as far as it had come when the stop was
 *   pressed, the step that was running included — what the screen showed.
 * - Cancelled otherwise: the engine's text and steps, if it has them.
 * - Failed: the steps done until then and a text cut off mid-way stay (#527,
 *   #538), and the error follows as a message of its own.
 * - Answered: the engine's text and steps.
 *
 * The turn's last message — the answer, or the error below it — carries how
 * long the turn took (#1254); a stopped or cancelled answer says so.
 *
 * @param {ChatMessage[]} history
 * @param {TurnAnswer} answer
 * @param {any} result  the engine's result
 * @param {{ describeError: (error: unknown) => string, stopped?: boolean, durationMs?: number }} options
 * @returns {ChatMessage[]}
 */
function settleTurn(history, answer, result, { describeError, stopped = false, durationMs }) {
  const settled = settleMessages(history, answer, result, { describeError, stopped });
  const last = settled[settled.length - 1];
  if (last === answer && (stopped || result?.cancelled)) answer.stopped = true;
  if (settled.length > history.length && Number.isFinite(durationMs) && /** @type {number} */ (durationMs) >= 0) {
    last.durationMs = Math.round(/** @type {number} */ (durationMs));
  }
  return settled;
}

/**
 * @param {ChatMessage[]} history
 * @param {TurnAnswer} answer
 * @param {any} result
 * @param {{ describeError: (error: unknown) => string, stopped: boolean }} options
 * @returns {ChatMessage[]}
 */
function settleMessages(history, answer, result, { describeError, stopped }) {
  const trace = (/** @type {unknown} */ list) => (Array.isArray(list)
    ? list.map((entry) => (entry && typeof entry === 'object' ? traceEntryOf(/** @type {Record<string, unknown>} */ (entry)) : entry))
    : answer.toolTrace);
  if (stopped) {
    finish(answer);
    return [...history, answer];
  }
  if (result?.cancelled) {
    finish(answer);
    if (typeof result.content === 'string' && result.content.length > 0) answer.content = result.content;
    if (Array.isArray(result.toolTrace)) answer.toolTrace = trace(result.toolTrace);
    return [...history, answer];
  }
  if (result?.error) {
    const errorMessage = { role: 'assistant', content: describeError(result.error), isError: true };
    const ranTools = Array.isArray(result.toolTrace) && result.toolTrace.length > 0;
    const keepsPartial = result.partial === true && !!answer.content;
    if (!ranTools && !keepsPartial) return [...history, errorMessage];
    finish(answer);
    if (ranTools) answer.toolTrace = trace(result.toolTrace);
    return [...history, answer, errorMessage];
  }
  finish(answer);
  answer.content = typeof result?.content === 'string' ? result.content : '';
  answer.toolTrace = trace(result?.toolTrace);
  return [...history, answer];
}

module.exports = { createTurnAnswer, applyTurnEvent, answerForCheckpoint, settleTurn, traceEntryOf };
