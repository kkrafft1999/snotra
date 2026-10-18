'use strict';

/**
 * The app's own secrets for the chat core (#528), which keeps them out of the
 * skills, AGENTS.md and memory it embeds in the prompt (concept §5). Which
 * secrets these are is `services/own-secrets.js`'s business; this only hands
 * its reader on, typed against the port (#1098).
 *
 * @param {() => Promise<string[]>} readOwnSecrets
 * @returns {import('../../application/ports/own-secrets-port').OwnSecretsPort}
 */
function createOwnSecretsAdapter(readOwnSecrets) {
  return { read: () => readOwnSecrets() };
}

module.exports = { createOwnSecretsAdapter };
