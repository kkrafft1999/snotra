'use strict';

const { redactOwnSecrets } = require('../../shared/runtime/sensitive-content');
const { createMessage, isMessage } = require('../../shared/contracts/message');

/**
 * What the UI learns about MCP. A server's status carries its error message
 * and an excerpt of its stderr — and a server that stumbles at start-up likes
 * to print its environment. Both therefore run through the masking before
 * they leave the main process (concept §5).
 *
 * @param {object[]} statuses  as `mcpService` describes them
 * @param {string[]} secrets   the MCP secrets in all their forms (`own-secrets`)
 */
function maskMcpStatuses(statuses, secrets) {
  if (!Array.isArray(secrets) || secrets.length === 0) return statuses;
  // Since #338 the error can be a catalogue message; a server's text then
  // sits in its parameters, and that is where the masking has to reach.
  const mask = (value) => {
    if (typeof value === 'string') return redactOwnSecrets(value, secrets);
    if (!isMessage(value)) return value;
    const params = value.params
      ? Object.fromEntries(Object.entries(value.params).map(([name, inner]) => [name, mask(inner)]))
      : undefined;
    return createMessage(value.key, params);
  };
  return statuses.map((status) => ({
    ...status,
    error: mask(status.error),
    stderr: redactOwnSecrets(status.stderr, secrets),
  }));
}

module.exports = { maskMcpStatuses };
