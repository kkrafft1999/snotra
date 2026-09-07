// Tool web_search in der Registry (Issue #63). Der Adapter ist gemockt —
// im Testlauf geht nichts ins Netz.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { summarizeToolCall } = require('../src/shared/presentation/tool-display');

function makeRegistry({ configured = true, search } = {}) {
  const calls = [];
  const registry = createWorkspaceToolRegistry({
    fsService: {},
    webSearch: {
      isConfigured: () => configured,
      async search(request) {
        calls.push(request);
        if (search) return search(request);
        return { ok: true, query: request.query, results: [] };
      },
    },
  });
  return { registry, calls };
}

function run(registry, args, context = {}) {
  return registry.execute('web_search', args, { approved: true, ...context });
}

test('web_search erscheint dem Modell nur mit hinterlegtem Schlüssel', () => {
  const ohne = makeRegistry({ configured: false }).registry;
  const mit = makeRegistry({ configured: true }).registry;

  const names = (r) => r.getTools().map((t) => t.function.name);
  assert.equal(names(ohne).includes('web_search'), false);
  assert.equal(names(mit).includes('web_search'), true);

  // Im System-Prompt taucht es entsprechend auch nur mit Schlüssel auf.
  assert.equal(ohne.buildSystemPrompt().includes('web_search'), false);
  assert.match(mit.buildSystemPrompt(), /web_search/);
});

test('web_search steht im Katalog der Einstellungen, auch ohne Schlüssel', () => {
  const { registry } = makeRegistry({ configured: false });
  const entry = registry.listCatalog().find((t) => t.name === 'web_search');
  assert.ok(entry);
  assert.equal(entry.riskClass, 'external');
});

test('web_search läuft ohne Schlüssel auch dann nicht, wenn das Modell es trotzdem aufruft', async () => {
  const { registry, calls } = makeRegistry({ configured: false });
  const out = JSON.parse(await run(registry, { query: 'x' }));
  assert.match(out.error, /nicht eingerichtet/);
  assert.equal(calls.length, 0);
});

test('web_search reicht Anfrage, Obergrenze und Sprache an den Adapter durch', async () => {
  const { registry, calls } = makeRegistry({
    search: (req) => ({
      ok: true,
      query: req.query,
      answer: 'Kurz.',
      results: [{ title: 'T', url: 'https://example.com', snippet: 'S' }],
    }),
  });

  const out = JSON.parse(await run(registry, { query: 'Electron 40', max_results: 3, language: 'de' }));

  assert.deepEqual(calls[0], {
    query: 'Electron 40',
    maxResults: 3,
    language: 'de',
    abortSignal: undefined,
  });
  assert.equal(out.query, 'Electron 40');
  assert.equal(out.count, 1);
  assert.equal(out.answer, 'Kurz.');
  assert.deepEqual(out.results, [{ title: 'T', url: 'https://example.com', snippet: 'S' }]);
});

test('web_search meldet null Treffer als Ergebnis, nicht als Fehler', async () => {
  const { registry } = makeRegistry({ search: () => ({ ok: true, query: 'x', results: [] }) });

  const out = JSON.parse(await run(registry, { query: 'x' }));
  assert.equal(out.count, 0);
  assert.deepEqual(out.results, []);
  assert.equal('error' in out, false);
});

test('web_search gibt einen Adapter-Fehler als Tool-Ergebnis zurück, statt zu werfen', async () => {
  const { registry } = makeRegistry({
    search: () => ({ ok: false, code: 'RATE_LIMITED', error: 'Kontingent erschöpft.' }),
  });

  const out = JSON.parse(await run(registry, { query: 'x' }));
  assert.equal(out.error, 'Kontingent erschöpft.');
});

test('web_search bleibt ohne Freigabe der Policy stehen', async () => {
  const { registry, calls } = makeRegistry();
  const out = JSON.parse(await registry.execute('web_search', { query: 'x' }, {}));
  assert.ok(out.error || out.permissionDenied);
  assert.equal(calls.length, 0);
});

test('web_search lässt sich per Häkchen abschalten', async () => {
  const { registry, calls } = makeRegistry();

  const names = registry.getTools({ disabledNames: ['web_search'] }).map((t) => t.function.name);
  assert.equal(names.includes('web_search'), false);

  const out = JSON.parse(
    await run(registry, { query: 'x' }, { disabledNames: ['web_search'] }),
  );
  assert.match(out.error, /deaktiviert/);
  assert.equal(calls.length, 0);
});

test('web_search zeigt eine deutsche Anzeige-Zeile mit der Suchanfrage', () => {
  assert.equal(
    summarizeToolCall('web_search', { query: 'Electron 40' }, 'start'),
    'Suche im Internet nach „Electron 40“ …',
  );
  assert.equal(
    summarizeToolCall('web_search', { query: 'Electron 40' }, 'done'),
    'Im Internet nach „Electron 40“ gesucht',
  );
  assert.equal(summarizeToolCall('web_search', {}, 'start'), 'Suche im Internet …');
});
