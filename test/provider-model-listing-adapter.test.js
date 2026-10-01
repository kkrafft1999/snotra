'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const providers = require('../src/main/providers');
const { createProviderModelListingAdapter } = require('../src/main/adapters/provider-model-listing-adapter');
const { normalizeListModelsRequest } = require('../src/shared/contracts/settings');

const STORED = {
  openai: { apiKey: 'sk-stored-openai' },
  'openai-compatible': {
    apiKey: 'stored-gateway-key',
    baseUrl: 'https://gateway.corp.example/v1',
    extraHeaders: 'X-Gateway-Token: stored-header',
  },
};

function adapterWith(stored = STORED, providerRuntime = providers) {
  return createProviderModelListingAdapter({
    providerRuntime,
    providerSecrets: { getEffectiveProviderConfig: async (id) => stored[id] },
  });
}

/** A provider that only records the config it was called with. */
function recordingRuntime(fields, defaultBaseUrl = '') {
  const seen = [];
  const provider = {
    id: 'p',
    fields,
    defaultBaseUrl,
    async listModels(config) {
      seen.push(config);
      return { models: [] };
    },
  };
  return { seen, runtime: { getProvider: (id) => (id === 'p' ? provider : null) } };
}

async function list(adapter, payload) {
  const req = normalizeListModelsRequest(payload);
  return adapter.listModels(req.providerId, req);
}

// The experiment from #537: what a renderer can send over SETTINGS_LIST_MODELS
// must not carry a stored secret to a host of its choosing.
test('stored keys and headers never reach a URL the request names (#537)', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, token: req.headers['x-gateway-token'] });
    res.setHeader('content-type', 'application/json');
    res.end('{"data":[]}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const foreign = `http://127.0.0.1:${server.address().port}/v1`;
  const adapter = adapterWith();

  // OpenAI has no URL field: the requested one is ignored, so nothing reaches
  // the foreign host at all (the request goes to api.openai.com instead).
  const openai = recordingRuntime({ apiKey: true });
  await list(adapterWith({ p: STORED.openai }, openai.runtime), { providerId: 'p', baseUrl: foreign });
  assert.equal(openai.seen[0].baseUrl, '');
  assert.equal(openai.seen[0].apiKey, 'sk-stored-openai');

  await list(adapter, { providerId: 'openai-compatible', baseUrl: foreign, presetId: 'p1' });
  assert.deepEqual(seen, [{ auth: undefined, token: undefined }]);
});

test('the stored connection is used as before when the URL is unchanged', async () => {
  const { seen, runtime } = recordingRuntime({ apiKey: true, baseUrl: true, extraHeaders: true });
  const adapter = adapterWith({ p: STORED['openai-compatible'] }, runtime);

  await list(adapter, { providerId: 'p' });
  await list(adapter, { providerId: 'p', baseUrl: ' https://gateway.corp.example/v1/ ' });

  for (const config of seen) {
    assert.equal(config.baseUrl, 'https://gateway.corp.example/v1');
    assert.equal(config.apiKey, 'stored-gateway-key');
    assert.equal(config.extraHeaders, 'X-Gateway-Token: stored-header');
  }
});

test('a draft URL gets only what the request itself brings', async () => {
  const { seen, runtime } = recordingRuntime({ apiKey: true, baseUrl: true, extraHeaders: true });
  const adapter = adapterWith({ p: STORED['openai-compatible'] }, runtime);

  await list(adapter, { providerId: 'p', baseUrl: 'http://localhost:1234/v1' });
  assert.equal(seen[0].baseUrl, 'http://localhost:1234/v1');
  assert.equal(seen[0].apiKey, '');
  assert.equal(seen[0].extraHeaders, undefined);

  await list(adapter, {
    providerId: 'p',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'fresh-key',
    extraHeaders: 'X-Fresh: 1',
  });
  assert.equal(seen[1].apiKey, 'fresh-key');
  assert.equal(seen[1].extraHeaders, 'X-Fresh: 1');
});

test('the provider default counts as the stored URL', async () => {
  const { seen, runtime } = recordingRuntime({ apiKey: true, baseUrl: true }, 'http://localhost:11434');
  const adapter = adapterWith({ p: { apiKey: 'stored' } }, runtime);

  await list(adapter, { providerId: 'p', baseUrl: 'http://localhost:11434/' });
  assert.equal(seen[0].apiKey, 'stored');
});
