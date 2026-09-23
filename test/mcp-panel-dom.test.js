// Einstellungen › MCP am echten DOM (Issue #109).
//
// Geprueft wird die Verdrahtung gegen das echte Markup aus index.html:
// Was steht in der Liste, was passiert beim Umschalten, was schickt das
// Formular — und vor allem, dass ein gespeichertes Geheimnis den Renderer
// weder erreicht noch beim Speichern verlorengeht.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const TOKEN_PLACEHOLDER = '••••••••••••';

function katalog(overrides = {}) {
  return {
    servers: [
      {
        id: 'github',
        label: 'GitHub',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        cwd: null,
        enabled: true,
        disabledTools: ['delete_repository'],
        env: [
          { key: 'GITHUB_TOKEN', secret: true, hasValue: true },
          { key: 'LANG', secret: false, hasValue: true, value: 'de_DE' },
        ],
      },
      {
        id: 'files',
        label: 'Dateisystem',
        command: 'npx',
        args: [],
        cwd: null,
        enabled: false,
        disabledTools: [],
        env: [],
      },
    ],
    connections: [
      { serverId: 'github', state: 'ready', toolCount: 2, toolNames: ['search', 'delete_repository'], error: '', stderr: '' },
      { serverId: 'files', state: 'stopped', toolCount: 0, toolNames: [], error: '', stderr: '' },
    ],
    skippedTools: [],
    ...overrides,
  };
}

async function mount(apiOverrides = {}, daten = null) {
  setupRendererDom();
  const { initMcpPanel } = await importRenderer('components', 'McpPanel.js');
  const calls = [];
  const api = {
    getMcpCatalog: async () => daten || katalog(),
    saveMcpServer: async (payload) => { calls.push(['save', payload]); return { ok: true, ...katalog() }; },
    deleteMcpServer: async (id) => { calls.push(['delete', id]); return { ok: true, ...katalog() }; },
    reloadMcpServers: async () => { calls.push(['reload']); return { ok: true, ...katalog() }; },
    testMcpServer: async (id) => { calls.push(['test', id]); return { ok: true, status: { serverId: id, state: 'ready' }, tools: ['search'] }; },
    ...apiOverrides,
  };
  const panel = initMcpPanel({ api });
  await panel.open();
  await flush();
  return { panel, api, calls };
}

const rows = () => [...document.querySelectorAll('#settings-mcp-list .mcp-row')];
const dialogOffen = () => !document.getElementById('mcp-server-overlay').classList.contains('hidden');

test('die Liste zeigt Server, Kommando und Status', async () => {
  await mount();
  const list = rows();
  assert.equal(list.length, 2);
  assert.equal(list[0].querySelector('.mcp-row__name').textContent, 'GitHub');
  assert.equal(
    list[0].querySelector('.mcp-row__meta').textContent,
    'npx -y @modelcontextprotocol/server-github',
  );
  assert.match(list[0].querySelector('.mcp-status').textContent, /verbunden · 2 Tools/);
  // Ausgeschaltet schlaegt den Verbindungszustand — sonst stuende dort
  // „noch nicht verbunden", was wie ein Problem aussieht.
  assert.match(list[1].querySelector('.mcp-status').textContent, /ausgeschaltet/);
});

test('der volle Aufruf haengt im title, weil die Zeile abschneidet', async () => {
  await mount();
  const meta = rows()[0].querySelector('.mcp-row__meta');
  assert.equal(meta.title, 'npx -y @modelcontextprotocol/server-github');
});

test('der Schalter speichert sofort und laesst Geheimnisse unangetastet', async () => {
  const { calls } = await mount();
  rows()[0].querySelector('.mcp-switch').click();
  await flush();

  const [art, payload] = calls[0];
  assert.equal(art, 'save');
  assert.equal(payload.enabled, false);
  // Entscheidend: der Renderer kennt den Token nicht und darf ihn beim
  // blossen Umschalten nicht loeschen.
  assert.deepEqual(payload.env.GITHUB_TOKEN, { secret: true, keep: true });
  assert.deepEqual(payload.env.LANG, { secret: false, value: 'de_DE' });
});

test('„Bearbeiten" fuellt den Unterdialog, ohne das Geheimnis zu zeigen', async () => {
  await mount();
  assert.equal(dialogOffen(), false);
  rows()[0].querySelector('.btn-secondary').click();
  await flush();

  assert.equal(dialogOffen(), true);
  assert.equal(document.getElementById('dialog-mcp-server-title').textContent, 'Edit server');
  assert.equal(document.getElementById('mcp-field-id').value, 'github');
  // Die Kennung steckt im Tool-Namen und ist nachtraeglich nicht aenderbar.
  assert.equal(document.getElementById('mcp-field-id').disabled, true);
  assert.equal(document.getElementById('mcp-field-args').value, '-y @modelcontextprotocol/server-github');

  const werte = [...document.querySelectorAll('#mcp-env-list .mcp-env-row')];
  assert.equal(werte.length, 2);
  const [, geheimerWert] = werte[0].querySelectorAll('input[type="text"]');
  assert.equal(geheimerWert.value, TOKEN_PLACEHOLDER, 'nur ein Platzhalter, nie der Wert');
  assert.equal(geheimerWert.dataset.keep, 'true');
});

test('ein unberuehrtes Geheimnis wird als keep gespeichert, ein neues als Wert', async () => {
  const { calls } = await mount();
  rows()[0].querySelector('.btn-secondary').click();
  await flush();

  document.getElementById('mcp-field-label').value = 'GitHub (Arbeit)';
  document.getElementById('btn-mcp-server-save').click();
  await flush();

  const [, payload] = calls[0];
  assert.equal(payload.label, 'GitHub (Arbeit)');
  assert.deepEqual(payload.env.GITHUB_TOKEN, { secret: true, keep: true });
});

test('wer in das Feld klickt, ersetzt das Geheimnis wirklich', async () => {
  const { calls } = await mount();
  rows()[0].querySelector('.btn-secondary').click();
  await flush();

  const [, wert] = document.querySelectorAll('#mcp-env-list .mcp-env-row')[0].querySelectorAll('input[type="text"]');
  // Der Fokus leert den Platzhalter — sonst schriebe man in „••••" hinein.
  wert.dispatchEvent(new window.Event('focus'));
  assert.equal(wert.value, '');
  wert.value = 'ghp_neu';

  document.getElementById('btn-mcp-server-save').click();
  await flush();
  assert.deepEqual(calls[0][1].env.GITHUB_TOKEN, { secret: true, value: 'ghp_neu' });
});

test('Argumente werden aus einer Zeile gelesen, Anfuehrungszeichen halten zusammen', async () => {
  const { calls } = await mount();
  document.getElementById('btn-add-mcp-server').click();
  await flush();

  document.getElementById('mcp-field-id').value = 'neu';
  document.getElementById('mcp-field-command').value = 'uvx';
  document.getElementById('mcp-field-args').value = '--from "mein paket" server';
  document.getElementById('btn-mcp-server-save').click();
  await flush();

  assert.deepEqual(calls[0][1].args, ['--from', 'mein paket', 'server']);
  assert.equal(calls[0][1].enabled, true, 'ein neuer Server ist eingeschaltet');
});

test('beim Anlegen gibt es weder Testen noch Loeschen', async () => {
  await mount();
  document.getElementById('btn-add-mcp-server').click();
  await flush();
  assert.equal(document.getElementById('btn-mcp-server-delete').classList.contains('hidden'), true);
  assert.equal(document.getElementById('btn-mcp-server-test').classList.contains('hidden'), true);
  assert.equal(document.getElementById('mcp-field-id').disabled, false);
});

test('Tools sind einzeln abwaehlbar und landen in disabledTools', async () => {
  const { calls } = await mount();
  rows()[0].querySelector('.btn-secondary').click();
  await flush();

  const boxen = [...document.querySelectorAll('#mcp-tools-list input[type="checkbox"]')];
  assert.deepEqual(boxen.map((b) => b.value), ['search', 'delete_repository']);
  assert.deepEqual(boxen.map((b) => b.checked), [true, false], 'abgewaehltes Tool kommt ohne Haken');
  assert.equal(document.getElementById('mcp-tools-count').textContent, '1 of 2 active');

  boxen[0].checked = false;
  document.getElementById('btn-mcp-server-save').click();
  await flush();
  assert.deepEqual(calls[0][1].disabledTools.sort(), ['delete_repository', 'search']);
});

test('ohne laufende Verbindung bleibt die gespeicherte Auswahl erhalten (#170)', async () => {
  // Der Server ist gestoppt und hat noch keinen gespeicherten Katalog: der
  // Dialog zeigt keine Checkboxen. Frueher schrieb das Speichern dann ein
  // leeres disabledTools und loeschte die Auswahl.
  const { calls } = await mount({}, katalog({
    connections: [
      { serverId: 'github', state: 'stopped', toolCount: 0, toolNames: [], error: '', stderr: '' },
      { serverId: 'files', state: 'stopped', toolCount: 0, toolNames: [], error: '', stderr: '' },
    ],
  }));
  rows()[0].querySelector('.btn-secondary').click();
  await flush();

  assert.equal(document.querySelectorAll('#mcp-tools-list input[type="checkbox"]').length, 0);
  document.getElementById('btn-mcp-server-save').click();
  await flush();
  assert.deepEqual(calls[0][1].disabledTools, ['delete_repository'], 'die Auswahl darf nicht verloren gehen');
});

test('der gespeicherte Katalog traegt den Dialog ohne Verbindung (#170)', async () => {
  const { calls } = await mount({}, katalog({
    servers: [
      {
        id: 'github',
        label: 'GitHub',
        command: 'npx',
        args: [],
        cwd: null,
        enabled: true,
        disabledTools: ['delete_repository'],
        knownTools: ['search', 'delete_repository', 'create_issue'],
        env: [],
      },
    ],
    connections: [
      { serverId: 'github', state: 'stopped', toolCount: 0, toolNames: [], error: '', stderr: '' },
    ],
  }));
  rows()[0].querySelector('.btn-secondary').click();
  await flush();

  const boxen = [...document.querySelectorAll('#mcp-tools-list input[type="checkbox"]')];
  assert.deepEqual(boxen.map((b) => b.value), ['search', 'delete_repository', 'create_issue']);
  assert.deepEqual(boxen.map((b) => b.checked), [true, false, true]);
  assert.equal(document.getElementById('mcp-tools-count').textContent, '2 of 3 active');

  boxen[2].checked = false;
  document.getElementById('btn-mcp-server-save').click();
  await flush();
  assert.deepEqual(calls[0][1].disabledTools.sort(), ['create_issue', 'delete_repository']);
  assert.deepEqual(calls[0][1].knownTools, ['search', 'delete_repository', 'create_issue']);
});

test('ein Fehlschlag beim Speichern haelt den Dialog offen und nennt den Grund', async () => {
  await mount({ saveMcpServer: async () => ({ ok: false, errors: ['Es fehlt das Kommando.'] }) });
  document.getElementById('btn-add-mcp-server').click();
  await flush();
  document.getElementById('btn-mcp-server-save').click();
  await flush();

  assert.equal(dialogOffen(), true);
  const fehler = document.getElementById('mcp-form-error');
  assert.equal(fehler.classList.contains('hidden'), false);
  assert.equal(fehler.textContent, 'Es fehlt das Kommando.');
});

test('der Verbindungstest zeigt Ergebnis und Tool-Liste', async () => {
  const { calls } = await mount();
  rows()[0].querySelector('.btn-secondary').click();
  await flush();
  document.getElementById('btn-mcp-server-test').click();
  await flush();

  assert.deepEqual(calls[0], ['test', 'github']);
  const ergebnis = document.getElementById('mcp-test-result').textContent;
  assert.match(ergebnis, /Connected — 1 tool found\./);
  assert.match(ergebnis, /search/);
});

test('ein gescheiterter Test zeigt Meldung und stderr-Auszug', async () => {
  await mount({
    testMcpServer: async () => ({
      ok: true,
      status: { state: 'failed', error: 'Der Server hat sich beendet (Code 3).', stderr: 'JIRA_URL fehlt.' },
      tools: [],
    }),
  });
  rows()[0].querySelector('.btn-secondary').click();
  await flush();
  document.getElementById('btn-mcp-server-test').click();
  await flush();

  const box = document.getElementById('mcp-test-result');
  assert.match(box.textContent, /Der Server hat sich beendet/);
  assert.match(box.querySelector('pre').textContent, /JIRA_URL fehlt/);
});

test('ein fehlgeschlagener Server zeigt Grund und stderr in der Liste', async () => {
  await mount({
    getMcpCatalog: async () => katalog({
      connections: [
        { serverId: 'github', state: 'failed', toolCount: 0, toolNames: [], error: 'Start fehlgeschlagen.', stderr: 'npx: not found' },
        { serverId: 'files', state: 'stopped', toolCount: 0, toolNames: [], error: '', stderr: '' },
      ],
    }),
  });
  const zeile = rows()[0];
  assert.match(zeile.querySelector('.mcp-status').textContent, /Failed to start/);
  assert.match(zeile.querySelector('.mcp-row__error').textContent, /Start fehlgeschlagen/);
  assert.match(zeile.querySelector('.mcp-row__error pre').textContent, /npx: not found/);
});

test('„Neu laden" geht ueber den eigenen Kanal', async () => {
  const { calls } = await mount();
  document.getElementById('btn-reload-mcp').click();
  await flush();
  assert.deepEqual(calls[0], ['reload']);
});

test('ohne Server erscheint der Hinweis statt einer leeren Liste', async () => {
  await mount({ getMcpCatalog: async () => ({ servers: [], connections: [], skippedTools: [] }) });
  assert.equal(rows().length, 0);
  assert.equal(document.getElementById('settings-mcp-empty').classList.contains('hidden'), false);
});

test('ausgelassene Tools werden benannt statt still zu verschwinden', async () => {
  await mount({
    getMcpCatalog: async () => katalog({
      skippedTools: [{ serverId: 'github', name: 'sehr_langer_name', reason: 'Der Tool-Name ist zu lang.' }],
    }),
  });
  const note = document.querySelector('.mcp-row--note');
  assert.ok(note, 'es gibt einen Hinweis');
  assert.match(note.textContent, /github\/sehr_langer_name/);
});

test('Variablen lassen sich hinzufuegen und entfernen', async () => {
  const { calls } = await mount();
  rows()[0].querySelector('.btn-secondary').click();
  await flush();

  document.getElementById('btn-mcp-env-add').click();
  await flush();
  const zeilen = [...document.querySelectorAll('#mcp-env-list .mcp-env-row')];
  assert.equal(zeilen.length, 3);
  const [name, wert] = zeilen[2].querySelectorAll('input[type="text"]');
  name.value = 'NEU';
  wert.value = 'wert';

  // Die Klartext-Zeile wieder entfernen.
  zeilen[1].querySelector('.settings-dialog__icon-close').click();
  document.getElementById('btn-mcp-server-save').click();
  await flush();

  const env = calls[0][1].env;
  assert.deepEqual(Object.keys(env).sort(), ['GITHUB_TOKEN', 'NEU']);
  assert.deepEqual(env.NEU, { secret: true, value: 'wert' });
});

test('Escape schliesst nur den Unterdialog', async () => {
  await mount();
  rows()[0].querySelector('.btn-secondary').click();
  await flush();
  assert.equal(dialogOffen(), true);

  const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  document.getElementById('dialog-mcp-server').dispatchEvent(event);
  await flush();
  assert.equal(dialogOffen(), false);
});
