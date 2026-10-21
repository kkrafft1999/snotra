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
const { Agent } = require('undici');
const { fetchVia } = require('../services/dispatcher-fetch');
const { withRequestTimeout } = require('../services/request-timeout');
const { describeFetchError } = require('../../shared/runtime/fetch-errors');
const { parseHttpUrl, isBlockedHostname, isBlockedAddress } = require('../../shared/runtime/url-safety');
const { htmlToText, extractTitle } = require('../../shared/runtime/html-to-text');
const { DEFAULT_LOCALE, normalizeLocale } = require('../../shared/i18n');
const { isRecord } = require('../../shared/runtime/is-record');
const {
  URL_FETCH_ERROR_CODES,
  URL_FETCH_LIMITS,
  URL_FETCH_ALLOWED_CONTENT_TYPES,
} = require('../../shared/contracts/url-fetch');

const USER_AGENT = 'SnotraAgent/1.0 (+https://github.com/kkrafft1999/snotra)';

/**
 * What a name resolves to: `dns.lookup(…, { all: true })` gives a list of
 * `{ address }`; a replacement in a test may give less.
 * @typedef {Array<{ address: string } | string> | { address: string } | string} ResolvedAnswer
 * @typedef {(hostname: string) => Promise<ResolvedAnswer>} ResolveHost
 *
 * The callback of `net.connect`'s `lookup` option.
 * @typedef {(error: Error | null, address: string | Array<{ address: string, family: number }>, family?: number) => void} LookupCallback
 */

/**
 * @param {string} code
 * @param {string} error
 * @returns {import('../../application/ports/url-fetch-port').UrlFetchError}
 */
function fail(code, error) {
  return { ok: false, code, error };
}

/** @param {unknown} raw */
function clampMaxCharacters(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return URL_FETCH_LIMITS.DEFAULT_MAX_CHARS;
  return Math.min(URL_FETCH_LIMITS.MAX_MAX_CHARS, Math.max(500, Math.floor(value)));
}

/** @param {Response} response */
function contentTypeOf(response) {
  const raw = response.headers?.get?.('content-type') || '';
  return String(raw).split(';')[0].trim().toLowerCase();
}

/** @param {Response} response */
function charsetOf(response) {
  const raw = response.headers?.get?.('content-type') || '';
  const match = /charset=([^;]+)/i.exec(String(raw));
  const charset = match ? match[1].trim().replace(/["']/g, '').toLowerCase() : '';
  // Nur Kodierungen, die der TextDecoder sicher kennt; sonst UTF-8.
  return charset && charset !== 'utf-8' && charset !== 'utf8' ? charset : 'utf-8';
}

/**
 * Lets go of a body that is not read (#555): undici holds the connection until
 * the body is consumed or collected, so a redirect or an error answer would
 * otherwise keep its socket for an unknown time.
 *
 * @param {Response} response
 */
function discardBody(response) {
  try {
    const pending = response?.body?.cancel?.();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {
    /* a body that cannot be cancelled is left to the garbage collector */
  }
}

/**
 * Liest den Koerper bis zur Byte-Grenze und bricht danach ab. Ohne diese
 * Grenze koennte eine einzige Adresse den Speicher fuellen — `content-length`
 * allein genuegt nicht, weil der Server ihn weglassen oder luegen darf.
 *
 * @param {Response} response
 * @returns {Promise<{ tooLarge: true, buffer?: undefined } | { tooLarge?: undefined, buffer: Buffer }>}
 */
async function readLimitedBody(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > URL_FETCH_LIMITS.MAX_BYTES) {
    discardBody(response);
    return { tooLarge: true };
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > URL_FETCH_LIMITS.MAX_BYTES) return { tooLarge: true };
    return { buffer };
  }
  const reader = response.body.getReader();
  /** @type {Buffer[]} */
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
 * Which language version of a page to ask for (#338). Not a sentence we write,
 * but it decides the language of what the model reads and quotes: a site that
 * negotiates serves the user's language, so the header follows the interface.
 * German keeps English as its fallback, as it always had.
 *
 * @param {unknown} locale
 */
function acceptLanguageFor(locale) {
  const language = normalizeLocale(locale);
  return language === DEFAULT_LOCALE ? `${DEFAULT_LOCALE},*;q=0.5` : `${language},${DEFAULT_LOCALE};q=0.8`;
}

/** The cause a connection refused by the address check carries (#554). */
const BLOCKED_AT_CONNECT = 'ESNOTRABLOCKEDADDRESS';

/** @param {string} address */
function familyOf(address) {
  return address.includes(':') ? 6 : 4;
}

/**
 * Name resolution for the moment of connecting, in the shape `net.connect`
 * expects of its `lookup` option (#554).
 *
 * The check before the request resolves the name once; `fetch` would resolve
 * it a second time, and between the two the answer can change (DNS
 * rebinding): public for the check, `127.0.0.1` for the connection. Here the
 * connection gets exactly the addresses that passed the check — every one of
 * them, because the socket may try any of them.
 *
 * @param {ResolveHost} resolveHost
 * @returns {(hostname: string, options: { family?: number | string, all?: boolean } | LookupCallback, callback?: LookupCallback) => void}
 */
function createGuardedLookup(resolveHost) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    if (typeof done !== 'function') throw new TypeError('lookup needs a callback');
    const opts = typeof options === 'object' && options !== null ? options : {};
    Promise.resolve()
      .then(() => resolveHost(hostname))
      .then(
        (answer) => {
          const list = (Array.isArray(answer) ? answer : [answer])
            .map((entry) => (typeof entry === 'string' ? entry : entry?.address))
            .filter((address) => typeof address === 'string' && address)
            .map((address) => ({ address, family: familyOf(address) }))
            .filter((entry) => opts.family !== 4 && opts.family !== 6 ? true : entry.family === opts.family);
          if (list.length === 0) {
            return { error: Object.assign(new Error(`The name "${hostname}" could not be resolved.`), { code: 'ENOTFOUND' }) };
          }
          const blocked = list.find((entry) => isBlockedAddress(entry.address));
          if (blocked) {
            return {
              error: Object.assign(
                new Error(`The address "${hostname}" points to a private or local network (${blocked.address}) and is not fetched.`),
                { code: BLOCKED_AT_CONNECT }
              ),
            };
          }
          return { list };
        },
        (error) => ({ error })
      )
      .then((/** @type {{ error: Error, list?: undefined } | { error?: undefined, list: Array<{ address: string, family: number }> }} */ { error, list }) => {
        // On an error `net` looks at nothing but the error; the address is only there for the type.
        if (error) done(error, []);
        else if (opts.all) done(null, list);
        else done(null, list[0].address, list[0].family);
      });
  };
}

/**
 * The message of the refusal at connect time, wherever in the `cause` chain it sits.
 * @param {unknown} error
 * @returns {string|null}
 */
function blockedAtConnect(error) {
  /** @type {unknown} */
  let current = error;
  while (isRecord(current)) {
    if (current.code === BLOCKED_AT_CONNECT) return String(current.message);
    current = current.cause;
  }
  return null;
}

/**
 * @param {{
 *   fetchImpl?: typeof fetchVia,
 *   lookup?: ResolveHost|null,
 *   getLocale?: () => string,
 * }} [deps]  `lookup` is the DNS resolution; tests replace it, so no network is needed
 * @returns {import('../../application/ports/url-fetch-port').UrlFetchPort}
 */
function createHttpUrlFetchAdapter({ fetchImpl = fetchVia, lookup = null, getLocale = () => DEFAULT_LOCALE } = {}) {
  const resolveHost = lookup || ((hostname) => dns.lookup(hostname, { all: true, verbatim: true }));
  // Built on first use: a connection only to addresses that pass the check.
  /** @type {InstanceType<typeof Agent>|null} */
  let dispatcher = null;
  const guardedDispatcher = () => {
    if (!dispatcher) dispatcher = new Agent({ connect: { lookup: createGuardedLookup(resolveHost) } });
    return dispatcher;
  };

  /**
   * Adresspruefung vor jedem einzelnen Sprung (auch nach Weiterleitungen).
   * @param {URL} url
   * @returns {Promise<string|null>}
   */
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

  /**
   * Every field is checked here, so a request may come without any.
   * @param {Partial<Parameters<import('../../application/ports/url-fetch-port').UrlFetchPort['fetchUrl']>[0]>} [request]
   */
  async function fetchUrl({ url: rawUrl, maxCharacters, abortSignal } = {}) {
    const parsed = parseHttpUrl(rawUrl);
    if (parsed.error !== undefined) return fail(URL_FETCH_ERROR_CODES.INVALID_URL, parsed.error);

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
              dispatcher: guardedDispatcher(),
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
              discardBody(response);
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
              if (allowed.error !== undefined) return fail(URL_FETCH_ERROR_CODES.BLOCKED_ADDRESS, allowed.error);
              current = allowed.url;
              continue;
            }

            if (!response.ok) {
              discardBody(response);
              return fail(
                URL_FETCH_ERROR_CODES.SERVICE,
                `The page could not be read: HTTP ${response.status}.`
              );
            }

            const contentType = contentTypeOf(response);
            if (contentType && !URL_FETCH_ALLOWED_CONTENT_TYPES.includes(contentType)) {
              discardBody(response);
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
            /** @type {import('../../application/ports/url-fetch-port').UrlFetchOk} */
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
      const blocked = blockedAtConnect(error);
      if (blocked !== null) return fail(URL_FETCH_ERROR_CODES.BLOCKED_ADDRESS, blocked);
      return fail(URL_FETCH_ERROR_CODES.NETWORK, describeFetchError(error, current.toString()));
    }
  }

  return { fetchUrl };
}

module.exports = { createHttpUrlFetchAdapter, createGuardedLookup };
