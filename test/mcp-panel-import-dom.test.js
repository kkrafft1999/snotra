// Einstellungen › MCP › Server importieren am echten DOM (Issue #110).
//
// Der Parser selbst hat eigene Tests (contracts-mcp-import). Hier geht es um
// die Verdrahtung gegen das echte Markup aus index.html: Was zeigt die
// Vorschau, was passiert beim Abwählen, und vor allem — was wird tatsächlich
// gespeichert und was nicht.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const BLOCK = JSON.stringify({
  mcpServers: {
    'Atlassian Jira': {
      command: 'docker',
      args: ['run', '--rm', '-i', 'mcp-atlassian:latest'],
      env: { JIRA_TOKEN: '<dein-token>' },
    },
    heise: { command: 'npx', args: ['-y', 'server-heise'], env: { LANG: 'de_DE' } },
    'remote-docs': { url: 'https://example.com/mcp' },
  },
});

function katalog(overrides = {}) {
  return {
    servers: [
      {
        id: 'github',
        label: 'GitHub',
        command: 'npx',
        args: [],
        cwd: null,
        enabled: true,
        disabledTools: [],
        env: [],
      },
    ],
    connections: [],
    skippedTools: [],
    ...overrides,
  };
}

async function mount(apiOverrides = {}) {
  setupRendererDom();
  const { initMcpPanel } = await importRenderer('components', 'McpPanel.js');
  const gespeichert = [];
  const api = {
    getMcpCatalog: async () => katalog(),
    saveMcpServer: async (payload) => {
      gespeichert.push(payload);
      return { ok: true, ...katalog() };
    },
    deleteMcpServer: async () => ({ ok: true, ...katalog() }),
    reloadMcpServers: async () => ({ ok: true, ...katalog() }),
    testMcpServer: async () => ({ ok: true, status: { state: 'ready' }, tools: [] }),
    ...apiOverrides,
  };
  const panel = initMcpPanel({ api });
  await panel.open();
  await flush();
  return { panel, gespeichert };
}

const offen = () => !document.getElementById('mcp-import-overlay').classList.contains('hidden');
const zeilen = () => [...document.querySelectorAll('#mcp-import-list .mcp-import__row')];
const uebernehmen = () => document.getElementById('btn-mcp-import-apply');
const feld = () => document.getElementById('mcp-import-input');
const fehler = () => document.getElementById('mcp-import-error');

/** Text ins Feld schreiben, als käme er per Tastatur oder Einfügen. */
async function einfuegen(text) {
  feld().value = text;
  feld().dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}

async function oeffnen() {
  document.getElementById('btn-import-mcp-servers').click();
  await flush();
}

test('der Import-Dialog öffnet leer und übernimmt zunächst nichts', async () => {
  await mount();
  assert.equal(offen(), false);
  await oeffnen();
  assert.equal(offen(), true);
  assert.equal(feld().value, '');
  assert.deepEqual(zeilen(), []);
  assert.equal(uebernehmen().disabled, true, 'ohne Auswahl gibt es nichts zu übernehmen');
});

test('ein eingefügter Block erscheint sofort als Vorschau', async () => {
  await mount();
  await oeffnen();
  await einfuegen(BLOCK);

  const namen = zeilen().map((row) => row.querySelector('.mcp-import__name').textContent);
  assert.deepEqual(namen, ['Atlassian Jira', 'heise']);
  assert.equal(zeilen()[0].querySelector('.mcp-import__id').textContent, 'atlassian-jira');
  assert.equal(
    zeilen()[0].querySelector('.mcp-import__cmd').textContent,
    'docker run --rm -i mcp-atlassian:latest'
  );
  assert.match(document.getElementById('mcp-import-count').textContent, /2 von 3/);
});

test('der übersprungene Eintrag steht mit Begründung da, nicht bloß weg', async () => {
  await mount();
  await oeffnen();
  await einfuegen(BLOCK);

  const block = document.getElementById('mcp-import-skipped');
  assert.equal(block.classList.contains('hidden'), false);
  assert.match(block.textContent, /remote-docs/);
  assert.match(block.textContent, /URL/);
});

test('Geheimnisse und Platzhalter werden in der Zeile benannt', async () => {
  await mount();
  await oeffnen();
  await einfuegen(BLOCK);

  const notes = zeilen()[0].querySelector('.mcp-import__notes').textContent;
  assert.match(notes, /JIRA_TOKEN/);
  assert.match(notes, /verschlüsselt/);
  assert.match(notes, /Platzhalter/);
  const marken = [...zeilen()[0].querySelectorAll('.mcp-import__badge')].map((b) => b.textContent);
  assert.ok(marken.includes('geheim'));
});

test('eine Kennung, die es schon gibt, wird als Ersetzen ausgewiesen', async () => {
  await mount();
  await oeffnen();
  await einfuegen(JSON.stringify({ mcpServers: { github: { command: 'npx' } } }));

  const zeile = zeilen()[0];
  assert.match(zeile.textContent, /ersetzt ihn/);
  const warn = zeile.querySelector('.mcp-import__badge--warn');
  assert.equal(warn.textContent, 'ersetzt');
});

test('der Knopf nennt die Zahl und folgt dem Abwählen', async () => {
  await mount();
  await oeffnen();
  await einfuegen(BLOCK);
  assert.equal(uebernehmen().textContent, '2 Server übernehmen');

  zeilen()[0].querySelector('.mcp-import__check').click();
  await flush();
  assert.equal(uebernehmen().textContent, '1 Server übernehmen');
  assert.equal(uebernehmen().disabled, false);

  zeilen()[1].querySelector('.mcp-import__check').click();
  await flush();
  assert.equal(uebernehmen().disabled, true, 'ohne Auswahl ist nichts zu tun');
});

test('übernommen wird nur das Angehakte — und zwar ausgeschaltet', async () => {
  const { gespeichert } = await mount();
  await oeffnen();
  await einfuegen(BLOCK);
  zeilen()[0].querySelector('.mcp-import__check').click(); // Atlassian abwählen
  await flush();

  uebernehmen().click();
  await flush();

  assert.equal(gespeichert.length, 1, 'nur der angehakte Server wird gespeichert');
  assert.equal(gespeichert[0].id, 'heise');
  assert.equal(gespeichert[0].enabled, false, 'der Import ist keine Freigabe');
  assert.deepEqual(gespeichert[0].args, ['-y', 'server-heise']);
  assert.deepEqual(gespeichert[0].env, { LANG: { value: 'de_DE', secret: false } });
  assert.equal(offen(), false, 'nach vollem Erfolg schließt der Dialog');
});

test('ein token-artiger Wert geht als geheim in den Speicherweg', async () => {
  const { gespeichert } = await mount();
  await oeffnen();
  await einfuegen(BLOCK);
  uebernehmen().click();
  await flush();

  const jira = gespeichert.find((payload) => payload.id === 'atlassian-jira');
  assert.deepEqual(jira.env, { JIRA_TOKEN: { value: '<dein-token>', secret: true } });
});

test('kaputtes JSON meldet sich am Feld, ohne die Vorschau zu behalten', async () => {
  await mount();
  await oeffnen();
  await einfuegen(BLOCK);
  assert.equal(zeilen().length, 2);

  await einfuegen('{ "mcpServers": { ');
  assert.deepEqual(zeilen(), [], 'die alte Vorschau darf nicht stehenbleiben');
  assert.equal(fehler().classList.contains('hidden'), false);
  assert.match(fehler().textContent, /kein gültiges JSON/);
  assert.equal(uebernehmen().disabled, true);
});

test('ein leeres Feld ist kein Fehler, sondern der Ausgangszustand', async () => {
  await mount();
  await oeffnen();
  await einfuegen('{ kaputt');
  assert.equal(fehler().classList.contains('hidden'), false);

  await einfuegen('   ');
  assert.equal(fehler().classList.contains('hidden'), true, 'leeren heißt nicht scheitern');
});

test('scheitert ein Server, bleibt der Dialog offen und nennt ihn', async () => {
  const versuche = [];
  await mount({
    saveMcpServer: async (payload) => {
      versuche.push(payload);
      // Der erste scheitert, der zweite geht durch.
      return versuche.length === 1
        ? { ok: false, errors: ['Verschlüsselter Speicher ist nicht verfügbar.'] }
        : { ok: true, ...katalog() };
    },
  });

  await oeffnen();
  await einfuegen(BLOCK);
  uebernehmen().click();
  await flush();

  assert.equal(versuche.length, 2, 'ein Fehlschlag bricht die übrigen nicht ab');
  assert.equal(offen(), true, 'der Dialog bleibt offen, sonst ginge der Rest unbemerkt verloren');
  assert.match(fehler().textContent, /Atlassian Jira/);
  assert.match(fehler().textContent, /Verschlüsselter Speicher/);
});

test('Escape schließt nur den Import-Dialog', async () => {
  await mount();
  await oeffnen();
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  document.getElementById('dialog-mcp-import').dispatchEvent(event);
  await flush();
  assert.equal(offen(), false);
});

test('erneutes Öffnen beginnt wieder leer', async () => {
  await mount();
  await oeffnen();
  await einfuegen(BLOCK);
  assert.equal(zeilen().length, 2);

  document.getElementById('btn-mcp-import-cancel').click();
  await flush();
  await oeffnen();

  assert.equal(feld().value, '', 'der alte Block darf nicht stehenbleiben');
  assert.deepEqual(zeilen(), []);
  assert.equal(uebernehmen().disabled, true);
});
