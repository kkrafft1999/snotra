'use strict';

/**
 * Web-Suche ueber Tavily (Issue #63).
 *
 * Anbieterentscheidung vom 2026-09-07, gemessen an den fuenf Kriterien des
 * Issues: providerneutral (eigener Dienst, unabhaengig vom LLM-Anbieter, also
 * auch mit lokalem Ollama nutzbar), ein einzelner API-Key, Free-Tier ohne
 * Zahlungsdaten, und — der Ausschlag — eine Antwort, die schon in
 * Agenten-Form kommt: Titel, URL und ein kurzer Auszug je Treffer statt einer
 * reinen Linkliste, die erst nachgeladen werden muesste.
 *
 * Alles Tavily-Spezifische bleibt in dieser Datei. Ein Anbieterwechsel
 * tauscht den Adapter, nicht den Tool-Handler.
 */

const { withRequestTimeout } = require('../services/request-timeout');
const { WEB_SEARCH_ERROR_CODES, WEB_SEARCH_LIMITS } = require('../../application/ports/web-search-port');

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const SEARCH_TIMEOUT_MS = 20_000;

function clampMaxResults(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return WEB_SEARCH_LIMITS.DEFAULT_MAX_RESULTS;
  return Math.min(WEB_SEARCH_LIMITS.MAX_MAX_RESULTS, Math.max(1, Math.floor(value)));
}

function clampSnippet(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= WEB_SEARCH_LIMITS.MAX_SNIPPET_CHARS) return text;
  return `${text.slice(0, WEB_SEARCH_LIMITS.MAX_SNIPPET_CHARS - 1)}…`;
}

/** Nur http/https — ein Treffer soll nichts anderes in den Chat tragen. */
function isHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function toResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isHttpUrl(raw.url)) return null;
  const out = {
    title: String(raw.title ?? '').replace(/\s+/g, ' ').trim() || raw.url.trim(),
    url: raw.url.trim(),
    snippet: clampSnippet(raw.content),
  };
  const published = typeof raw.published_date === 'string' ? raw.published_date.trim() : '';
  if (published) out.publishedAt = published;
  return out;
}

function errorForStatus(status, body) {
  if (status === 401 || status === 403) {
    return {
      code: WEB_SEARCH_ERROR_CODES.UNAUTHORIZED,
      error: 'Der Tavily-Schlüssel wurde abgelehnt. Bitte unter Einstellungen › Tools prüfen.',
    };
  }
  if (status === 429) {
    return {
      code: WEB_SEARCH_ERROR_CODES.RATE_LIMITED,
      error: 'Das Suchkontingent bei Tavily ist vorerst erschöpft. Später erneut versuchen.',
    };
  }
  const detail = typeof body === 'string' && body.trim() ? ` (${body.trim().slice(0, 200)})` : '';
  return {
    code: WEB_SEARCH_ERROR_CODES.SERVICE,
    error: `Die Suche ist fehlgeschlagen: HTTP ${status}${detail}.`,
  };
}

/**
 * @param {Object} deps
 * @param {() => Promise<string|null>} deps.readApiKey  liest den entschluesselten Schluessel
 * @param {() => boolean} deps.hasApiKey  synchroner Stand fuer die Tool-Sichtbarkeit
 * @param {typeof fetch} [deps.fetchImpl]
 */
function createTavilyWebSearchAdapter({ readApiKey, hasApiKey, fetchImpl = fetch }) {
  return {
    isConfigured() {
      return hasApiKey() === true;
    },

    async search({ query, maxResults, language, abortSignal } = {}) {
      const text = typeof query === 'string' ? query.trim() : '';
      if (!text) {
        return {
          ok: false,
          code: WEB_SEARCH_ERROR_CODES.INVALID_QUERY,
          error: 'Es wurde keine Suchanfrage übergeben.',
        };
      }
      if (text.length > WEB_SEARCH_LIMITS.MAX_QUERY_CHARS) {
        return {
          ok: false,
          code: WEB_SEARCH_ERROR_CODES.INVALID_QUERY,
          error: `Die Suchanfrage ist länger als ${WEB_SEARCH_LIMITS.MAX_QUERY_CHARS} Zeichen.`,
        };
      }

      const apiKey = await readApiKey();
      if (!apiKey) {
        return {
          ok: false,
          code: WEB_SEARCH_ERROR_CODES.NO_API_KEY,
          error: 'Für die Websuche ist kein Tavily-Schlüssel hinterlegt (Einstellungen › Tools).',
        };
      }

      const body = {
        query: text,
        max_results: clampMaxResults(maxResults),
        search_depth: 'basic',
        include_answer: true,
      };
      // Tavily nimmt einen Sprach-/Regionshinweis nur als Teil der Anfrage
      // entgegen; ein eigenes Feld dafuer gibt es nicht.
      const lang = typeof language === 'string' ? language.trim().slice(0, 16) : '';
      if (lang) body.query = `${text} (Sprache: ${lang})`;

      let response;
      try {
        response = await withRequestTimeout(
          (signal) =>
            fetchImpl(TAVILY_ENDPOINT, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(body),
              signal,
            }),
          { timeoutMs: SEARCH_TIMEOUT_MS, signal: abortSignal },
        );
      } catch (e) {
        return {
          ok: false,
          code: WEB_SEARCH_ERROR_CODES.NETWORK,
          error: e?.message || 'Die Suche konnte nicht erreicht werden.',
        };
      }

      if (!response?.ok) {
        let detail = '';
        try {
          detail = await response.text();
        } catch {
          /* Antwortkoerper ist entbehrlich */
        }
        return { ok: false, ...errorForStatus(response?.status ?? 0, detail) };
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        return {
          ok: false,
          code: WEB_SEARCH_ERROR_CODES.SERVICE,
          error: 'Die Antwort der Suche war nicht lesbar.',
        };
      }

      const results = (Array.isArray(payload?.results) ? payload.results : [])
        .map(toResult)
        .filter(Boolean)
        .slice(0, clampMaxResults(maxResults));

      const out = { ok: true, query: text, results };
      const answer = typeof payload?.answer === 'string' ? payload.answer.trim() : '';
      if (answer) out.answer = clampSnippet(answer);
      return out;
    },
  };
}

module.exports = { createTavilyWebSearchAdapter, TAVILY_ENDPOINT };
