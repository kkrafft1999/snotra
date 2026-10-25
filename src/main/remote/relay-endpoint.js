'use strict';

/**
 * Where the relay of the mobile remote is (#1114, #1193): a Cloud Function
 * behind the Hosting site `relay.snotra-ai.dev`, with its own Realtime
 * Database instance, in the Firebase project `snotra-ai` (decided
 * 2026-10-17; built in kkrafft1999/snotra-promotion#165, live since
 * 2026-10-19). `relayUrl` is left to its default, `https://<relayHost>/v1`.
 *
 * The web API key is not in the repository. The release pipeline writes it
 * from the secret `SNOTRA_RELAY_API_KEY` into `relay-key.generated.json`
 * before it builds (`scripts/write-relay-key.js`; decided 2026-10-21). That
 * keeps it out of secret scanners and lets it be replaced without a commit.
 * It is no protection: the key is in every shipped app, and a Firebase web
 * API key names the project rather than granting anything. It is one of its
 * own, *Snotra desktop relay*, restricted to the Identity Toolkit and Token
 * Service APIs. A build without it — a test run, a local build without the
 * variable — has no relay, and a pairing ends in *Relay unreachable* with
 * the reason `not-configured`.
 *
 * Not configurable from outside on purpose: the phone accepts only the relay
 * hosts it ships with (docs/remote/remote-protocol.md §4), so a desktop pointed
 * elsewhere could pair with nothing.
 */

const RELAY_HOST = 'relay.snotra-ai.dev';
const DATABASE_URL = 'https://snotra-ai-relay.europe-west1.firebasedatabase.app';
/** The shape of a Google API key; anything else is no key. */
const API_KEY = /^AIza[0-9A-Za-z_-]{35}$/;

/**
 * The production relay with this key, or null without a usable one.
 * @param {unknown} apiKey
 * @returns {import('./firebase-relay-adapter').FirebaseRelayEndpoint | null}
 */
function productionRelay(apiKey) {
  if (typeof apiKey !== 'string' || !API_KEY.test(apiKey)) return null;
  return Object.freeze({ relayHost: RELAY_HOST, databaseUrl: DATABASE_URL, apiKey });
}

/** Written at build time, so it may not be there. */
const KEY_FILE = './relay-key.generated.json';

/** The key this build was given, or null. */
function buildKey() {
  try {
    return require(KEY_FILE).apiKey;
  } catch {
    // No key in this build: there is no relay, and a pairing says so.
    return null;
  }
}

/** @type {import('./firebase-relay-adapter').FirebaseRelayEndpoint | null} */
const PRODUCTION_RELAY = productionRelay(buildKey());

module.exports = { PRODUCTION_RELAY, productionRelay, RELAY_HOST, API_KEY };
