'use strict';

/**
 * Server-sent events from a byte stream (#1114), as the Realtime Database's
 * REST streaming sends them: `event:` and `data:` lines, a blank line ends
 * an event, `:` starts a comment. Only what the desktop needs of the format —
 * no `id:` or `retry:`, which the database does not send.
 */

const MAX_EVENT_CHARS = 64 * 1024;
const LINE_END = /\r\n|\r|\n/;

/**
 * Reads until the stream ends; rejects when it fails or when one event grows
 * past `maxEventChars` — a relay must not be able to fill main's memory.
 *
 * @param {AsyncIterable<Uint8Array>} body  a fetch response's body
 * @param {(event: { type: string, data: string }) => void} onEvent
 * @param {{ maxEventChars?: number }} [options]
 */
async function readEventStream(body, onEvent, { maxEventChars = MAX_EVENT_CHARS } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let type = '';
  /** @type {string[]} */
  let data = [];
  let size = 0;

  function dispatch() {
    if (data.length > 0) onEvent({ type: type || 'message', data: data.join('\n') });
    type = '';
    data = [];
    size = 0;
  }

  /** @param {string} text */
  function line(text) {
    if (text === '') {
      dispatch();
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    size += value.length;
    if (size > maxEventChars) throw new RangeError('event stream: event too large');
    if (field === 'event') type = value;
    else if (field === 'data') data.push(value);
  }

  /** @param {boolean} final */
  function drain(final) {
    for (;;) {
      const match = LINE_END.exec(buffer);
      if (!match) break;
      // A CR at the very end may be the first half of a CRLF still on its way.
      if (!final && match[0] === '\r' && match.index === buffer.length - 1) break;
      line(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
    if (buffer.length > maxEventChars) throw new RangeError('event stream: line too long');
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    drain(false);
  }
  buffer += decoder.decode();
  drain(true);
}

module.exports = { readEventStream, MAX_EVENT_CHARS };
