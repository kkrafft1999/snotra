'use strict';

const CLOUD_MODELS_TIMEOUT_MS = 15_000;
const LOCAL_MODELS_TIMEOUT_MS = 30_000;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;

// Covers the complete operation, including response bodies. The race also
// releases callers when a transport fails to honor its AbortSignal.
async function withRequestTimeout(operation, { timeoutMs, signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Anfrage abgebrochen.'));
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(
    new Error(`Zeitüberschreitung nach ${timeoutMs / 1000} s. Bitte erneut versuchen.`)
  ), timeoutMs);
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

module.exports = { withRequestTimeout, CLOUD_MODELS_TIMEOUT_MS, LOCAL_MODELS_TIMEOUT_MS, TRANSCRIPTION_TIMEOUT_MS };
