const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// Renderer-Modul ist natives ESM; das Contract-Bundle entsteht im pretest-Schritt.
const load = () =>
  import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'utils', 'tool-catalog-view.js')).href);

function tool(name, riskClass, overrides = {}) {
  return {
    name,
    riskClass,
    description: `Langer Text zu ${name}`,
    shortDescription: `Kurz zu ${name}`,
    ...overrides,
  };
}

test('Katalog wird nach Risikoklasse gruppiert, in Contract-Reihenfolge', async () => {
  const { groupToolCatalog } = await load();

  const groups = groupToolCatalog([
    tool('web_search', 'external'),
    tool('read_file_text', 'read'),
    tool('run_python', 'execute'),
    tool('edit_file', 'write'),
    tool('list_directory', 'read'),
  ]);

  assert.deepEqual(
    groups.map((group) => group.riskClass),
    ['read', 'write', 'execute', 'external']
  );
  // Innerhalb einer Gruppe bleibt die Reihenfolge der Registry erhalten.
  assert.deepEqual(
    groups[0].tools.map((entry) => entry.name),
    ['read_file_text', 'list_directory']
  );
});

test('Gruppen tragen Label und Rückfrage-Hinweis, leere Klassen entfallen', async () => {
  const { groupToolCatalog } = await load();

  const groups = groupToolCatalog([tool('read_file_text', 'read')]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'Lesen');
  assert.match(groups[0].note, /ohne Rückfrage/);
});

test('Einträge ohne gültige Klasse landen unter Lesen statt zu verschwinden', async () => {
  const { groupToolCatalog } = await load();

  const groups = groupToolCatalog([tool('seltsam', 'unbekannt'), tool('read_file_text', 'read')]);

  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].tools.map((entry) => entry.name),
    ['seltsam', 'read_file_text']
  );
});

test('leerer oder ungültiger Katalog ergibt keine Gruppen', async () => {
  const { groupToolCatalog } = await load();

  assert.deepEqual(groupToolCatalog([]), []);
  assert.deepEqual(groupToolCatalog(null), []);
});

test('Kurztext kommt aus shortDescription, sonst aus der vollen Beschreibung', async () => {
  const { toolShortText } = await load();

  assert.equal(toolShortText(tool('a', 'read')), 'Kurz zu a');
  assert.equal(
    toolShortText(tool('b', 'read', { shortDescription: '   ' })),
    'Langer Text zu b'
  );
  assert.equal(toolShortText({}), '');
});

test('Volltext bleibt leer, wenn er den Kurztext nur wiederholt', async () => {
  const { toolDetailText } = await load();

  assert.equal(toolDetailText(tool('a', 'read')), 'Langer Text zu a');
  assert.equal(
    toolDetailText(tool('b', 'read', { shortDescription: 'Langer Text zu b' })),
    ''
  );
  assert.equal(toolDetailText({}), '');
});

test('Status-Badge nur für nicht eingerichtete Tools, nie für die Risikoklasse', async () => {
  const { toolStatusBadge } = await load();

  assert.equal(toolStatusBadge(tool('run_python', 'execute'), { pythonReady: true }), null);
  assert.match(
    toolStatusBadge(tool('run_python', 'execute'), { pythonReady: false }).text,
    /Nicht eingerichtet/
  );
  assert.equal(toolStatusBadge(tool('web_search', 'external'), { webSearchHasKey: true }), null);
  assert.match(
    toolStatusBadge(tool('web_search', 'external'), { webSearchHasKey: false }).text,
    /Schlüssel fehlt/
  );
  // Ein Schreib-Tool bekommt keinen Hinweis mehr — die Klasse steht im Gruppenkopf.
  assert.equal(toolStatusBadge(tool('edit_file', 'write'), {}), null);
});

test('Gruppenkopf zeigt Zähler und passende Schalterbeschriftung', async () => {
  const { groupCountLabel, groupToggleLabel } = await load();

  assert.equal(groupCountLabel(9, 8), '8 von 9 aktiv');
  assert.equal(groupToggleLabel(9, 8), 'alle an');
  assert.equal(groupToggleLabel(9, 9), 'alle aus');
  assert.equal(groupToggleLabel(9, 0), 'alle an');
});

test('Gruppenüberschrift nennt externe Dienste im Plural', async () => {
  const { groupToolCatalog } = await load();

  const [group] = groupToolCatalog([tool('web_search', 'external')]);

  // Das Contract-Label „Externer Dienst“ beschreibt einen einzelnen Aufruf und
  // bleibt der Freigabekarte vorbehalten.
  assert.equal(group.label, 'Externe Dienste');
});
