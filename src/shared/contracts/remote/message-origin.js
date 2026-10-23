/**
 * Where a message or a card's answer came from, when it was not the window
 * (#1197, `docs/remote-interface.md` §7.4, §8.1): the front end's kind and
 * the name it gave in `session.hello`.
 *
 * ```
 * origin: { kind: 'relay', client: 'iPhone' }
 * ```
 *
 * Stored with a user message the phone wrote and with a tool step whose card
 * the phone answered, so that the chat can say so later. Nothing is stored
 * for the window — an old chat and a desktop message look the same. The
 * client's name is shown, never trusted (§7.1): it is bounded and cleaned
 * here, and nothing decides anything by it.
 */
'use strict';

const { isRecord } = require('../../runtime/is-record');

/** The kinds that leave a mark. A `local` front end has no listener yet. */
const MESSAGE_ORIGIN_KINDS = Object.freeze({ RELAY: 'relay' });

/** As long as `session.hello` lets a client name be (§8.1). */
const MESSAGE_ORIGIN_CLIENT_MAX = 64;

/** @type {Set<string>} */
const KINDS = new Set(Object.values(MESSAGE_ORIGIN_KINDS));

/**
 * The origin as it may be stored and shown, or null — for the window, for an
 * old chat and for anything that is not one.
 *
 * @param {unknown} raw
 * @returns {{ kind: string, client: string } | null}
 */
function normalizeMessageOrigin(raw) {
  if (!isRecord(raw) || typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null;
  const name = typeof raw.client === 'string' ? raw.client : '';
  // Control characters and runs of white space would only disturb the line it is shown in.
  const client = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, MESSAGE_ORIGIN_CLIENT_MAX).trim();
  return { kind: raw.kind, client };
}

module.exports = { MESSAGE_ORIGIN_KINDS, MESSAGE_ORIGIN_CLIENT_MAX, normalizeMessageOrigin };
