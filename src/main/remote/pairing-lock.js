'use strict';

/**
 * Whether this build lets a phone be paired (#1110). *Settings › Remote
 * access* is built and shown, but pairing stays closed until the phone's
 * side is out (decided 2026-10-21): the panel shows why, and main refuses
 * `remote:pair:start` with `locked` before anything reaches the relay — not
 * only the button is disabled. A phone paired already can still be removed.
 *
 * Opening it is this one line, together with the manual chapter on remote
 * access.
 */
const PAIRING_OPEN = false;

module.exports = { PAIRING_OPEN };
