// Web-Such-Adapter (Issue #63). Kein Netzzugriff: fetch wird durchgereicht.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTavilyWebSearchAdapter, TAVILY_ENDPOINT } = require('../src/main/adapters/tavily-web-search-adapter');
const { WEB_SEARCH_ERROR_CODES, WEB_SEARCH_LIMITS } = require('../src/application/ports/web-search-port');

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function setup({ apiKey = 'tvly-test', response, fetchImpl } = {}) {
  const calls = [];
  const adapter = createTavilyWebSearchAdapter({
    readApiKey: async () => apiKey,
    hasApiKey: () => !!apiKey,
    fetchImpl: fetchImpl || (async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return response || jsonResponse({ results: [] });
    }),
  });
  return { adapter, calls };
}

test('isConfigured spiegelt den gemerkten Schlüsselstand', () => {
  assert.equal(setup({ apiKey: 'tvly-x' }).adapter.isConfigured(), true);
  assert.equal(setup({ apiKey: '' }).adapter.isConfigured(), false);
});

test('search liefert Titel, URL, Auszug und Datum je Treffer', async () => {
  const { adapter, calls } = setup({
    response: jsonResponse({
      answer: 'Kurzantwort.',
      results: [
        {
          title: '  Electron  40   Release ',
          url: 'https://example.com/a',
          content: 'Ein  Auszug\nmit Umbruch.',
          published_date: '2026-09-01',
        },
      ],
    }),
  });

  const result = await adapter.search({ query: 'Electron 40', maxResults: 3 });

  assert.equal(result.ok, true);
  assert.equal(result.query, 'Electron 40');
  assert.equal(result.answer, 'Kurzantwort.');
  assert.deepEqual(result.results, [
    {
      title: 'Electron 40 Release',
      url: 'https://example.com/a',
      snippet: 'Ein Auszug mit Umbruch.',
      publishedAt: '2026-09-01',
    },
  ]);
  assert.equal(calls[0].url, TAVILY_ENDPOINT);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tvly-test');
  assert.equal(calls[0].body.max_results, 3);
});

test('search gibt keine Treffer als gültiges Ergebnis zurück, nicht als Fehler', async () => {
  const { adapter } = setup({ response: jsonResponse({ results: [] }) });

  const result = await adapter.search({ query: 'gibtesnicht' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, []);
});

test('search wirft Treffer mit fremden Protokollen weg', async () => {
  const { adapter } = setup({
    response: jsonResponse({
      results: [
        { title: 'ok', url: 'https://example.com/a', content: 'x' },
        { title: 'boes', url: 'javascript:alert(1)', content: 'x' },
        { title: 'datei', url: 'file:///etc/passwd', content: 'x' },
        { title: 'kaputt', url: 'keine url', content: 'x' },
      ],
    }),
  });

  const result = await adapter.search({ query: 'x' });
  assert.deepEqual(result.results.map((r) => r.url), ['https://example.com/a']);
});

test('search deckelt max_results und die Länge der Auszüge', async () => {
  const { adapter, calls } = setup({
    response: jsonResponse({
      results: [{ title: 't', url: 'https://example.com/a', content: 'x'.repeat(5000) }],
    }),
  });

  const result = await adapter.search({ query: 'x', maxResults: 999 });
  assert.equal(calls[0].body.max_results, WEB_SEARCH_LIMITS.MAX_MAX_RESULTS);
  assert.equal(result.results[0].snippet.length, WEB_SEARCH_LIMITS.MAX_SNIPPET_CHARS);
});

test('search meldet einen fehlenden Schlüssel, statt zu senden', async () => {
  let called = false;
  const adapter = createTavilyWebSearchAdapter({
    readApiKey: async () => null,
    hasApiKey: () => false,
    fetchImpl: async () => { called = true; return jsonResponse({}); },
  });

  const result = await adapter.search({ query: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB_SEARCH_ERROR_CODES.NO_API_KEY);
  assert.equal(called, false);
});

test('search weist leere und überlange Anfragen ab', async () => {
  const { adapter, calls } = setup();

  for (const query of ['', '   ', null, undefined, 'x'.repeat(WEB_SEARCH_LIMITS.MAX_QUERY_CHARS + 1)]) {
    const result = await adapter.search({ query });
    assert.equal(result.ok, false, String(query).slice(0, 20));
    assert.equal(result.code, WEB_SEARCH_ERROR_CODES.INVALID_QUERY);
  }
  assert.equal(calls.length, 0);
});

test('search unterscheidet abgelehnten Schlüssel, Rate-Limit und sonstige Fehler', async () => {
  const cases = [
    [401, WEB_SEARCH_ERROR_CODES.UNAUTHORIZED],
    [403, WEB_SEARCH_ERROR_CODES.UNAUTHORIZED],
    [429, WEB_SEARCH_ERROR_CODES.RATE_LIMITED],
    [500, WEB_SEARCH_ERROR_CODES.SERVICE],
  ];
  for (const [status, code] of cases) {
    const { adapter } = setup({ response: jsonResponse({ detail: 'nope' }, { status }) });
    const result = await adapter.search({ query: 'x' });
    assert.equal(result.ok, false, String(status));
    assert.equal(result.code, code, String(status));
    assert.ok(result.error.length > 10);
  }
});

test('search meldet einen Netzfehler als Ergebnis, nicht als Ausnahme', async () => {
  const { adapter } = setup({
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });

  const result = await adapter.search({ query: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB_SEARCH_ERROR_CODES.NETWORK);
  assert.match(result.error, /ENOTFOUND/);
});

test('search meldet eine unlesbare Antwort als Dienstfehler', async () => {
  const { adapter } = setup({
    response: {
      ok: true,
      status: 200,
      async json() { throw new Error('kein JSON'); },
      async text() { return ''; },
    },
  });

  const result = await adapter.search({ query: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.code, WEB_SEARCH_ERROR_CODES.SERVICE);
});
