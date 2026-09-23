'use strict';

const { createMessage } = require('../../shared/contracts/message');

const CLOUD_MODELS_TIMEOUT_MS = 15_000;
const LOCAL_MODELS_TIMEOUT_MS = 30_000;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;

// The reason an abort carries: `userMessage` is the key the interface puts into
// words (#308), `message` is for logs and stack traces only. Since #310 nothing
// shows `message` to the user any more — model listing and transcription both
// go through `userMessageOf`.
function abortReason(text, userMessage) {
  return Object.assign(new Error(text), { userMessage });
}

/** What to show for a failed request: the key if there is one, else the text. */
function userMessageOf(err) {
  return err?.userMessage || err?.message;
}

// Covers the complete operation, including response bodies. The race also
// releases callers when a transport fails to honor its AbortSignal.
async function withRequestTimeout(operation, { timeoutMs, signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(
    abortReason('Request cancelled.', createMessage('provider.error.cancelled'))
  );
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(abortReason(
    `Request timed out after ${timeoutMs / 1000} s.`,
    createMessage('provider.error.timeout', { seconds: timeoutMs / 1000 })
  )), timeoutMs);
  try {
    if (signal?.aborted) abort();
    return await Promise.race([
      aborted,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { withRequestTimeout, userMessageOf, CLOUD_MODELS_TIMEOUT_MS, LOCAL_MODELS_TIMEOUT_MS, TRANSCRIPTION_TIMEOUT_MS };
