'use strict';

// The policy's own rules, apart from the signed file (#1172): normalising
// what a file holds, and what survives a failed check — only what tightens.
// The store around them is tested in tool-policy-store.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePolicyPayload, failSafePayload, defaultPayload, policyVersionOf } = require('../src/application/permissions/tool-policy-rules');

const LOOSE = {
  revision: 3,
  mode: 'auto',
  globalRules: [
    { id: 'a', scope: 'global', effect: 'allow', tool: 'read_file_text' },
    { id: 'd', scope: 'global', effect: 'deny', tool: 'shell_execute' },
  ],
  unsandboxedWorkspaces: ['/ws'],
  workspaceModes: { '/ws': 'auto', '/other': 'ask-all' },
  globalHosts: ['api.github.com'],
  newWorkspaceSandboxOff: true,
  autoChats: ['chat-1'],
};

test('a file of nothing becomes the default policy', () => {
  assert.deepEqual(normalizePolicyPayload(null), defaultPayload());
  assert.equal(normalizePolicyPayload({ revision: -1 }).revision, 0);
});

test('a failed check keeps only what tightens (#419, #413, #980)', () => {
  const kept = failSafePayload(LOOSE);
  assert.equal(kept.mode, 'smart');
  assert.deepEqual(kept.globalRules.map((rule) => rule.effect), normalizePolicyPayload(LOOSE).globalRules
    .filter((rule) => rule.effect === 'deny').map((rule) => rule.effect));
  assert.deepEqual(kept.unsandboxedWorkspaces, []);
  assert.deepEqual(kept.workspaceModes, { '/other': 'ask-all' });
  assert.deepEqual(kept.globalHosts, []);
  assert.equal(kept.newWorkspaceSandboxOff, false);
  assert.deepEqual(kept.autoChats, []);
  assert.equal(failSafePayload({ ...LOOSE, mode: 'ask-all' }).mode, 'ask-all', '"Always ask" only tightens');
});

test('the version approvals bind to names the revision and the integrity', () => {
  assert.equal(policyVersionOf(normalizePolicyPayload(LOOSE), 'valid'), '3:valid');
});
