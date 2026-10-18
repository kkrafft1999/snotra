// The feedback form's way to the endpoint (#1045): what main sends, and how
// each answer of the endpoint comes back to the form.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FEEDBACK_ENDPOINT,
  createFeedbackService,
  osVersionReader,
  resolveFeedbackEndpoint,
} = require('../src/main/services/feedback-service');

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function makeService({ respond = () => jsonResponse(201, { id: 'f1', issueUrl: 'https://github.com/kkrafft1999/snotra/issues/1200' }), ...overrides } = {}) {
  const requests = [];
  const service = createFeedbackService({
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return respond(url, init);
    },
    getAppVersion: () => '1.25.0',
    platform: 'darwin',
    arch: 'arm64',
    getOsVersion: () => '15.1.0',
    isKnownProvider: (id) => ['openai', 'anthropic'].includes(id),
    ...overrides,
  });
  return { service, requests };
}

const INPUT = Object.freeze({
  kind: 'idea',
  message: '  Export a chat as Markdown, please.  ',
  email: '',
  includeDiagnostics: true,
  providerId: 'openai',
  locale: 'de',
});

test('a message goes to the endpoint as the contract describes it (#1045)', async () => {
  const { service, requests } = makeService();
  const result = await service.send(INPUT);

  assert.deepEqual(result, { ok: true, issueUrl: 'https://github.com/kkrafft1999/snotra/issues/1200' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, FEEDBACK_ENDPOINT);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(requests[0].body, {
    kind: 'idea',
    message: 'Export a chat as Markdown, please.',
    diagnostics: { appVersion: '1.25.0', os: 'macOS 15.1.0', arch: 'arm64', provider: 'openai' },
    locale: 'de',
  });
});

test('unticked diagnostics and an empty address are left out, a typed one goes along (#1045)', async () => {
  const { service, requests } = makeService();
  await service.send({ ...INPUT, includeDiagnostics: false, email: ' du@example.com ' });
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['email', 'kind', 'locale', 'message']);
  assert.equal(requests[0].body.email, 'du@example.com');
});

test('only a built-in provider is named; one the user set up is not (#1045)', () => {
  const { service } = makeService();
  assert.equal(service.getDiagnostics('anthropic').provider, 'anthropic');
  assert.equal(service.getDiagnostics('acme-internal-gateway').provider, '');
  assert.equal(service.getDiagnostics('').provider, '');
});

test('the diagnostics stay single lines of at most 100 characters (#1045)', () => {
  const { service } = makeService({
    getAppVersion: () => `1.0\n${'x'.repeat(200)}`,
    platform: 'win32',
    getOsVersion: () => { throw new Error('no'); },
  });
  const diag = service.getDiagnostics('openai');
  assert.equal(diag.os, 'Windows');
  assert.ok(!diag.appVersion.includes('\n'));
  assert.equal([...diag.appVersion].length, 100);
});

test('main checks the input again and sends nothing it would refuse (#1045)', async () => {
  const { service, requests } = makeService();
  assert.deepEqual(await service.send({ ...INPUT, kind: 'rant' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await service.send({ ...INPUT, message: '   ' }), { ok: false, reason: 'emptyMessage' });
  assert.deepEqual(await service.send({ ...INPUT, message: '😀'.repeat(5001) }), { ok: false, reason: 'tooLong' });
  assert.deepEqual(await service.send({ ...INPUT, email: 'not-an-address' }), { ok: false, reason: 'invalidEmail' });
  assert.deepEqual(await service.send({ ...INPUT, email: 42 }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await service.send(null), { ok: false, reason: 'invalid' });
  assert.equal(requests.length, 0);
});

test('5,000 emoji are 5,000 characters, as the endpoint counts them (#1045)', async () => {
  const { service, requests } = makeService();
  const result = await service.send({ ...INPUT, message: '😀'.repeat(5000) });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
});

test('a locale that is no language tag stays out of the request (#1045)', async () => {
  const { service, requests } = makeService();
  await service.send({ ...INPUT, locale: 'de; drop table' });
  assert.equal('locale' in requests[0].body, false);
});

test('each answer of the endpoint becomes a reason the form words (#1045)', async () => {
  const cases = [
    [() => jsonResponse(409, { error: 'duplicate' }), { ok: false, reason: 'duplicate' }],
    [() => jsonResponse(413, { error: 'message_too_long' }), { ok: false, reason: 'tooLong' }],
    [() => jsonResponse(400, { error: 'invalid_email' }), { ok: false, reason: 'invalidEmail' }],
    [() => jsonResponse(400, { error: 'unknown_field' }), { ok: false, reason: 'invalid' }],
    [() => jsonResponse(429, { error: 'rate_limited', retryAfter: 1800 }), { ok: false, reason: 'rateLimited', retryAfter: 1800 }],
    [() => jsonResponse(429, {}, { 'Retry-After': '60' }), { ok: false, reason: 'rateLimited', retryAfter: 60 }],
    [() => jsonResponse(502, { error: 'upstream_failed' }), { ok: false, reason: 'server' }],
    [() => jsonResponse(503, { error: 'unavailable' }), { ok: false, reason: 'server' }],
    [() => new Response('<html>Bad gateway</html>', { status: 504 }), { ok: false, reason: 'server' }],
  ];
  for (const [respond, expected] of cases) {
    const { service } = makeService({ respond });
    assert.deepEqual(await service.send(INPUT), expected);
  }
});

test('a 201 with an address outside the repository keeps no link (#1045)', async () => {
  const { service } = makeService({ respond: () => jsonResponse(201, { id: 'x', issueUrl: 'https://evil.example/issues/1' }) });
  assert.deepEqual(await service.send(INPUT), { ok: true, issueUrl: null });
});

test('no network is "network", no answer in time is "timeout" (#1045)', async () => {
  const offline = makeService({ respond: () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(await offline.service.send(INPUT), { ok: false, reason: 'network' });

  const slow = makeService({
    timeoutMs: 20,
    respond: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  });
  assert.deepEqual(await slow.service.send(INPUT), { ok: false, reason: 'timeout' });
});

test('only a loopback address may replace the endpoint (#1045)', () => {
  assert.equal(resolveFeedbackEndpoint({}), FEEDBACK_ENDPOINT);
  assert.equal(resolveFeedbackEndpoint({ SNOTRA_FEEDBACK_ENDPOINT: 'http://127.0.0.1:4711/api/feedback' }), 'http://127.0.0.1:4711/api/feedback');
  assert.equal(resolveFeedbackEndpoint({ SNOTRA_FEEDBACK_ENDPOINT: 'https://evil.example/api' }), FEEDBACK_ENDPOINT);
  assert.equal(resolveFeedbackEndpoint({ SNOTRA_FEEDBACK_ENDPOINT: 'not a url' }), FEEDBACK_ENDPOINT);
});

test('the OS version comes from Electron, and from the kernel release in plain Node', () => {
  const os = { release: () => '24.1.0' };
  assert.equal(osVersionReader({ getSystemVersion: () => '15.1' }, os)(), '15.1');
  assert.equal(osVersionReader({}, os)(), '24.1.0');
});
