// Where a question or a card's answer came from when it was not this window
// (#1197): a small phone glyph with the phone's name, quiet and grey — the
// message is still the user's own. A question gets a line of its own under
// its bubble; a tool step and a folded card carry the same glyph after their
// text. Only the phone leaves a mark; a chat written at the desk looks as it
// always did.
//
// The name comes from the phone (`session.hello`) and is shown, never
// trusted: it is cleaned by the contract and only ever set as text.

import contracts from '../generated/contracts.js';
import { t } from '../i18n.js';

const { normalizeMessageOrigin } = contracts;

// The phone of Settings › Remote access, drawn for 16 px.
const PHONE_ICON_HTML = '<svg class="chat-origin-icon" viewBox="0 0 16 16" aria-hidden="true">'
  + '<rect x="4.3" y="1.7" width="7.4" height="12.6" rx="1.7"/><path d="M7 11.8h2"/></svg>';

/**
 * The origin worth a mark, or null.
 * @param {unknown} raw
 * @returns {{ kind: string, client: string } | null}
 */
export function messageOriginOf(raw) {
  return normalizeMessageOrigin(raw);
}

/**
 * "Answered on iPhone" — for a row's label, where the glyph says nothing.
 * @param {{ client: string }} origin
 */
export function answeredOnText(origin) {
  return origin.client ? t('chat.origin.answered', { name: origin.client }) : t('chat.origin.answeredPhone');
}

/**
 * The line under a question from the phone: the glyph and "Sent from
 * iPhone", as text — so that a copied chat still says where it came from.
 * @param {{ client: string }} origin
 */
export function buildSentFromLine(origin) {
  const line = document.createElement('span');
  line.className = 'chat-msg-origin';
  line.title = t('chat.origin.sentPhone');
  line.insertAdjacentHTML('afterbegin', PHONE_ICON_HTML);
  const text = document.createElement('span');
  text.textContent = origin.client ? t('chat.origin.sent', { name: origin.client }) : t('chat.origin.sentPhone');
  line.appendChild(text);
  return line;
}

/**
 * The mark after a decision the phone gave: the glyph and the phone's name;
 * a screen reader hears "Answered on iPhone".
 * @param {{ client: string }} origin
 */
export function buildAnsweredOnTag(origin) {
  const tag = document.createElement('span');
  tag.className = 'chat-origin-tag';
  tag.title = t('chat.origin.answeredPhone');
  tag.insertAdjacentHTML('afterbegin', PHONE_ICON_HTML);
  const name = document.createElement('span');
  name.className = 'chat-origin-tag__name';
  name.setAttribute('aria-hidden', 'true');
  name.textContent = origin.client || t('chat.origin.phone');
  const spoken = document.createElement('span');
  spoken.className = 'sr-only';
  spoken.textContent = answeredOnText(origin);
  tag.append(name, spoken);
  return tag;
}
