const test = require('node:test');
const assert = require('node:assert/strict');
const { endpointHost, isLocalEndpoint } = require('../src/shared/contracts/provider-endpoint');

test('endpointHost liest den Host aus jeder Schreibweise', () => {
  assert.equal(endpointHost('http://localhost:1234/v1'), 'localhost');
  assert.equal(endpointHost('HTTPS://API.OpenAI.com/v1'), 'api.openai.com');
  assert.equal(endpointHost('http://[::1]:8080/v1'), '::1');
  assert.equal(endpointHost('http://user:pw@gw.example/v1'), 'gw.example');
  // Ohne Schema ist `localhost:1234/v1` fuer URL ein eigenes Protokoll; der
  // Rueckfall liest den Host trotzdem.
  assert.equal(endpointHost('localhost:1234/v1'), 'localhost');
  assert.equal(endpointHost(''), '');
  assert.equal(endpointHost(null), '');
  assert.equal(endpointHost(42), '');
});

test('lokal sind nur Namen, die unstrittig auf diesen Rechner zeigen', () => {
  for (const url of [
    'http://localhost:1234/v1',
    'http://127.0.0.1:8080/v1',
    'http://127.0.0.2:8080/v1',
    'http://[::1]:11434',
    'http://mein-mac.local:11434/v1',
    'http://0.0.0.0:8000/v1',
  ]) {
    assert.equal(isLocalEndpoint(url), true, url);
  }
});

test('ein privates Netz zaehlt nicht als lokal', () => {
  // Dort steht in aller Regel ein anderer, oft deutlich schnellerer Rechner;
  // das enge lokale Verlaufsbudget waere da schlicht falsch.
  for (const url of [
    'http://192.168.1.5:1234/v1',
    'http://10.0.0.7:8000/v1',
    'https://openrouter.ai/api/v1',
    'https://gw.intern.example/v1',
    'https://api.openai.com/v1',
    '',
    undefined,
  ]) {
    assert.equal(isLocalEndpoint(url), false, String(url));
  }
});

test('ein Host, der nur auf .local endet, zaehlt — .localhost nicht ungeprueft', () => {
  assert.equal(isLocalEndpoint('http://drucker.local'), true);
  assert.equal(isLocalEndpoint('http://nicht-local.example'), false);
});
