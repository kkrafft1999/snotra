// Tool fetch_url in der Registry (Issue #95). Der Adapter ist gemockt —
// im Testlauf geht nichts ins Netz.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { summarizeToolCall, formatToolDisplayLine } = require('../src/shared/presentation/tool-display');

function makeRegistry({ available = true, fetchUrl } = {}) {
  const calls = [];
  const registry = createWorkspaceToolRegistry({
    fsService: {},
    urlFetch: available
      ? {
          async fetchUrl(request) {
            calls.push(request);
            if (fetchUrl) return fetchUrl(request);
            return { ok: true, url: request.url, text: 'Inhalt', truncated: false };
          },
        }
      : null,
  });
  return { registry, calls };
}

function run(registry, args, context = {}) {
  return registry.execute('fetch_url', args, { approved: true, ...context });
}

test('fetch_url ist als externes Tool registriert und braucht keinen Ordner (#95)', () => {
  const { registry } = makeRegistry();

  const names = registry.getTools().map((tool) => tool.function.name);
  assert.ok(names.includes('fetch_url'));
  assert.deepEqual(
    registry.getTools({ workspaceOpen: false }).map((tool) => tool.function.name),
    ['fetch_url'],
    'ohne Ordner bleibt der Seitenabruf verfügbar'
  );

  const entry = registry.listCatalog().find((tool) => tool.name === 'fetch_url');
  assert.ok(entry, 'fetch_url steht im Katalog der Einstellungen');
  assert.equal(entry.riskClass, 'external');
});

test('fetch_url reicht Adresse und Zeichengrenze an den Adapter durch', async () => {
  const { registry, calls } = makeRegistry({
    fetchUrl: (request) => ({
      ok: true,
      url: request.url,
      title: 'Changelog',
      text: 'Version 1.5.0',
      truncated: true,
    }),
  });

  const out = JSON.parse(await run(registry, { url: 'https://example.org/changelog', max_characters: 1200 }));

  assert.deepEqual(calls[0].url, 'https://example.org/changelog');
  assert.equal(calls[0].maxCharacters, 1200);
  assert.deepEqual(out, {
    url: 'https://example.org/changelog',
    text: 'Version 1.5.0',
    title: 'Changelog',
    truncated: true,
  });
});

test('fetch_url gibt einen Adapter-Fehler als Tool-Ergebnis zurück, statt zu werfen', async () => {
  const { registry } = makeRegistry({
    fetchUrl: () => ({ ok: false, code: 'BLOCKED_ADDRESS', error: 'Adresse zeigt ins lokale Netz.' }),
  });

  const out = JSON.parse(await run(registry, { url: 'http://192.168.0.1/' }));

  assert.equal(out.error, 'Adresse zeigt ins lokale Netz.');
  assert.equal(out.text, undefined);
});

test('fetch_url erreicht das Modell ohne Abruf-Adapter nicht', async () => {
  const { registry, calls } = makeRegistry({ available: false });

  assert.equal(registry.getTools().some((tool) => tool.function.name === 'fetch_url'), false);
  const out = JSON.parse(await run(registry, { url: 'https://example.org' }));
  assert.match(out.error, /nicht eingerichtet/);
  assert.equal(calls.length, 0);
});

test('fetch_url bleibt ohne Freigabe der Policy stehen', async () => {
  const { registry, calls } = makeRegistry();

  const out = JSON.parse(await registry.execute('fetch_url', { url: 'https://example.org' }, {}));

  assert.ok(out.error, 'ohne approved kein Handler');
  assert.equal(calls.length, 0);
});

test('fetch_url lässt sich per Häkchen abschalten', async () => {
  const { registry, calls } = makeRegistry();
  const disabledNames = ['fetch_url'];

  assert.equal(
    registry.getTools({ disabledNames }).some((tool) => tool.function.name === 'fetch_url'),
    false
  );
  const out = JSON.parse(await run(registry, { url: 'https://example.org' }, { disabledNames }));
  assert.match(out.error, /deaktiviert/);
  assert.equal(calls.length, 0);
});

test('fetch_url zeigt eine deutsche Anzeige-Zeile mit dem Host', () => {
  const args = { url: 'https://docs.example.org/a/b?x=1' };

  assert.equal(summarizeToolCall('fetch_url', args, 'start'), 'Seite docs.example.org wird gelesen …');
  assert.equal(summarizeToolCall('fetch_url', args, 'done'), 'Seite docs.example.org gelesen');
  assert.match(
    formatToolDisplayLine({ tool: 'fetch_url', args }, 'done'),
    /Seite docs\.example\.org gelesen/
  );

  // Ohne brauchbare Adresse bleibt die Zeile trotzdem verständlich.
  assert.equal(summarizeToolCall('fetch_url', {}, 'done'), 'Seite gelesen');
  assert.equal(summarizeToolCall('fetch_url', { url: 'kein-url' }, 'done'), 'Seite kein-url gelesen');
});
