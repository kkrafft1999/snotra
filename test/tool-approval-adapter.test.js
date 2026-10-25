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

test('a front end without cards has its requests answered in the window, and only there (#1194)', async () => {
  let counter = 0;
  const adapter = createToolApprovalAdapter({
    randomUUID: () => `req-${(counter += 1)}`,
    PUSH,
    log: { warn() {} },
    answeredByWindow: (sessionId) => String(sessionId).startsWith('remote:'),
  });
  // No window yet: the request expires, as for any front end without a card.
  assert.equal(adapter.isAvailable('remote:conn-1'), false);
  assert.equal(adapter.isAvailable('other'), false, 'only the front ends named stand behind the window');

  const wc = makeWebContents();
  adapter.subscribe(1, wc);
  assert.equal(adapter.isAvailable('remote:conn-1'), true);
  const pending = adapter.requestApproval({ sessionId: 'remote:conn-1', request: { ...REQUEST, chatId: 'chat-phone' } });
  assert.equal(wc.sent[0].channel, PUSH.TOOL_APPROVAL_REQUEST);
  assert.equal(adapter.listPending(1).length, 1, 'kept under the window');
  assert.equal(adapter.respond('remote:conn-1', { requestId: 'req-1', response: 'allow-once' }).ok, false, 'the front end itself cannot answer it');
  assert.deepEqual(adapter.respond(1, { requestId: 'req-1', response: 'allow-once' }), { ok: true, response: 'allow-once' });
  assert.equal((await pending).response, 'allow-once');

  // The window goes away: its cards go with it, the phone's as well.
  const later = adapter.requestApproval({ sessionId: 'remote:conn-1', request: REQUEST });
  wc.destroy();
  assert.equal((await later).invalidated, true);
});

function makeRemoteAdapter({ follows = () => true } = {}) {
  let counter = 0;
  const events = [];
  const adapter = createToolApprovalAdapter({
    randomUUID: () => `req-${(counter += 1)}`,
    PUSH,
    log: { warn() {} },
    answeredByWindow: (sessionId) => String(sessionId).startsWith('remote:'),
    answeredRemotely: (chatId) => follows(chatId),
  });
  adapter.observe((event) => events.push(event));
  return { adapter, events };
}

const PHONE = { kind: 'relay', client: 'Snotra for iPhone' };

test('without a window, a phone that takes cards answers its own turn\'s card (#1251)', async () => {
  const { adapter, events } = makeRemoteAdapter({ follows: (chatId) => chatId === 'chat-phone' });
  assert.equal(adapter.isAvailable('remote:conn-1', 'chat-phone'), true);
  assert.equal(adapter.isAvailable('remote:conn-1', 'chat-other'), false, 'only a chat the phone follows');
  assert.equal(adapter.isAvailable('remote:conn-1'), false, 'and only with a chat');
  assert.equal(adapter.isAvailable(1, 'chat-phone'), false, 'a window\'s own turn still needs the window');

  const pending = adapter.requestApproval({ sessionId: 'remote:conn-1', request: { ...REQUEST, chatId: 'chat-phone' } });
  assert.deepEqual(events.map((e) => [e.type, e.chatId, e.dto?.requestId]), [['request', 'chat-phone', 'req-1']], 'offered to the phone');
  assert.deepEqual(adapter.listPending().map((dto) => dto.requestId), ['req-1']);
  assert.deepEqual(adapter.respondFromRemote('req-1', { response: 'allow-once' }, PHONE), { ok: true, response: 'allow-once' });
  assert.deepEqual(await pending, { response: 'allow-once', requestId: 'req-1', by: PHONE });

  // A chat no phone follows has nobody to ask, as before.
  const elsewhere = await adapter.requestApproval({ sessionId: 'remote:conn-1', request: { ...REQUEST, chatId: 'chat-other' } });
  assert.deepEqual(elsewhere, { invalidated: true, reason: 'no_approval_ui', requestId: '' });
});

test('a window that opens later takes over the card a phone\'s turn left without one (#1251)', async () => {
  const { adapter } = makeRemoteAdapter();
  const pending = adapter.requestApproval({ sessionId: 'remote:conn-1', request: { ...REQUEST, chatId: 'chat-phone' } });
  const wc = makeWebContents();
  adapter.subscribe(1, wc);
  assert.deepEqual(adapter.listPending(1).map((dto) => dto.requestId), ['req-1'], 'the renderer lists it after subscribing');
  assert.deepEqual(adapter.respond(1, { requestId: 'req-1', response: 'deny' }), { ok: true, response: 'deny' });
  assert.equal((await pending).response, 'deny');
  assert.deepEqual(wc.sent.at(-1), {
    channel: PUSH.TOOL_APPROVAL_RESOLVED,
    payload: { requestId: 'req-1', response: 'deny', invalidated: false, reason: null },
  });
});

test('a closed window leaves a phone\'s card to the phone, and only that card (#1251)', async () => {
  let follows = true;
  const { adapter } = makeRemoteAdapter({ follows: () => follows });
  const wc = makeWebContents();
  adapter.subscribe(1, wc);
  const phone = adapter.requestApproval({ sessionId: 'remote:conn-1', request: { ...REQUEST, chatId: 'chat-phone' } });
  const own = adapter.requestApproval({ sessionId: 1, request: { ...REQUEST, chatId: 'chat-desk' } });
  assert.equal(wc.sent.length, 2, 'both shown in the window');

  wc.destroy();
  assert.equal((await own).invalidated, true, 'the window\'s own card goes with it');
  assert.deepEqual(adapter.listPending().map((dto) => dto.requestId), ['req-1'], 'the phone\'s stays open');
  assert.deepEqual(adapter.respondFromRemote('req-1', { response: 'allow-once' }, PHONE), { ok: true, response: 'allow-once' });
  assert.equal((await phone).response, 'allow-once');

  // No phone that takes cards: the card goes with the window, as before.
  follows = false;
  const wc2 = makeWebContents();
  adapter.subscribe(2, wc2);
  const unfollowed = adapter.requestApproval({ sessionId: 'remote:conn-1', request: { ...REQUEST, chatId: 'chat-phone' } });
  adapter.unsubscribe(2);
  assert.deepEqual(await unfollowed, { invalidated: true, reason: 'no_approval_ui', requestId: 'req-3' });
});

test('a closed window hands a phone\'s card to the window still open (#1251)', async () => {
  const { adapter } = makeRemoteAdapter({ follows: () => false });
  const first = makeWebContents();
  const second = makeWebContents();
  adapter.subscribe(1, first);
  adapter.subscribe(2, second);
  const pending = adapter.requestApproval({ sessionId: 'remote:conn-1', request: { ...REQUEST, chatId: 'chat-phone' } });
  assert.equal(second.sent[0].channel, PUSH.TOOL_APPROVAL_REQUEST, 'shown in the window that subscribed last');
  second.destroy();
  assert.equal(first.sent.at(-1).payload.requestId, 'req-1', 'pushed to the other window');
  assert.deepEqual(adapter.respond(1, { requestId: 'req-1', response: 'allow-once' }), { ok: true, response: 'allow-once' });
  assert.equal((await pending).response, 'allow-once');
});

test('a remote answers allow once or deny; the first valid answer wins and everyone hears who gave it (#1194)', async () => {
  const adapter = makeAdapter();
  const events = [];
  adapter.observe((event) => events.push(event));
  const wc = makeWebContents();
  adapter.subscribe(1, wc);

  const pending = adapter.requestApproval({ sessionId: 1, request: { ...REQUEST, chatId: 'chat-a' } });
  assert.deepEqual(events.map((e) => [e.type, e.chatId, e.dto?.requestId]), [['request', 'chat-a', 'req-1']]);
  const by = { kind: 'relay', client: 'Snotra mobile' };
  assert.deepEqual(adapter.respondFromRemote('req-1', { response: 'allow-session' }, by), { ok: false, reason: 'refused' }, 'refused, not made smaller');
  assert.deepEqual(adapter.respondFromRemote('req-1', { response: 'allow-always' }, by), { ok: false, reason: 'refused' });
  assert.deepEqual(adapter.respondFromRemote('nope', { response: 'deny' }, by), { ok: false, reason: 'not-found' });
  assert.deepEqual(adapter.respondFromRemote('req-1', { response: 'allow-once' }, by), { ok: true, response: 'allow-once' });
  // The tool step keeps who answered (#1197).
  assert.deepEqual(await pending, { response: 'allow-once', requestId: 'req-1', by });
  // The window comes second: the card is settled already.
  assert.equal(adapter.respond(1, { requestId: 'req-1', response: 'deny' }).ok, false);
  assert.deepEqual(events[1], {
    type: 'resolved', requestId: 'req-1', chatId: 'chat-a', response: 'allow-once', invalidated: false, reason: null, by,
  });
  assert.deepEqual(wc.sent.at(-1).payload, { requestId: 'req-1', response: 'allow-once', invalidated: false, reason: null, by }, 'the window takes its card down, saying who answered it');

  // The window answering is named as the desktop; a voided card names nobody.
  const second = adapter.requestApproval({ sessionId: 1, request: { ...REQUEST, chatId: 'chat-a' } });
  adapter.respond(1, { requestId: 'req-2', response: 'deny' });
  assert.equal('by' in (await second), false, 'the window leaves no mark on the step');
  assert.equal('by' in wc.sent.at(-1).payload, false);
  assert.deepEqual(events.at(-1).by, { kind: 'desktop' });
  const third = adapter.requestApproval({ sessionId: 1, request: { ...REQUEST, chatId: 'chat-a' } });
  adapter.invalidateChat('chat-a');
  await third;
  assert.equal(events.at(-1).by, null);
});

test('a remote picks only among a sandbox card\'s offers (#1194)', async () => {
  const adapter = makeAdapter();
  adapter.subscribe(1, makeWebContents());
  const sandbox = { entries: [{ kind: 'write', target: '/w/out', count: 1, folder: true, allow: ['/w/out', '/w'] }] };
  const request = { ...REQUEST, chatId: 'chat-a', checkpoint: 'sandbox', sandbox };
  const by = { kind: 'relay', client: 'phone' };

  const first = adapter.requestApproval({ sessionId: 1, request });
  assert.deepEqual(adapter.respondFromRemote('req-1', { response: 'allow-once', sandboxPaths: ['/etc'] }, by), { ok: false, reason: 'refused' });
  assert.deepEqual(adapter.respondFromRemote('req-1', { response: 'allow-once', sandboxPaths: ['/w', '/x'] }, by), { ok: false, reason: 'refused' });
  assert.equal(adapter.respondFromRemote('req-1', { response: 'allow-once', sandboxPaths: ['/w'] }, by).ok, true);
  assert.deepEqual((await first).sandboxPaths, ['/w']);

  const second = adapter.requestApproval({ sessionId: 1, request });
  adapter.respondFromRemote('req-2', { response: 'allow-once' }, by);
  assert.deepEqual((await second).sandboxPaths, ['/w/out'], 'without a choice, the first offer');

  const third = adapter.requestApproval({ sessionId: 1, request: { ...REQUEST, chatId: 'chat-a' } });
  assert.deepEqual(adapter.respondFromRemote('req-3', { response: 'allow-once', sandboxPaths: ['/w'] }, by), { ok: false, reason: 'refused' }, 'no paths on a card that offers none');
  adapter.respondFromRemote('req-3', { response: 'deny' }, by);
  await third;
});

test('an observer that throws does not hold up a card', async () => {
  const warnings = [];
  let counter = 0;
  const adapter = createToolApprovalAdapter({ randomUUID: () => `req-${(counter += 1)}`, PUSH, log: { warn: (m) => warnings.push(m) } });
  adapter.observe(() => { throw new Error('remote gone'); });
  adapter.subscribe(1, makeWebContents());
  const pending = adapter.requestApproval({ sessionId: 1, request: REQUEST });
  adapter.respond(1, { requestId: 'req-1', response: 'allow-once' });
  assert.equal((await pending).response, 'allow-once');
  assert.equal(warnings.length, 2);
});
