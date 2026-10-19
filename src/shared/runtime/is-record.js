/**
 * Narrowing for data from outside: parsed JSON, an IPC payload, a file read
 * back from disk. The callers check every field they use, so the guard only
 * has to say "this is an object" — `unknown` fields then stay `unknown` until
 * a `typeof` check has looked at them.
 */
'use strict';

/**
 * Any non-null object, arrays included — the check `typeof value === 'object'`
 * that normalizers have always made.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === 'object';
}

module.exports = { isRecord };
