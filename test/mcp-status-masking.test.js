'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { maskMcpStatuses } = require('../src/main/services/mcp-status-masking');
const { createMessage } = require('../src/shared/contracts/message');
const { MASK_TEXT } = require('../src/shared/runtime/sensitive-content');

const SECRET = 'ghp_mcp_token_1234567';

test('maskMcpStatuses masks the error text and the stderr excerpt', () => {
  const [status] = maskMcpStatuses([
    { id: 'gh', state: 'error', error: `failed with ${SECRET}`, stderr: `TOKEN=${SECRET}\n` },
  ], [SECRET]);
  assert.equal(status.id, 'gh');
  assert.equal(status.state, 'error');
  assert.equal(status.error, `failed with ${MASK_TEXT}`);
  assert.equal(status.stderr, `TOKEN=${MASK_TEXT}\n`);
});

test('maskMcpStatuses reaches into the parameters of a catalogue message (#338)', () => {
  const [status] = maskMcpStatuses([
    { id: 'gh', error: createMessage('mcp.error.start', { detail: `env ${SECRET}`, nested: createMessage('x', { v: SECRET }) }), stderr: '' },
  ], [SECRET]);
  assert.equal(status.error.key, 'mcp.error.start');
  assert.equal(status.error.params.detail, `env ${MASK_TEXT}`);
  assert.equal(status.error.params.nested.params.v, MASK_TEXT);
});

test('maskMcpStatuses leaves everything as it is without secrets', () => {
  const statuses = [{ id: 'gh', error: `x ${SECRET}`, stderr: 'y' }];
  assert.equal(maskMcpStatuses(statuses, []), statuses);
  assert.equal(maskMcpStatuses(statuses, null), statuses);
});

test('maskMcpStatuses keeps an error that is neither text nor message', () => {
  const [status] = maskMcpStatuses([{ id: 'gh', error: null, stderr: undefined }], [SECRET]);
  assert.equal(status.error, null);
  assert.equal(status.stderr, '');
});
