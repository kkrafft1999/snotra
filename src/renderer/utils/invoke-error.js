import contracts from '../generated/contracts.js';

const { createMessage } = contracts;

/**
 * A rejected `invoke`, put into the user's words (#1013).
 *
 * When a handler in main throws, Electron rejects the call in the renderer
 * with its own English wrapper around main's message:
 * "Error invoking remote method 'update:download': Error: socket hang up".
 * That text was written for a developer and is in the wrong language half the
 * time, so the user gets the caller's sentence instead and the raw text goes
 * to the console, where whoever debugs it looks.
 */

const WRAPPER = /^Error invoking remote method '[^']*':\s*/;
const ERROR_PREFIX = /^(?:[A-Z][A-Za-z]*)?Error:\s*/;

/** Main's own text from a rejected invoke, without Electron's wrapper. */
export function invokeErrorDetail(err) {
  const raw = typeof err?.message === 'string' ? err.message : typeof err === 'string' ? err : '';
  const unwrapped = raw.replace(WRAPPER, '');
  return (unwrapped === raw ? unwrapped : unwrapped.replace(ERROR_PREFIX, '')).trim();
}

/**
 * The keyed message a caller shows for a rejected invoke. The detail is
 * logged, not shown: a sentence that wants it says so with a `{error}`
 * placeholder and gets `invokeErrorDetail()` itself.
 *
 * @param {unknown} err     What the rejected promise carried.
 * @param {string}  key     The catalogue key of the sentence to show.
 * @param {object} [params] Values for that sentence's placeholders.
 */
export function invokeErrorMessage(err, key, params) {
  const detail = invokeErrorDetail(err);
  if (detail) console.warn(`[invoke] ${key}:`, detail);
  return createMessage(key, params);
}
