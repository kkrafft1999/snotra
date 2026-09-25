// JSON-RPC ueber stdio (Issue #106) — die Schutzpfade, die der Dienst-Test
// nicht von aussen erreicht: ein Server ohne Zeilenende, eine Anfrage an eine
// tote Verbindung und ein Abbruch, der schon vor dem Senden feststeht.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const path = require('path');

const { createStdioTransport } = require('../src/main/services/mcp-stdio-transport');
const { normalizeMcpServerConfig } = require('../src/shared/contracts/mcp');

const FAKE = path.join(__dirname, 'helpers', 'fake-mcp-server.js');

function transportFor(mode) {
  return createStdioTransport({
    config: normalizeMcpServerConfig({ id: 'fake', label: 'fake', command: process.execPath, args: [FAKE, mode] }),
    spawn: childProcess.spawn,
  });
}

test('eine übergroße Antwort ohne Zeilenende bricht ab statt zu puffern', async (t) => {
  const transport = transportFor('flood');
  t.after(() => transport.close());
  await transport.start();
  await transport.request('initialize', {}, { timeoutMs: 4_000 });

  await assert.rejects(
    () => transport.request('tools/list', {}, { timeoutMs: 10_000 }),
    /oversized answer without a line break/,
  );
});

test('eine Anfrage ohne laufenden Prozess scheitert sofort', async () => {
  const transport = transportFor('ok');
  await assert.rejects(() => transport.request('tools/list', {}), /is not connected/);
});

test('ein bereits abgebrochenes Signal verhindert das Senden', async (t) => {
  const transport = transportFor('ok');
  t.after(() => transport.close());
  await transport.start();

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => transport.request('initialize', {}, { signal: controller.signal }), /Request cancelled/);
});

test('ein nicht startbares Kommando wirft mit Klartext', async () => {
  const transport = createStdioTransport({
    config: normalizeMcpServerConfig({ id: 'weg', label: 'weg', command: 'snotra-gibt-es-nicht-xyz' }),
    spawn: childProcess.spawn,
  });
  await assert.rejects(() => transport.start(), /could not be started/);
  assert.equal(transport.isAlive(), false);
});

test('close auf einer nie gestarteten Verbindung ist kein Fehler', async () => {
  const transport = transportFor('ok');
  await transport.close();
  assert.equal(transport.isAlive(), false);
});
