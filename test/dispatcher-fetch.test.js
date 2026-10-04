'use strict';

// #699: since undici 8 the runtime's own fetch refuses an Agent from the undici
// package before it connects. These tests make real connections, so a request
// that carries such an Agent is proven to reach its server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { Agent } = require('undici');
const { fetchVia } = require('../src/main/services/dispatcher-fetch');
const compatible = require('../src/main/providers/openai-compatible');

const MODELS = JSON.stringify({ data: [{ id: 'local-model' }] });

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

/** A throwaway self-signed certificate, or null where openssl is missing. */
function selfSignedCertificate(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', cert,
    ], { stdio: 'ignore' });
  } catch {
    return null;
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

test('fetchVia reaches the server through an Agent from the undici package (#699)', async (t) => {
  const port = await listen(t, http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  }));
  const agent = new Agent({ connect: { rejectUnauthorized: false } });
  t.after(() => agent.close());

  const res = await fetchVia(`http://127.0.0.1:${port}/`, { dispatcher: agent });

  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'hello');
});

test('fetchVia leaves a request without a dispatcher to the runtime fetch (#699)', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url, options });
    return { ok: true };
  };

  await fetchVia('https://example.org/', { method: 'GET' });

  assert.deepEqual(seen, [{ url: 'https://example.org/', options: { method: 'GET' } }]);
});

test('an OpenAI-compatible server with a self-signed certificate answers when insecure TLS is on (#699)', async (t) => {
  const tls = selfSignedCertificate(t);
  if (!tls) {
    t.skip('openssl is not available to create a test certificate');
    return;
  }
  const port = await listen(t, https.createServer(tls, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(MODELS);
  }));
  t.after(() => compatible.dispose());
  const baseUrl = `https://127.0.0.1:${port}/v1`;

  const insecure = await compatible.listModels({ baseUrl, insecureTls: true });
  assert.deepEqual(insecure, { models: [{ id: 'local-model', label: 'local-model' }] });

  // Without the exception the certificate is still checked.
  const checked = await compatible.listModels({ baseUrl, insecureTls: false });
  assert.ok(checked.error, 'a self-signed certificate must be refused by default');
});
