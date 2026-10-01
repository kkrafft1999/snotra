// Einstellungen › MCP am echten DOM (Issue #109).
//
// Geprueft wird die Verdrahtung gegen das echte Markup aus index.html:
// Was steht in der Liste, was passiert beim Umschalten, was schickt das
// Formular — und vor allem, dass ein gespeichertes Geheimnis den Renderer
// weder erreicht noch beim Speichern verlorengeht.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush, focusFixup } = require('./helpers/dom.js');

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
const envRows = () => [...document.querySelectorAll('#mcp-env-list .mcp-env-row')];
/** The three controls of an environment row. */
const envFields = (row) => ({
  key: row.querySelector('.mcp-env-row__key'),
  value: row.querySelector('.mcp-env-row__value'),
  secret: row.querySelector('.mcp-env-row__secret input[type="checkbox"]'),
});
/** Typing as the browser reports it: the value changes, then `input` fires. */
function type(input, text) {
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

test('die Liste zeigt Server, Kommando und Status', async () => {
  await mount();
  const list = rows();
  assert.equal(list.length, 2);
  assert.equal(list[0].querySelector('.mcp-row__name').textContent, 'GitHub');
  assert.equal(
    list[0].querySelector('.mcp-row__meta').textContent,
    'npx -y @modelcontextprotocol/server-github',
  );
  assert.match(list[0].querySelector('.mcp-status').textContent, /connected · 2 tools/);
  // Ausgeschaltet schlaegt den Verbindungszustand — sonst stuende dort
  // „noch nicht verbunden", was wie ein Problem aussieht.
  assert.match(list[1].querySelector('.mcp-status').textContent, /switched off/);
});

test('der volle Aufruf haengt im title, weil die Zeile abschneidet', async () => {
  await mount();
  const meta = rows()[0].querySelector('.mcp-row__meta');
  assert.equal(meta.title, 'npx -y @modelcontextprotocol/server-github');
});

test('der Schalter speichert sofort und laesst Geheimnisse unangetastet', async () => {
  const { calls } = await mount();
  const toggle = rows()[0].querySelector('input.ds-switch[role="switch"]');
  assert.equal(toggle.checked, true);
  toggle.click();
  await flush();

  const [art, payload] = calls[0];
  assert.equal(art, 'save');
  assert.equal(payload.enabled, false);
  // Entscheidend: der Renderer kennt den Token nicht und darf ihn beim
  // blossen Umschalten nicht loeschen.
  assert.deepEqual(payload.env.GITHUB_TOKEN, { secret: true, keep: true });
  assert.deepEqual(payload.env.LANG, { secret: false, value: 'de_DE' });
});

test('der Schalter ist die native Checkbox und behaelt nach dem Neuzeichnen den Fokus (#336)', async () => {
  await mount();
  const toggle = rows()[0].querySelector('.ds-switch');
  assert.equal(toggle.type, 'checkbox');
  assert.equal(toggle.getAttribute('aria-label'), 'GitHub enabled');
  assert.equal(rows()[1].querySelector('.ds-switch').checked, false);

  toggle.focus();
  toggle.click();
  await flush();
  // The list was redrawn with the new status — a new node, same server.
  const now = rows()[0].querySelector('.ds-switch');
  assert.equal(document.activeElement, now);
});

test('lehnt der Speicher ab, springt der Schalter zurueck (#336)', async () => {
  await mount({ saveMcpServer: async () => ({ ok: false, error: 'nope' }) });
  const toggle = rows()[0].querySelector('.ds-switch');
  toggle.click();
  await flush();
  assert.equal(toggle.checked, true);
});

test('„Bearbeiten" fuellt den Unterdialog, ohne das Geheimnis zu zeigen', async () => {
  await mount();
  assert.equal(dialogOffen(), false);
  rows()[0].querySelector('.btn-secondary').click();
  await flush();

  assert.equal(dialogOffen(), true);
  assert.equal(document.getElementById('dialog-mcp-server-title').textContent, 'Edit MCP server');
  assert.equal(document.getElementById('mcp-field-id').value, 'github');
  // Die Kennung steckt im Tool-Namen und ist nachtraeglich nicht aenderbar.
  assert.equal(document.getElementById('mcp-field-id').disabled, true);
  assert.equal(document.getElementById('mcp-field-args').value, '-y @modelcontextprotocol/server-github');

  const werte = envRows();
  assert.equal(werte.length, 2);
  const { value: geheimerWert } = envFields(werte[0]);
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

  const { value: wert } = envFields(envRows()[0]);
  // Der Fokus leert den Platzhalter — sonst schriebe man in „••••" hinein.
  wert.focus();
  assert.equal(wert.value, '');
  type(wert, 'ghp_neu');

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

// Since #449 a tool has one switch, on the Security page. The dialog lists no
// tools any more, and a save leaves no per-server deselection behind — an old
// one was moved to the preferences at start (mcp-disabled-tools-migration.js).
test('the dialog has no tool list, and saving stores no per-server deselection (#449)', async () => {
  const { calls } = await mount();
  rows()[0].querySelector('.btn-secondary').click();
  await flush();
  assert.equal(document.getElementById('mcp-tools-list'), null);
  document.getElementById('btn-mcp-server-save').click();
  await flush();
  assert.deepEqual(calls[0][1].disabledTools, []);
});

test('the server switch leaves no per-server deselection either (#449)', async () => {
  const { calls } = await mount();
  const toggle = rows()[0].querySelector('input.ds-switch');
  toggle.click();
  await flush();
  assert.deepEqual(calls[0][1].disabledTools, []);
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
        { serverId: 'github', state: 'failed', toolCount: 0, toolNames: [], error: { key: 'mcp.transport.startFailedReason', params: { label: 'GitHub', reason: { key: 'mcp.transport.reason.code', params: { code: 127 } } } }, stderr: 'npx: not found' },
        { serverId: 'files', state: 'stopped', toolCount: 0, toolNames: [], error: '', stderr: '' },
      ],
    }),
  });
  const zeile = rows()[0];
  assert.match(zeile.querySelector('.mcp-status').textContent, /Failed to start/);
  // Since #338 the error arrives as a catalogue message and is read in the
  // interface language, nested reason included.
  assert.match(zeile.querySelector('.mcp-row__error').textContent, /The MCP server “GitHub” could not be started \(exit code 127\)\./);
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
  const zeilen = envRows();
  assert.equal(zeilen.length, 3);
  const { key: name, value: wert } = envFields(zeilen[2]);
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

// --- CR-B14-02: a stored secret survives focus, rename and untick ---

async function editGithub(apiOverrides) {
  const mounted = await mount(apiOverrides);
  rows()[0].querySelector('.btn-secondary').click();
  await flush();
  return mounted;
}

test('focus and blur on a stored secret leave it stored (CR-B14-02)', async () => {
  const { calls } = await editGithub();
  const { value } = envFields(envRows()[0]);

  value.focus();
  assert.equal(value.value, '', 'the field empties for typing');
  assert.equal(value.placeholder, 'stored — type to replace');
  value.blur();
  assert.equal(value.value, TOKEN_PLACEHOLDER, 'nothing typed — the placeholder is back');
  assert.equal(value.dataset.keep, 'true');

  // Tab through the field to Save, or click into it and save straight away:
  // both keep the token.
  value.focus();
  document.getElementById('btn-mcp-server-save').click();
  await flush();
  assert.deepEqual(calls[0][1].env.GITHUB_TOKEN, { secret: true, keep: true });
});

test('typing and erasing again keeps the stored secret as well (CR-B14-02)', async () => {
  const { calls } = await editGithub();
  const { key, value } = envFields(envRows()[0]);
  value.focus();
  type(value, 'g');
  assert.equal(value.dataset.keep, undefined);
  type(value, '');
  value.blur();
  assert.equal(value.dataset.keep, 'true');
  assert.equal(key.value, 'GITHUB_TOKEN');

  document.getElementById('btn-mcp-server-save').click();
  await flush();
  assert.deepEqual(calls[0][1].env.GITHUB_TOKEN, { secret: true, keep: true });
});

test('a kept row locks its name and its secret box, and says why (CR-B14-02)', async () => {
  await editGithub();
  const { key, value, secret } = envFields(envRows()[0]);
  assert.equal(key.readOnly, true);
  assert.equal(secret.disabled, true);
  assert.equal(secret.checked, true);
  for (const node of [key, secret]) assert.equal(node.getAttribute('aria-describedby'), 'mcp-env-hint');
  assert.match(document.getElementById('mcp-env-hint').textContent, /enter the value again/);

  // A new value unlocks both: now there is something to rename or to store
  // in plain text.
  value.focus();
  type(value, 'ghp_neu');
  assert.equal(key.readOnly, false);
  assert.equal(secret.disabled, false);
  assert.equal(key.hasAttribute('aria-describedby'), false);
});

test('renaming a row with a new value sends the new name with the value (CR-B14-02)', async () => {
  const { calls } = await editGithub();
  const { key, value, secret } = envFields(envRows()[0]);
  value.focus();
  type(value, 'ghp_neu');
  value.blur();
  key.value = 'GITHUB_PERSONAL_ACCESS_TOKEN';
  secret.click();

  document.getElementById('btn-mcp-server-save').click();
  await flush();
  const { env } = calls[0][1];
  assert.deepEqual(env.GITHUB_PERSONAL_ACCESS_TOKEN, { secret: false, value: 'ghp_neu' });
  assert.equal('GITHUB_TOKEN' in env, false);
});

test('a stored row whose name was changed behind its back still keeps its own name (CR-B14-02)', async () => {
  const { calls } = await editGithub();
  // The field is read-only; a programmatic change must not move the keep
  // onto a name main has nothing stored under.
  envFields(envRows()[0]).key.value = 'GITHUB_PAT';
  document.getElementById('btn-mcp-server-save').click();
  await flush();
  assert.deepEqual(calls[0][1].env, {
    GITHUB_TOKEN: { secret: true, keep: true },
    LANG: { secret: false, value: 'de_DE' },
  });
});

test('the value is masked while "secret" is ticked, and never spell-checked (CR-B14-02)', async () => {
  await editGithub();
  const [stored, plain] = envRows().map(envFields);
  assert.equal(stored.value.type, 'password');
  assert.equal(plain.value.type, 'text', 'a plain value stays readable');

  document.getElementById('btn-mcp-env-add').click();
  const fresh = envFields(envRows()[2]);
  assert.equal(fresh.secret.checked, true, 'secret is the default');
  assert.equal(fresh.value.type, 'password');
  fresh.secret.click();
  assert.equal(fresh.value.type, 'text');
  fresh.secret.click();
  assert.equal(fresh.value.type, 'password');

  for (const field of [stored, plain, fresh]) {
    for (const input of [field.key, field.value]) {
      assert.equal(input.spellcheck, false);
      assert.equal(input.getAttribute('autocomplete'), 'off');
    }
  }
});

// --- CR-B14-03: add does not replace, edit does not reshape the arguments ---

test('"Add server" asks main to refuse a taken id and shows the refusal in the form (CR-B14-03)', async () => {
  const calls = [];
  await mount({
    saveMcpServer: async (payload) => {
      calls.push(payload);
      const refusal = { key: 'mcp.error.idExists', params: { id: 'github' } };
      return payload.create && payload.id === 'github'
        ? { ok: false, error: refusal, errors: [refusal] }
        : { ok: true, ...katalog() };
    },
  });
  document.getElementById('btn-add-mcp-server').click();
  await flush();
  document.getElementById('mcp-field-id').value = 'GitHub';
  document.getElementById('mcp-field-command').value = 'npx';
  document.getElementById('btn-mcp-server-save').click();
  await flush();

  assert.equal(calls[0].create, true);
  assert.equal(dialogOffen(), true);
  assert.equal(document.getElementById('mcp-form-error').textContent,
    'A server \u201cgithub\u201d already exists. Choose another identifier, or edit that server.');
});

test('saving an edited server replaces it and sends no create flag (CR-B14-03)', async () => {
  const { calls } = await editGithub();
  document.getElementById('btn-mcp-server-save').click();
  await flush();
  assert.equal('create' in calls[0][1], false);
});

test('editing only the label leaves the arguments exactly as stored (CR-B14-03)', async () => {
  const args = ['--json', '{"a": 1}', '--prefix', '', 'C:\\srv\\x'];
  const daten = katalog();
  daten.servers[0].args = args;
  const calls = [];
  await mount({
    getMcpCatalog: async () => daten,
    saveMcpServer: async (payload) => { calls.push(['save', payload]); return { ok: true, ...daten }; },
  });
  rows()[0].querySelector('.btn-secondary').click();
  await flush();
  document.getElementById('mcp-field-label').value = 'GitHub (Arbeit)';
  document.getElementById('btn-mcp-server-save').click();
  await flush();
  assert.deepEqual(calls[0][1].args, args);

  // An edited line is read back with the same rules it was written with.
  rows()[0].querySelector('.btn-secondary').click();
  await flush();
  const field = document.getElementById('mcp-field-args');
  field.value += ' --extra';
  document.getElementById('btn-mcp-server-save').click();
  await flush();
  assert.deepEqual(calls[1][1].args, [...args, '--extra']);
});

// --- CR-B14-04: busy state, stale answers, rejected calls ---

/** A promise the test settles by hand — a request that is still running. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const openEdit = async (index) => {
  rows()[index].querySelector('.btn-secondary').click();
  await flush();
};

test('a test answer after Cancel does not reach the next dialog (CR-B14-04)', async () => {
  const pending = deferred();
  let loads = 0;
  await mount({
    testMcpServer: () => pending.promise,
    getMcpCatalog: async () => { loads += 1; return katalog(); },
  });
  await openEdit(0);
  document.getElementById('btn-mcp-server-test').click();
  await flush();
  document.getElementById('btn-mcp-server-cancel').click();
  await openEdit(1);
  assert.equal(document.getElementById('mcp-field-id').value, 'files');
  assert.equal(document.getElementById('btn-mcp-server-test').hasAttribute('aria-disabled'), false,
    'the new dialog is not busy with the old test');

  const before = loads;
  pending.resolve({ ok: true, status: { serverId: 'github', state: 'ready' }, tools: ['a', 'b', 'c'] });
  await flush();
  await flush();
  assert.equal(document.getElementById('mcp-test-result').textContent, '', 'the files dialog shows nothing of it');
  assert.equal(loads, before + 1, 'the list still learns the new status');
});

test('a save answer does not close a newer dialog (CR-B14-04)', async () => {
  const pending = deferred();
  await mount({ saveMcpServer: () => pending.promise });
  await openEdit(0);
  document.getElementById('btn-mcp-server-save').click();
  await flush();
  document.getElementById('btn-mcp-server-cancel').click();
  await openEdit(1);
  document.getElementById('mcp-field-label').value = 'Typed meanwhile';

  pending.resolve({ ok: true, ...katalog() });
  await flush();
  assert.equal(dialogOffen(), true, 'the newer dialog stays open');
  assert.equal(document.getElementById('mcp-field-label').value, 'Typed meanwhile');
});

test('Test, Save and Remove are inert while a request runs (CR-B14-04)', async () => {
  const pending = deferred();
  const calls = [];
  await mount({
    saveMcpServer: (payload) => { calls.push(['save', payload.id]); return pending.promise; },
    testMcpServer: async (id) => { calls.push(['test', id]); return { ok: true, status: { state: 'ready' }, tools: [] }; },
    deleteMcpServer: async (id) => { calls.push(['delete', id]); return { ok: true, ...katalog() }; },
  });
  await openEdit(0);
  const save = document.getElementById('btn-mcp-server-save');
  save.focus();
  save.click();
  await flush();
  for (const id of ['btn-mcp-server-save', 'btn-mcp-server-test', 'btn-mcp-server-delete']) {
    const button = document.getElementById(id);
    assert.equal(button.getAttribute('aria-disabled'), 'true', id);
    assert.equal(button.disabled, false, `${id} keeps its focusability`);
    button.click();
  }
  await flush();
  focusFixup(document);
  assert.equal(document.activeElement, save, 'the pressed button keeps the focus');
  assert.deepEqual(calls, [['save', 'github']], 'no second request while the first runs');
  assert.equal(document.getElementById('btn-mcp-server-cancel').hasAttribute('aria-disabled'), false,
    'Cancel stays live');

  pending.resolve({ ok: false, errors: ['nope'] });
  await flush();
  assert.equal(save.hasAttribute('aria-disabled'), false, 'live again after the answer');
});

test('a rejected save, remove or test shows the failure message (CR-B14-04)', async () => {
  const boom = async () => { throw new Error('EPERM'); };
  await mount({ saveMcpServer: boom, deleteMcpServer: boom, testMcpServer: boom });
  await openEdit(0);
  const formError = document.getElementById('mcp-form-error');

  document.getElementById('btn-mcp-server-save').click();
  await flush();
  assert.equal(dialogOffen(), true);
  assert.equal(formError.textContent, 'The server could not be saved.');

  document.getElementById('btn-mcp-server-delete').click();
  await flush();
  assert.equal(formError.textContent, 'The server could not be deleted.');

  document.getElementById('btn-mcp-server-test').click();
  await flush();
  const result = document.getElementById('mcp-test-result');
  assert.equal(result.textContent, 'The test failed.', 'not left on "Testing …"');
  for (const id of ['btn-mcp-server-save', 'btn-mcp-server-test', 'btn-mcp-server-delete']) {
    assert.equal(document.getElementById(id).hasAttribute('aria-disabled'), false, id);
  }
});

test('a rejected switch goes back and says so (CR-B14-04)', async () => {
  await mount({ saveMcpServer: async () => { throw new Error('EACCES'); } });
  const toggle = rows()[0].querySelector('.ds-switch');
  toggle.click();
  await flush();
  assert.equal(rows()[0].querySelector('.ds-switch').checked, true);
  const error = document.getElementById('settings-mcp-error');
  assert.equal(error.classList.contains('hidden'), false);
  assert.equal(error.textContent, 'The server could not be changed.');
});
