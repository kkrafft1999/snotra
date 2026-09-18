// Verbindungsverwaltung fuer MCP-Server (Issue #106).
//
// Gegenspieler ist ein echter Kindprozess (test/helpers/fake-mcp-server.js),
// keine Attrappe: Zeilen-Framing ueber Chunk-Grenzen, CRLF unter Windows, ein
// Server, der mitten im Aufruf stirbt, und einer, der auf das Schliessen von
// stdin nicht reagiert — das sind genau die Faelle, die ein gefaelschter
// Stream nicht pruefen wuerde. Dieselbe Linie wie bei #86.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const path = require('path');

const { createMcpService } = require('../src/main/services/mcp-service');
const { MCP_CONNECTION_STATES } = require('../src/shared/contracts/mcp');

const FAKE = path.join(__dirname, 'helpers', 'fake-mcp-server.js');

/** Konfiguration fuer den Fake-Server im gewuenschten Verhalten. */
function server(id, mode = 'ok', extra = {}) {
  return { id, label: id, command: process.execPath, args: [FAKE, mode], ...extra };
}

/**
 * Dienst samt Buchfuehrung ueber alle gestarteten Prozesse — nur so laesst
 * sich pruefen, dass am Ende keiner uebrig bleibt.
 */
function makeService(options = {}) {
  const children = [];
  const spawn = (command, args, opts) => {
    const child = childProcess.spawn(command, args, opts);
    children.push(child);
    return child;
  };
  const service = createMcpService({
    spawn,
    timeouts: { HANDSHAKE_MS: 4_000, REQUEST_MS: 4_000 },
    ...options,
  });
  return { service, children };
}

/** Wartet, bis der Prozess wirklich weg ist (oder die Frist ablaeuft). */
async function waitGone(child, ms = 6_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function statusOf(service, id) {
  return service.describeConnections().find((s) => s.serverId === id);
}

test('ein stdio-Server liefert seinen Tool-Katalog', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files')]);

  const tools = await service.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['echo', 'add']);
  assert.equal(tools[0].serverId, 'files');
  assert.equal(tools[0].description, 'Gibt den Text zurück.');

  const status = statusOf(service, 'files');
  assert.equal(status.state, MCP_CONNECTION_STATES.READY);
  assert.equal(status.toolCount, 2);
  assert.equal(status.serverName, 'fake-mcp');
  assert.equal(status.serverVersion, '1.2.3');
  assert.equal(status.protocolVersion, '2025-06-18');
  assert.equal(status.error, '');
});

test('tools/call liefert das Ergebnis des Servers', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files')]);

  const result = await service.callTool({ serverId: 'files', name: 'add', args: { a: 2, b: 40 } });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [{ type: 'text', text: '42' }]);
});

test('Antworten über Chunk-Grenzen und mit CRLF werden zusammengesetzt', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files', 'split')]);

  const tools = await service.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['echo', 'add']);
  const result = await service.callTool({ serverId: 'files', name: 'echo', args: { text: 'hallo' } });
  assert.equal(result.content[0].text, 'hallo');
});

test('Nicht-JSON auf stdout bringt die Verbindung nicht um', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files', 'noisy')]);

  const tools = await service.listTools();
  assert.equal(tools.length, 2);
});

test('tools/list wird über nextCursor hinweg eingesammelt', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files', 'paginate')]);

  const tools = await service.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['echo', 'add']);
});

test('ein Server ohne tools-Fähigkeit ist verbunden, aber leer', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files', 'no-tools')]);

  assert.deepEqual(await service.listTools(), []);
  assert.equal(statusOf(service, 'files').state, MCP_CONNECTION_STATES.READY);
});

test('ein fachlicher Fehler des Tools ist ein Ergebnis, kein Wurf', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files', 'tool-error')]);

  const result = await service.callTool({ serverId: 'files', name: 'echo', args: {} });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Datei nicht gefunden.');
});

test('ein JSON-RPC-Fehler kommt als Wurf mit der Servermeldung', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files', 'error-on-call')]);

  await assert.rejects(
    () => service.callTool({ serverId: 'files', name: 'echo', args: {} }),
    /Unbekanntes Tool.*-32602/s,
  );
});

test('ein nicht antwortender Aufruf läuft in ein Zeitlimit statt zu hängen', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files', 'slow-call')]);

  await assert.rejects(
    () => service.callTool({ serverId: 'files', name: 'echo', args: {} }, { timeoutMs: 250 }),
    /nicht innerhalb von/,
  );
  // Die Verbindung steht weiter — ein Zeitlimit betrifft die Anfrage, nicht den Server.
  assert.equal(statusOf(service, 'files').state, MCP_CONNECTION_STATES.READY);
});

test('ein hängender Handshake läuft in das Handshake-Zeitlimit', async (t) => {
  const { service } = makeService({ timeouts: { HANDSHAKE_MS: 300, REQUEST_MS: 300 } });
  t.after(() => service.shutdown());
  service.setServers([server('files', 'slow-init')]);

  assert.deepEqual(await service.listTools(), []);
  const status = statusOf(service, 'files');
  assert.equal(status.state, MCP_CONNECTION_STATES.FAILED);
  assert.match(status.error, /nicht innerhalb von/);
});

test('AbortSignal beendet den Aufruf sofort', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files', 'slow-call')]);
  await service.listTools();

  const controller = new AbortController();
  const pending = service.callTool({ serverId: 'files', name: 'echo' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, /abgebrochen/);
});

test('ein nicht startbares Kommando meldet Klartext statt zu hängen', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([{ id: 'kaputt', label: 'kaputt', command: 'snotra-gibt-es-nicht-xyz', args: [] }]);

  assert.deepEqual(await service.listTools(), []);
  const status = statusOf(service, 'kaputt');
  assert.equal(status.state, MCP_CONNECTION_STATES.FAILED);
  assert.match(status.error, /konnte nicht gestartet werden|nicht erreichbar/);
});

test('ein Server, der beim Start abbricht, liefert seinen stderr-Auszug mit', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files', 'die-on-start')]);

  assert.deepEqual(await service.listTools(), []);
  const status = statusOf(service, 'files');
  assert.equal(status.state, MCP_CONNECTION_STATES.FAILED);
  assert.match(status.stderr, /Konfiguration unvollständig/);
});

test('stirbt der Server mitten im Aufruf, scheitert die Anfrage mit klarer Meldung', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files', 'crash-on-call')]);
  assert.equal((await service.listTools()).length, 2);

  await assert.rejects(
    () => service.callTool({ serverId: 'files', name: 'echo' }),
    /unerwartet beendet/,
  );

  const status = statusOf(service, 'files');
  assert.equal(status.state, MCP_CONNECTION_STATES.FAILED);
  assert.equal(status.toolCount, 0, 'tote Server bieten keine Tools mehr an');
  // Und der naechste Aufruf haengt nicht, sondern sagt, was los ist.
  await assert.rejects(() => service.callTool({ serverId: 'files', name: 'echo' }), /unerwartet beendet/);
  assert.deepEqual(await service.listTools(), []);
});

test('ein kaputter Server lässt die übrigen unberührt', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('gut'), server('kaputt', 'die-on-start')]);

  const tools = await service.listTools();
  assert.deepEqual(tools.map((tool) => `${tool.serverId}:${tool.name}`), ['gut:echo', 'gut:add']);
  assert.equal(statusOf(service, 'gut').state, MCP_CONNECTION_STATES.READY);
  assert.equal(statusOf(service, 'kaputt').state, MCP_CONNECTION_STATES.FAILED);
});

test('abgeschaltete Server und abgewählte Tools tauchen nicht auf', async (t) => {
  const { service, children } = makeService();
  t.after(() => service.shutdown());
  service.setServers([
    server('aus', 'ok', { enabled: false }),
    server('teilweise', 'ok', { disabledTools: ['add'] }),
  ]);

  const tools = await service.listTools();
  assert.deepEqual(tools.map((tool) => `${tool.serverId}:${tool.name}`), ['teilweise:echo']);
  assert.equal(children.length, 1, 'ein abgeschalteter Server wird gar nicht erst gestartet');
  await assert.rejects(() => service.callTool({ serverId: 'aus', name: 'echo' }), /abgeschaltet/);
  await assert.rejects(() => service.callTool({ serverId: 'teilweise', name: 'add' }), /abgewählt/);
});

test('setServers meldet ungültige Einträge und doppelte Kennungen', () => {
  const { service } = makeService();
  const result = service.setServers([
    server('files'),
    { id: 'ohne-kommando' },
    server('files'),
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.servers.map((s) => s.id), ['files']);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors.map((e) => e.errors.join(' ')).join(' '), /Kommando/);
  assert.match(result.errors.map((e) => e.errors.join(' ')).join(' '), /doppelt/);
});

test('gleichzeitige Aufrufe starten den Server nur einmal', async (t) => {
  const { service, children } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files')]);

  const [a, b, c] = await Promise.all([service.listTools(), service.listTools(), service.listTools()]);
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  assert.equal(c.length, 2);
  assert.equal(children.length, 1);
});

test('connect verbindet nach einem Fehlschlag erneut', async (t) => {
  const { service } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files', 'crash-on-call')]);
  await service.listTools();
  await service.callTool({ serverId: 'files', name: 'echo' }).catch(() => {});
  assert.equal(statusOf(service, 'files').state, MCP_CONNECTION_STATES.FAILED);

  const status = await service.connect('files');
  assert.equal(status.state, MCP_CONNECTION_STATES.READY);
  assert.equal(status.toolCount, 2);
});

test('shutdown lässt keinen Kindprozess zurück', async (t) => {
  const { service, children } = makeService();
  service.setServers([server('a'), server('b')]);
  await service.listTools();
  assert.equal(children.length, 2);

  await service.shutdown();
  for (const child of children) {
    assert.equal(await waitGone(child), true, `Prozess ${child.pid} läuft noch`);
  }
});

test('ein Server, der auf EOF nicht reagiert, wird hart beendet', async (t) => {
  const { service, children } = makeService();
  service.setServers([server('stur', 'ignore-eof')]);
  await service.listTools();
  assert.equal(children.length, 1);

  await service.shutdown();
  assert.equal(await waitGone(children[0]), true, 'der sture Server läuft noch');
});

test('eine geänderte Konfiguration beendet den alten Prozess', async (t) => {
  const { service, children } = makeService();
  t.after(() => service.shutdown());
  service.setServers([server('files')]);
  await service.listTools();

  service.setServers([server('files', 'ok', { args: [FAKE, 'ok', 'anders'] })]);
  assert.equal(await waitGone(children[0]), true, 'der alte Prozess läuft noch');
  assert.equal((await service.listTools()).length, 2);
});

test('nach einer geglueckten Verbindung wird der Tool-Katalog gemeldet (#170)', async (t) => {
  const gemeldet = [];
  const { service } = makeService({
    rememberTools: async (id, names) => { gemeldet.push([id, names]); },
  });
  t.after(() => service.shutdown());
  await service.setServers([server('eins', 'ok')]);
  await service.listTools();

  assert.deepEqual(gemeldet, [['eins', ['echo', 'add']]]);
});

test('ein Fehler beim Merken kostet die Verbindung nicht (#170)', async (t) => {
  const { service } = makeService({
    rememberTools: async () => { throw new Error('Platte voll'); },
  });
  t.after(() => service.shutdown());
  await service.setServers([server('eins', 'ok')]);
  const tools = await service.listTools();

  assert.equal(tools.length, 2, 'die Tools stehen trotzdem bereit');
});
