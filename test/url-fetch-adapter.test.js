const test = require('node:test');
const assert = require('node:assert/strict');
const { createHttpUrlFetchAdapter } = require('../src/main/adapters/http-url-fetch-adapter');
const { URL_FETCH_ERROR_CODES, URL_FETCH_LIMITS } = require('../src/application/ports/url-fetch-port');

// Issue #95: alle Tests ohne Netz. `fetchImpl` und die Namensauflösung sind
// eingesetzt, damit auch Weiterleitungen und gesperrte Ziele prüfbar sind.

function makeResponse({ status = 200, headers = {}, body = '' } = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    async arrayBuffer() {
      return Buffer.from(body, 'utf8');
    },
  };
}

function htmlResponse(body, extra = {}) {
  return makeResponse({ headers: { 'content-type': 'text/html; charset=utf-8' }, body, ...extra });
}

/** Standard: jeder Name löst auf eine öffentliche Adresse auf. */
function publicLookup() {
  return async () => [{ address: '93.184.216.34' }];
}

function makeAdapter(responses, { lookup = publicLookup() } = {}) {
  const requests = [];
  const list = Array.isArray(responses) ? [...responses] : [responses];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const next = list.length > 1 ? list.shift() : list[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url) : next;
  };
  return { adapter: createHttpUrlFetchAdapter({ fetchImpl, lookup }), requests };
}

test('fetch_url-Adapter liefert Titel und lesbaren Text statt HTML', async () => {
  const { adapter, requests } = makeAdapter(
    htmlResponse(`
      <html><head><title>Snotra &amp; Co</title><style>body{color:red}</style></head>
      <body><script>alert(1)</script><h1>Überschrift</h1><p>Erster Absatz.</p>
      <ul><li>Punkt A</li><li>Punkt B</li></ul></body></html>`)
  );

  const result = await adapter.fetchUrl({ url: 'https://example.org/seite' });

  assert.equal(result.ok, true);
  assert.equal(result.title, 'Snotra & Co');
  assert.equal(result.url, 'https://example.org/seite');
  assert.match(result.text, /# Überschrift/);
  assert.match(result.text, /Erster Absatz\./);
  assert.match(result.text, /- Punkt A/);
  assert.doesNotMatch(result.text, /<p>|<script|alert\(1\)|color:red/);
  assert.equal(result.truncated, false);
  assert.equal(requests[0].options.redirect, 'manual');
});

test('fetch_url-Adapter kürzt auf max_characters', async () => {
  const { adapter } = makeAdapter(htmlResponse(`<p>${'a'.repeat(5000)}</p>`));

  const result = await adapter.fetchUrl({ url: 'https://example.org', maxCharacters: 500 });

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.match(result.text, /\[gekürzt\]$/);
  assert.ok(result.text.length < 600, 'gekürzter Text bleibt nahe an der Grenze');
});

test('fetch_url-Adapter deckelt eine übergroße Zeichenangabe des Modells', async () => {
  const long = 'b'.repeat(URL_FETCH_LIMITS.MAX_MAX_CHARS + 5000);
  const { adapter } = makeAdapter(htmlResponse(`<p>${long}</p>`));

  const result = await adapter.fetchUrl({ url: 'https://example.org', maxCharacters: 10_000_000 });

  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= URL_FETCH_LIMITS.MAX_MAX_CHARS + 20);
});

test('fetch_url-Adapter folgt einer Weiterleitung und meldet die Zieladresse', async () => {
  const { adapter } = makeAdapter([
    makeResponse({ status: 301, headers: { location: '/neu' } }),
    htmlResponse('<p>Angekommen.</p>'),
  ]);

  const result = await adapter.fetchUrl({ url: 'https://example.org/alt' });

  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://example.org/neu');
  assert.match(result.text, /Angekommen\./);
});

test('fetch_url-Adapter stoppt eine Weiterleitung auf eine private Adresse (#95)', async () => {
  let call = 0;
  const lookup = async (hostname) => {
    call += 1;
    // Erst öffentlich, nach der Weiterleitung zeigt der Name ins lokale Netz.
    return hostname === 'intern.example.org' ? [{ address: '192.168.1.10' }] : [{ address: '93.184.216.34' }];
  };
  const { adapter, requests } = makeAdapter(
    [
      makeResponse({ status: 302, headers: { location: 'http://intern.example.org/admin' } }),
      htmlResponse('<p>geheim</p>'),
    ],
    { lookup }
  );

  const result = await adapter.fetchUrl({ url: 'https://example.org/start' });

  assert.equal(result.ok, false);
  assert.equal(result.code, URL_FETCH_ERROR_CODES.BLOCKED_ADDRESS);
  assert.match(result.error, /privates oder lokales Netz \(192\.168\.1\.10\)/);
  assert.equal(requests.length, 1, 'das interne Ziel wird gar nicht erst abgerufen');
  assert.ok(call >= 2);
});

test('fetch_url-Adapter ruft localhost auch ohne Auflösung nicht ab', async () => {
  const { adapter, requests } = makeAdapter(htmlResponse('<p>x</p>'), {
    lookup: async () => {
      throw new Error('DNS darf hier nicht gefragt werden');
    },
  });

  for (const url of ['http://localhost:11434/api', 'http://127.0.0.1/', 'http://[::1]/', 'http://nas.local/']) {
    const result = await adapter.fetchUrl({ url });
    assert.equal(result.ok, false, url);
    assert.equal(result.code, URL_FETCH_ERROR_CODES.BLOCKED_ADDRESS, url);
  }
  assert.equal(requests.length, 0);
});

test('fetch_url-Adapter lehnt fremde Schemata und Zugangsdaten ab', async () => {
  const { adapter, requests } = makeAdapter(htmlResponse('<p>x</p>'));

  const file = await adapter.fetchUrl({ url: 'file:///etc/passwd' });
  assert.equal(file.code, URL_FETCH_ERROR_CODES.INVALID_URL);

  const creds = await adapter.fetchUrl({ url: 'https://user:pw@example.org/' });
  assert.equal(creds.code, URL_FETCH_ERROR_CODES.INVALID_URL);

  assert.equal(requests.length, 0);
});

test('fetch_url-Adapter bricht nach zu vielen Weiterleitungen ab', async () => {
  const { adapter } = makeAdapter(makeResponse({ status: 302, headers: { location: '/weiter' } }));

  const result = await adapter.fetchUrl({ url: 'https://example.org/' });

  assert.equal(result.code, URL_FETCH_ERROR_CODES.TOO_MANY_REDIRECTS);
  assert.match(result.error, /mehr als 3 Mal/);
});

test('fetch_url-Adapter lehnt alles ab, was kein Text ist', async () => {
  const { adapter } = makeAdapter(
    makeResponse({ headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.7' })
  );

  const result = await adapter.fetchUrl({ url: 'https://example.org/handbuch.pdf' });

  assert.equal(result.code, URL_FETCH_ERROR_CODES.UNSUPPORTED_CONTENT);
  assert.match(result.error, /application\/pdf/);
});

test('fetch_url-Adapter nimmt Klartext und JSON unverändert an', async () => {
  const { adapter } = makeAdapter(
    makeResponse({ headers: { 'content-type': 'application/json' }, body: '{"version":"1.5.0"}' })
  );

  const result = await adapter.fetchUrl({ url: 'https://example.org/api' });

  assert.equal(result.ok, true);
  assert.equal(result.text, '{"version":"1.5.0"}');
  assert.equal(result.title, undefined);
});

test('fetch_url-Adapter weist eine zu große Seite über content-length ab', async () => {
  const { adapter } = makeAdapter(
    makeResponse({
      headers: { 'content-type': 'text/html', 'content-length': String(URL_FETCH_LIMITS.MAX_BYTES + 1) },
      body: 'x',
    })
  );

  const result = await adapter.fetchUrl({ url: 'https://example.org/gross' });

  assert.equal(result.code, URL_FETCH_ERROR_CODES.TOO_LARGE);
});

test('fetch_url-Adapter meldet HTTP-Fehler und Netzprobleme als Ergebnis', async () => {
  const { adapter: notFound } = makeAdapter(makeResponse({ status: 404 }));
  const missing = await notFound.fetchUrl({ url: 'https://example.org/weg' });
  assert.equal(missing.code, URL_FETCH_ERROR_CODES.SERVICE);
  assert.match(missing.error, /HTTP 404/);

  const { adapter: broken } = makeAdapter(new Error('socket hang up'));
  const failed = await broken.fetchUrl({ url: 'https://example.org/' });
  assert.equal(failed.code, URL_FETCH_ERROR_CODES.NETWORK);
  assert.match(failed.error, /socket hang up/);
});

test('fetch_url-Adapter meldet einen unauflösbaren Namen als Ergebnis', async () => {
  const { adapter } = makeAdapter(htmlResponse('<p>x</p>'), {
    lookup: async () => {
      const error = new Error('getaddrinfo ENOTFOUND');
      error.code = 'ENOTFOUND';
      throw error;
    },
  });

  const result = await adapter.fetchUrl({ url: 'https://gibtesnicht.example/' });

  assert.equal(result.code, URL_FETCH_ERROR_CODES.BLOCKED_ADDRESS);
  assert.match(result.error, /ENOTFOUND/);
});
