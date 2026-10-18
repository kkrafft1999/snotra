'use strict';

/**
 * Where the relay of the mobile remote is (#1114). It does not exist yet: the
 * relay is phase 2 of #1081, built in snotra-promotion, in the Firebase
 * project `snotra-relay`. Until that phase sets its host, database and web
 * API key here, a pairing ends in *Relay unreachable* with the reason
 * `not-configured` — and *Settings › Remote access* (#1110) ships only
 * together with a relay.
 *
 * Not configurable from outside on purpose: the phone accepts only the relay
 * hosts it ships with (docs/remote-protocol.md §4), so a desktop pointed
 * elsewhere could pair with nothing.
 *
 * @type {import('./firebase-relay-adapter').FirebaseRelayEndpoint | null}
 */
const PRODUCTION_RELAY = null;

module.exports = { PRODUCTION_RELAY };
