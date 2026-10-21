'use strict';

/**
 * The renderer's errors in main's log (#919). An exception that ran out of a
 * handler, or a rejected promise nobody waited for, used to end in the
 * DevTools console only — which nobody has open in the field, and which the
 * e2e tests do not read. A send that threw after taking its draft therefore
 * left main's log empty, as if the message had never been typed.
 *
 * Chromium reports uncaught errors as console messages of level `error`, so
 * one listener on `console-message` catches them together with what the
 * renderer logs through `console.error` itself.
 */

const MESSAGE_MAX = 2000;

/**
 * @param {string} text
 * @param {number} [max]
 */
function truncate(text, max = MESSAGE_MAX) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `file:///…/src/renderer/components/ChatStream.js` → `components/ChatStream.js`. */
/** @param {unknown} sourceId */
function shortSource(sourceId) {
  const source = String(sourceId);
  const marker = '/src/renderer/';
  const at = source.lastIndexOf(marker);
  return at >= 0 ? source.slice(at + marker.length) : source;
}

/**
 * A `console-message` listener that writes the renderer's errors to `log`.
 *
 * @param {object} [options]
 * @param {(line: string) => void} [options.log]
 * @returns {(details: { level?: unknown, message?: unknown, sourceId?: unknown, lineNumber?: unknown }|null|undefined) => void}
 */
function createRendererErrorForwarder({ log = (line) => console.error(line) } = {}) {
  return (details) => {
    if (details?.level !== 'error') return;
    const message = truncate(String(details.message ?? ''));
    const where = details.sourceId ? ` (${shortSource(details.sourceId)}:${details.lineNumber ?? 0})` : '';
    log(`[renderer] ${message}${where}`);
  };
}

module.exports = { createRendererErrorForwarder };
