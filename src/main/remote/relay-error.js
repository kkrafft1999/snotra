'use strict';

/**
 * The one error a relay adapter rejects with (#1114). It carries a reason and
 * the HTTP status, and a message made of the reason alone: a URL can hold an
 * ID token (`?auth=` on the database's REST interface), a body a custom
 * token, so neither ever goes into an error that may end up in the log or a
 * crash report.
 */

const { REMOTE_PAIRING_REASONS } = require('../../shared/contracts/remote/pairing-state');

/** The relay's own reasons (docs/remote-protocol.md §5.1) and the adapter's. */
const RELAY_REASONS = Object.freeze({
  ...REMOTE_PAIRING_REASONS,
  INVALID_REQUEST: 'invalid-request',
  NOT_FOUND: 'not-found',
  BUSY: 'busy',
  TOO_LARGE: 'too-large',
});

const BY_STATUS = new Map([
  [400, RELAY_REASONS.INVALID_REQUEST],
  [401, RELAY_REASONS.UNAUTHORIZED],
  [403, RELAY_REASONS.REFUSED],
  [404, RELAY_REASONS.NOT_FOUND],
  [409, RELAY_REASONS.BUSY],
  [413, RELAY_REASONS.TOO_LARGE],
  [429, RELAY_REASONS.RATE_LIMITED],
  [503, RELAY_REASONS.UNAVAILABLE],
]);

class RemoteRelayError extends Error {
  /**
   * @param {string} reason  a RELAY_REASONS value
   * @param {{ status?: number }} [details]
   */
  constructor(reason, { status } = {}) {
    super(`remote relay: ${reason}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'RemoteRelayError';
    this.reason = reason;
    this.status = Number.isInteger(status) ? status : null;
  }
}

/**
 * The reason for an HTTP status; the status decides, a body cannot claim another.
 * @param {number} status
 */
function reasonForStatus(status) {
  const known = BY_STATUS.get(status);
  if (known !== undefined) return known;
  return status >= 500 ? RELAY_REASONS.UNAVAILABLE : RELAY_REASONS.INVALID_RESPONSE;
}

/**
 * Whatever a call threw, as a relay error. Anything that is not one already —
 * a `fetch` failure, an abort — becomes `network`, and its message is
 * dropped: undici quotes the URL it could not reach.
 *
 * @param {unknown} error
 */
function toRelayError(error) {
  return error instanceof RemoteRelayError ? error : new RemoteRelayError(RELAY_REASONS.NETWORK);
}

module.exports = { RELAY_REASONS, RemoteRelayError, reasonForStatus, toRelayError };
