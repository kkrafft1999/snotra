// Freigabe-Adapter (Issue #66, Konzept §6): requestId-Bindung, fremde und
// doppelte Antworten, fehlende UI, Verfall durch Abbruch, Fenster und Kontext.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolApprovalAdapter } = require('../src/main/adapters/tool-approval-adapter');
const { PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');

function makeWebContents() {
  const sent = [];
  const listeners = new Map();
  let destroyed = false;
  return {
    sent,
    send: (channel, payload) => sent.push({ channel, payload }),
    isDestroyed: () => destroyed,
    once: (event, fn) => listeners.set(event, fn),
    destroy() {
      destroyed = true;
      listeners.get('destroyed')?.();
    },
  };
}

function makeAdapter() {
  let counter = 0;
  return createToolApprovalAdapter({ randomUUID: () => `req-${(counter += 1)}`, PUSH, log: { warn() {} } });
}

const REQUEST = { tool: 'write_file_text', riskClasses: ['write'], targets: [{ path: 'a.md', kind: 'file' }], reason: 'r', mode: 'smart', sessionAllowed: true, planKey: 'p', policyVersion: 'v' };

test('ohne angemeldete Oberfläche verfällt jede Anfrage sofort (fail-safe)', async () => {
  const adapter = makeAdapter();
  assert.equal(adapter.isAvailable(1), false);
  const outcome = await adapter.requestApproval({ sessionId: 1, request: REQUEST });
  assert.deepEqual(outcome, { invalidated: true, reason: 'no_approval_ui', requestId: '' });
});

test('Anfrage geht als versioniertes DTO an das angemeldete Fenster und wird durch eine eigene Antwort gelöst', async () => {
  const adapter = makeAdapter();
  const wc = makeWebContents();
  adapter.subscribe(1, wc);
  assert.equal(adapter.isAvailable(1), true);

  const pending = adapter.requestApproval({ sessionId: 1, request: REQUEST });
  assert.equal(wc.sent.length, 1);
  assert.equal(wc.sent[0].channel, PUSH.TOOL_APPROVAL_REQUEST);
  const dto = wc.sent[0].payload;
  assert.equal(dto.requestId, 'req-1');
  assert.equal(dto.contractVersion, 1);
  assert.equal(dto.sessionAllowed, true);
  assert.equal('planKey' in dto, false, 'interne Bindung bleibt im Main');
  assert.equal(adapter.listPending(1).length, 1);

  assert.deepEqual(adapter.respond(1, { requestId: 'req-1', response: 'allow-once' }), { ok: true, response: 'allow-once' });
  assert.deepEqual(await pending, { response: 'allow-once', requestId: 'req-1' });
  assert.equal(adapter.pendingCount(), 0);
  assert.equal(wc.sent[1].channel, PUSH.TOOL_APPROVAL_RESOLVED);
  assert.deepEqual(wc.sent[1].payload, { requestId: 'req-1', response: 'allow-once', invalidated: false, reason: null });
});

test('fremde, doppelte, verspätete und ungültige Antworten geben nichts frei', async () => {
  const adapter = makeAdapter();
  const wc1 = makeWebContents();
  const wc2 = makeWebContents();
  adapter.subscribe(1, wc1);
  adapter.subscribe(2, wc2);

  const pending = adapter.requestApproval({ sessionId: 1, request: REQUEST });
  assert.equal(adapter.respond(2, { requestId: 'req-1', response: 'allow-once' }).ok, false, 'anderes Fenster');
  assert.equal(adapter.respond(1, { requestId: 'req-99', response: 'allow-once' }).ok, false, 'unbekannte ID');
  assert.equal(adapter.respond(1, { requestId: 'req-1', response: 'allow-forever' }).ok, false, 'ungültige Antwort');
  assert.equal(adapter.pendingCount(), 1, 'Anfrage bleibt offen');

  assert.equal(adapter.respond(1, { requestId: 'req-1', response: 'deny' }).ok, true);
  assert.equal((await pending).response, 'deny');
  assert.equal(adapter.respond(1, { requestId: 'req-1', response: 'allow-once' }).ok, false, 'verspätete Antwort nach Entscheidung');
});

test('allow-session wird zur Einzelfreigabe, wenn die Karte die Option nicht anbot', async () => {
  const adapter = makeAdapter();
  const wc = makeWebContents();
  adapter.subscribe(1, wc);
  const pending = adapter.requestApproval({ sessionId: 1, request: { ...REQUEST, sessionAllowed: false, riskClasses: ['delete'] } });
  assert.deepEqual(adapter.respond(1, { requestId: 'req-1', response: 'allow-session' }), { ok: true, response: 'allow-once' });
  assert.equal((await pending).response, 'allow-once');
});

test('Abbruch des Laufs, Fenster-Schließen und Kontextwechsel invalidieren offene Anfragen', async () => {
  const adapter = makeAdapter();
  const wc = makeWebContents();
  adapter.subscribe(1, wc);

  const controller = new AbortController();
  const aborted = adapter.requestApproval({ sessionId: 1, request: REQUEST, abortSignal: controller.signal });
  controller.abort();
  assert.deepEqual(await aborted, { invalidated: true, reason: 'request_invalidated', requestId: 'req-1' });

  const byContext = adapter.requestApproval({ sessionId: 1, request: REQUEST });
  adapter.invalidateAll('request_invalidated');
  assert.equal((await byContext).invalidated, true);
  assert.equal(wc.sent.filter((s) => s.channel === PUSH.TOOL_APPROVAL_RESOLVED).at(-1).payload.invalidated, true);

  const byWindow = adapter.requestApproval({ sessionId: 1, request: REQUEST });
  wc.destroy();
  assert.equal((await byWindow).invalidated, true);
  assert.equal(adapter.isAvailable(1), false, 'zerstörtes Fenster ist abgemeldet');

  // Bereits abgebrochenes Signal: sofortiger Verfall, keine Karte.
  const pre = new AbortController();
  pre.abort();
  const before = wc.sent.length;
  const immediate = await adapter.requestApproval({ sessionId: 2, request: REQUEST, abortSignal: pre.signal });
  assert.equal(immediate.invalidated, true);
  assert.equal(wc.sent.length, before);
});

test('unsubscribe verwirft offene Anfragen mit Grund fehlende UI', async () => {
  const adapter = makeAdapter();
  const wc = makeWebContents();
  adapter.subscribe(1, wc);
  const pending = adapter.requestApproval({ sessionId: 1, request: REQUEST });
  adapter.unsubscribe(1);
  assert.equal((await pending).reason, 'no_approval_ui');
  assert.equal(adapter.isAvailable(1), false);
});
