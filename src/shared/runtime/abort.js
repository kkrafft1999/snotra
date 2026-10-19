'use strict';

/** @param {{ name?: unknown, code?: unknown } | null | undefined} err */
function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

function createChatAbortError(message = 'Chat abgebrochen.') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** @param {AbortSignal | null | undefined} [abortSignal] */
function abortIfRequested(abortSignal) {
  if (!abortSignal?.aborted) return;
  const reason = abortSignal.reason;
  if (reason instanceof Error) throw reason;
  const err = new Error('Aborted');
  err.name = 'AbortError';
  throw err;
}

/**
 * @param {{ cancel?: (reason?: unknown) => Promise<unknown> } | null | undefined} reader
 * @param {AbortSignal | null | undefined} abortSignal
 * @returns {() => void} Removes the listener again.
 */
function bindAbortSignalToReader(reader, abortSignal) {
  if (!abortSignal || !reader) return () => {};
  const cancelReader = () => {
    if (typeof reader.cancel === 'function') {
      reader.cancel('Chat abgebrochen.').catch(() => {});
    }
  };
  if (abortSignal.aborted) {
    cancelReader();
    return () => {};
  }
  abortSignal.addEventListener('abort', cancelReader, { once: true });
  return () => abortSignal.removeEventListener('abort', cancelReader);
}

/**
 * @param {number} ms
 * @param {AbortSignal | null | undefined} [abortSignal]
 */
async function sleepAbortable(ms, abortSignal) {
  abortIfRequested(abortSignal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, ms);
    const onAbort = () => {
      cleanup();
      const reason = abortSignal?.reason;
      if (reason instanceof Error) {
        reject(reason);
        return;
      }
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = {
  isAbortError,
  createChatAbortError,
  abortIfRequested,
  bindAbortSignalToReader,
  sleepAbortable,
};
