'use strict';

const { createMessage } = require('../../shared/contracts/message');

const CLOUD_MODELS_TIMEOUT_MS = 15_000;
const LOCAL_MODELS_TIMEOUT_MS = 30_000;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;

// The reason an abort carries has two readers. `message` stays the finished
// sentence the transcription still shows as it stands; `userMessage` is the
// same thing as a key, for the settings dialog that puts it into words in the
// language of the interface (#308).
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
    abortReason('Anfrage abgebrochen.', createMessage('provider.error.cancelled'))
  );
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(abortReason(
    `Zeitüberschreitung nach ${timeoutMs / 1000} s. Bitte erneut versuchen.`,
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
