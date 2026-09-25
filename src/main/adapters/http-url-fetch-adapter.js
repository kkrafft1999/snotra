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
/**
 * Which language version of a page to ask for (#338). Not a sentence we write,
 * but it decides the language of what the model reads and quotes: a site that
 * negotiates serves the user's language, so the header follows the interface.
 * German keeps English as its fallback, as it always had.
 */
function acceptLanguageFor(locale) {
  return locale === 'de' ? 'de,en;q=0.8' : 'en,*;q=0.5';
}

function createHttpUrlFetchAdapter({ fetchImpl = fetch, lookup = null, getLocale = () => 'en' } = {}) {
  const resolveHost = lookup || ((hostname) => dns.lookup(hostname, { all: true, verbatim: true }));

  /** Adresspruefung vor jedem einzelnen Sprung (auch nach Weiterleitungen). */
  async function checkAddress(url) {
    if (isBlockedHostname(url.hostname)) {
      return `The address "${url.hostname}" points to this computer or the local network and is not fetched.`;
    }
    let addresses;
    try {
      addresses = await resolveHost(url.hostname);
    } catch (error) {
      return `The name "${url.hostname}" could not be resolved (${error?.code || 'DNS error'}).`;
    }
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (list.length === 0) {
      return `The name "${url.hostname}" could not be resolved.`;
    }
    for (const entry of list) {
      const address = typeof entry === 'string' ? entry : entry?.address;
      if (isBlockedAddress(address)) {
        return `The address "${url.hostname}" points to a private or local network (${address}) and is not fetched.`;
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
                'accept-language': acceptLanguageFor(getLocale()),
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
                  `The page answered with HTTP ${response.status} but no redirect location.`
                );
              }
              let next;
              try {
                next = new URL(location, current);
              } catch {
                return fail(URL_FETCH_ERROR_CODES.INVALID_URL, `The redirect target "${location}" is not a valid address.`);
              }
              const allowed = parseHttpUrl(next.toString());
              if (allowed.error) return fail(URL_FETCH_ERROR_CODES.BLOCKED_ADDRESS, allowed.error);
              current = allowed.url;
              continue;
            }

            if (!response.ok) {
              return fail(
                URL_FETCH_ERROR_CODES.SERVICE,
                `The page could not be read: HTTP ${response.status}.`
              );
            }

            const contentType = contentTypeOf(response);
            if (contentType && !URL_FETCH_ALLOWED_CONTENT_TYPES.includes(contentType)) {
              return fail(
                URL_FETCH_ERROR_CODES.UNSUPPORTED_CONTENT,
                `The address returns "${contentType}" — only text content is read (HTML, plain text, Markdown, JSON).`
              );
            }

            const body = await readLimitedBody(response);
            if (body.tooLarge) {
              return fail(
                URL_FETCH_ERROR_CODES.TOO_LARGE,
                `The page is larger than ${Math.round(URL_FETCH_LIMITS.MAX_BYTES / (1024 * 1024))} MB and is not read.`
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
              text: truncated ? `${text.slice(0, maxChars)}\n… [truncated]` : text,
              truncated,
            };
            if (title) out.title = title;
            return out;
          }
          return fail(
            URL_FETCH_ERROR_CODES.TOO_MANY_REDIRECTS,
            `The address redirects more than ${URL_FETCH_LIMITS.MAX_REDIRECTS} times.`
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
