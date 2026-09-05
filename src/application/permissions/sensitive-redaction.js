/**
 * Provider-Bindung freigegebener sensibler Inhalte (Issue #66, Konzept §4).
 *
 * Eine Tool-Nachricht, die nach `read-sensitive`-Freigabe an einen konkreten
 * Provider-Endpunkt ging, trägt eine Markierung. Vor jedem Provider-Request
 * werden diese Markierungen geprüft: Stimmt der Endpunkt nicht, wird der
 * Inhalt durch einen Platzhalter ersetzt. Eine erneute Übermittlung verlangt
 * eine neue Freigabe. Die Redaktion ist der Standard, nicht die Rückfrage.
 */
'use strict';

const { SENSITIVE_CONTENT_REDACTED_TEXT } = require('../../shared/contracts/tool-permissions');

/** Markierung einer Tool-Nachricht: gebundener Endpunkt, Ziel, Dateiversion. */
function createSensitiveMarker({ providerKey, targets } = {}) {
  return {
    sensitive: true,
    providerKey: typeof providerKey === 'string' ? providerKey : '',
    targets: (Array.isArray(targets) ? targets : [])
      .map((target) => ({
        path: typeof target?.path === 'string' ? target.path : '',
        version: typeof target?.version === 'string' ? target.version : null,
      }))
      .filter((target) => target.path),
  };
}

function redactedToolContent() {
  return JSON.stringify({ redacted: true, note: SENSITIVE_CONTENT_REDACTED_TEXT });
}

/**
 * Ersetzt in-place den Inhalt aller markierten Tool-Nachrichten, deren
 * Endpunkt nicht dem aktuellen entspricht. Liefert die Zahl der Redaktionen.
 */
function redactSensitiveToolMessages(messages, currentProviderKey) {
  if (!Array.isArray(messages)) return 0;
  let redacted = 0;
  for (const message of messages) {
    if (!message || message.role !== 'tool') continue;
    const marker = message.sensitiveMarker;
    if (!marker || marker.sensitive !== true || message.redacted === true) continue;
    if (marker.providerKey === currentProviderKey) continue;
    message.content = redactedToolContent();
    message.redacted = true;
    redacted += 1;
  }
  return redacted;
}

/**
 * Nachrichten für den Provider ohne interne Markierungen. Die Marker bleiben
 * im lokalen Verlauf, gehen aber nie über die Leitung.
 */
function stripSensitiveMarkers(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    if (!message || message.role !== 'tool') return message;
    if (!message.sensitiveMarker && message.redacted !== true) return message;
    const { sensitiveMarker, redacted, ...rest } = message;
    return rest;
  });
}

module.exports = {
  createSensitiveMarker,
  redactedToolContent,
  redactSensitiveToolMessages,
  stripSensitiveMarkers,
};
