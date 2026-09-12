'use strict';

/**
 * Seitenabruf ueber http(s) (Issue #95).
 *
 * Der Adapter haelt alles Netzseitige an einer Stelle: Adresspruefung vor
 * jedem Sprung, begrenzte Weiterleitungen, Zeit- und Groessengrenze, nur
 * Textinhalte. Der Tool-Handler sieht davon nichts — er bekommt Text oder
 * eine Fehlermeldung.
 */

const dns = require('node:dns').promises;
const { withRequestTimeout } = require('../services/request-timeout');
const { describeFetchError } = require('../../shared/runtime/fetch-errors');
const { parseHttpUrl, isBlockedHostname, isBlockedAddress } = require('../../shared/runtime/url-safety');
const { htmlToText, extractTitle } = require('../../shared/runtime/html-to-text');
const {
  URL_FETCH_ERROR_CODES,
  URL_FETCH_LIMITS,
  URL_FETCH_ALLOWED_CONTENT_TYPES,
} = require('../../application/ports/url-fetch-port');

const USER_AGENT = 'SnotraAI/1.0 (+https://github.com/kkrafft1999/snotra)';

function fail(code, error) {
  return { ok: false, code, error };
}

function clampMaxCharacters(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return URL_FETCH_LIMITS.DEFAULT_MAX_CHARS;
  return Math.min(URL_FETCH_LIMITS.MAX_MAX_CHARS, Math.max(500, Math.floor(value)));
}

function contentTypeOf(response) {
  const raw = response.headers?.get?.('content-type') || '';
  return String(raw).split(';')[0].trim().toLowerCase();
}

function charsetOf(response) {
  const raw = response.headers?.get?.('content-type') || '';
  const match = /charset=([^;]+)/i.exec(String(raw));
  const charset = match ? match[1].trim().replace(/["']/g, '').toLowerCase() : '';
  // Nur Kodierungen, die der TextDecoder sicher kennt; sonst UTF-8.
  return charset && charset !== 'utf-8' && charset !== 'utf8' ? charset : 'utf-8';
}

/**
 * Liest den Koerper bis zur Byte-Grenze und bricht danach ab. Ohne diese
 * Grenze koennte eine einzige Adresse den Speicher fuellen — `content-length`
 * allein genuegt nicht, weil der Server ihn weglassen oder luegen darf.
 */
async function readLimitedBody(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > URL_FETCH_LIMITS.MAX_BYTES) {
    return { tooLarge: true };
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > URL_FETCH_LIMITS.MAX_BYTES) return { tooLarge: true };
    return { buffer };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > URL_FETCH_LIMITS.MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return { buffer: Buffer.concat(chunks) };
}

/**
 * @param {Object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(hostname: string) => Promise<Array<{ address: string }>>} [deps.lookup]
 *   DNS-Aufloesung; in Tests ersetzt, damit kein Netz noetig ist.
 */
function createHttpUrlFetchAdapter({ fetchImpl = fetch, lookup = null } = {}) {
  const resolveHost = lookup || ((hostname) => dns.lookup(hostname, { all: true, verbatim: true }));

  /** Adresspruefung vor jedem einzelnen Sprung (auch nach Weiterleitungen). */
  async function checkAddress(url) {
    if (isBlockedHostname(url.hostname)) {
      return `Adresse „${url.hostname}" zeigt auf den eigenen Rechner oder das lokale Netz und wird nicht abgerufen.`;
    }
    let addresses;
    try {
      addresses = await resolveHost(url.hostname);
    } catch (error) {
      return `Der Name „${url.hostname}" konnte nicht aufgelöst werden (${error?.code || 'DNS-Fehler'}).`;
    }
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (list.length === 0) {
      return `Der Name „${url.hostname}" konnte nicht aufgelöst werden.`;
    }
    for (const entry of list) {
      const address = typeof entry === 'string' ? entry : entry?.address;
      if (isBlockedAddress(address)) {
        return `Adresse „${url.hostname}" zeigt auf ein privates oder lokales Netz (${address}) und wird nicht abgerufen.`;
      }
    }
    return null;
  }

  async function fetchUrl({ url: rawUrl, maxCharacters, abortSignal } = {}) {
    const parsed = parseHttpUrl(rawUrl);
    if (parsed.error) return fail(URL_FETCH_ERROR_CODES.INVALID_URL, parsed.error);

    const maxChars = clampMaxCharacters(maxCharacters);
    let current = parsed.url;

    try {
      return await withRequestTimeout(
        async (signal) => {
          for (let hop = 0; hop <= URL_FETCH_LIMITS.MAX_REDIRECTS; hop += 1) {
            const blocked = await checkAddress(current);
            if (blocked) return fail(URL_FETCH_ERROR_CODES.BLOCKED_ADDRESS, blocked);

            const response = await fetchImpl(current.toString(), {
              method: 'GET',
              redirect: 'manual',
              signal,
              headers: {
                accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1',
                'accept-language': 'de,en;q=0.8',
                'user-agent': USER_AGENT,
              },
            });

            // Weiterleitungen selbst verfolgen: nur so wird jedes Ziel erneut
            // gegen die Adressregeln geprueft (ein 302 auf 127.0.0.1 ist der
            // klassische Weg um eine einmalige Pruefung herum).
            if (response.status >= 300 && response.status < 400) {
              const location = response.headers?.get?.('location');
              if (!location) {
                return fail(
                  URL_FETCH_ERROR_CODES.SERVICE,
                  `Die Seite antwortete mit HTTP ${response.status} ohne Zieladresse.`
                );
              }
              let next;
              try {
                next = new URL(location, current);
              } catch {
                return fail(URL_FETCH_ERROR_CODES.INVALID_URL, `Die Weiterleitung nach „${location}" ist keine gültige Adresse.`);
              }
              const allowed = parseHttpUrl(next.toString());
              if (allowed.error) return fail(URL_FETCH_ERROR_CODES.BLOCKED_ADDRESS, allowed.error);
              current = allowed.url;
              continue;
            }

            if (!response.ok) {
              return fail(
                URL_FETCH_ERROR_CODES.SERVICE,
                `Die Seite konnte nicht gelesen werden: HTTP ${response.status}.`
              );
            }

            const contentType = contentTypeOf(response);
            if (contentType && !URL_FETCH_ALLOWED_CONTENT_TYPES.includes(contentType)) {
              return fail(
                URL_FETCH_ERROR_CODES.UNSUPPORTED_CONTENT,
                `Die Adresse liefert „${contentType}" — gelesen werden nur Textinhalte (HTML, Text, Markdown, JSON).`
              );
            }

            const body = await readLimitedBody(response);
            if (body.tooLarge) {
              return fail(
                URL_FETCH_ERROR_CODES.TOO_LARGE,
                `Die Seite ist größer als ${Math.round(URL_FETCH_LIMITS.MAX_BYTES / (1024 * 1024))} MB und wird nicht gelesen.`
              );
            }

            let decoded;
            try {
              decoded = new TextDecoder(charsetOf(response)).decode(body.buffer);
            } catch {
              decoded = body.buffer.toString('utf8');
            }

            const isHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml' || !contentType;
            const title = isHtml ? extractTitle(decoded) : '';
            const text = isHtml ? htmlToText(decoded) : decoded.trim();
            const truncated = text.length > maxChars;
            const out = {
              ok: true,
              url: current.toString(),
              text: truncated ? `${text.slice(0, maxChars)}\n… [gekürzt]` : text,
              truncated,
            };
            if (title) out.title = title;
            return out;
          }
          return fail(
            URL_FETCH_ERROR_CODES.TOO_MANY_REDIRECTS,
            `Die Adresse leitet mehr als ${URL_FETCH_LIMITS.MAX_REDIRECTS} Mal weiter.`
          );
        },
        { timeoutMs: URL_FETCH_LIMITS.TIMEOUT_MS, signal: abortSignal }
      );
    } catch (error) {
      // Ein Abbruch durch den Nutzer gehoert der Engine, nicht dem Tool.
      if (abortSignal?.aborted) throw error;
      return fail(URL_FETCH_ERROR_CODES.NETWORK, describeFetchError(error, current.toString()));
    }
  }

  return { fetchUrl };
}

module.exports = { createHttpUrlFetchAdapter };
