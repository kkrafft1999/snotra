const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMessageOrigin, MESSAGE_ORIGIN_CLIENT_MAX } = require('../src/shared/contracts/remote/message-origin');
const contracts = require('../src/shared/contracts');

test('an origin from the phone is kept with its name, cleaned and bounded (#1197)', () => {
  assert.deepEqual(normalizeMessageOrigin({ kind: 'relay', client: 'iPhone' }), { kind: 'relay', client: 'iPhone' });
  assert.deepEqual(normalizeMessageOrigin({ kind: 'relay', client: ' a\u0000b c\td ' }), { kind: 'relay', client: 'a b c d' });
  assert.deepEqual(normalizeMessageOrigin({ kind: 'relay' }), { kind: 'relay', client: '' });
  assert.deepEqual(normalizeMessageOrigin({ kind: 'relay', client: 42 }), { kind: 'relay', client: '' });
  assert.equal(normalizeMessageOrigin({ kind: 'relay', client: 'y'.repeat(500) }).client.length, MESSAGE_ORIGIN_CLIENT_MAX);
});

test('the window, an unknown kind and anything else leave no origin', () => {
  for (const raw of [undefined, null, 'relay', [], {}, { kind: 'desktop' }, { kind: 'local', client: 'cli' }, { kind: 'RELAY' }]) {
    assert.equal(normalizeMessageOrigin(raw), null, JSON.stringify(raw));
  }
});

test('the renderer gets the same normaliser through the contract bundle', () => {
  assert.equal(contracts.normalizeMessageOrigin, normalizeMessageOrigin);
});
