/**
 * Wo ein Anbieter-Endpunkt steht — lokal auf diesem Rechner oder entfernt.
 *
 * Bis Issue #193 hing diese Unterscheidung an einer festen Liste von
 * Provider-IDs (`ollama`, `mlx-lm`). Der Provider „OpenAI-kompatibel" passt in
 * keine solche Liste: dieselbe ID zeigt mal auf LM Studio an `localhost`, mal
 * auf ein Gateway im Netz. Die Frage „lokal oder entfernt" beantwortet deshalb
 * der **Host der Base-URL** — er ist die einzige Angabe, die in beiden Fällen
 * stimmt.
 *
 * Bewusst eng gefasst: nur die Namen, die unstrittig auf denselben Rechner
 * zeigen. Ein privates Netz (10.x, 192.168.x) ist *nicht* lokal — dort steht
 * in aller Regel ein anderer, oft deutlich schnellerer Rechner, und eine
 * falsche Einstufung kostet dort entweder Verlauf oder Geduld.
 */
'use strict';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** Hostname einer Base-URL, ohne eckige Klammern der IPv6-Form. */
function endpointHost(baseUrl) {
  if (typeof baseUrl !== 'string') return '';
  const raw = baseUrl.trim();
  if (!raw) return '';
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch {
    host = '';
  }
  if (!host) {
    // Ohne Schema ist `localhost:1234/v1` fuer URL keine Adresse, sondern ein
    // eigenes Protokoll — dann steht der Host vorne im String.
    host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].split('@').pop() || '';
    host = host.replace(/:\d+$/, '');
  }
  return host.replace(/^\[|\]$/g, '').trim().toLowerCase();
}

/** true, wenn die Base-URL auf diesen Rechner zeigt (localhost, Loopback, *.local). */
function isLocalEndpoint(baseUrl) {
  const host = endpointHost(baseUrl);
  if (!host) return false;
  if (LOCAL_HOSTNAMES.has(host)) return true;
  // Das gesamte Loopback-Netz, nicht nur 127.0.0.1 — llama.cpp bindet
  // gelegentlich auf 127.0.0.2.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // mDNS-Namen (`mein-mac.local`) zeigen auf das eigene Netz; der Rechner
  // selbst meldet sich unter seinem eigenen .local-Namen.
  return host.endsWith('.local');
}

module.exports = {
  LOCAL_HOSTNAMES,
  endpointHost,
  isLocalEndpoint,
};
