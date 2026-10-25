'use strict';

// The matching of a program allowance as a rule of the core (#1172): what a
// host hands in decides which file a name is; the rule decides the rest.
// The end-to-end cases with real files are in program-allowances.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProgramAllowanceMatcher } = require('../src/application/permissions/program-allowance-match');
const { PROGRAM_ALLOWANCE_SKIP_REASONS } = require('../src/shared/contracts/program-allowances');

const ENTRY = { path: '/opt/bin/gh', domains: ['api.github.com'], writePaths: [], trustd: true, credentials: [] };

function make({ sandboxSupported = true, trustdApplies = true, located = '/opt/bin/gh' } = {}) {
  return createProgramAllowanceMatcher({
    readAllowances: async () => [ENTRY],
    locate: async () => located,
    realPath: async (target) => target,
    sandboxSupported,
    trustdApplies,
  });
}

test('a simple command running the allowed file gets the allowance, with the file\'s absolute path', async () => {
  const result = await make().match({ command: 'gh pr list', cwd: '/ws' });
  assert.equal(result.command, '/opt/bin/gh pr list');
  assert.deepEqual(result.allowance, { path: '/opt/bin/gh', program: 'gh', domains: ['api.github.com'], writePaths: [], trustd: true, credentials: [] });
});

test('without a sandbox there is nothing to widen; trustd only where it applies', async () => {
  assert.equal(await make({ sandboxSupported: false }).match({ command: 'gh pr list' }), null);
  assert.equal((await make({ trustdApplies: false }).match({ command: 'gh pr list' })).allowance.trustd, false);
});

test('another file of the same name, or a compound line, is told apart', async () => {
  assert.deepEqual(await make({ located: '/ws/gh' }).match({ command: 'gh pr list', cwd: '/ws' }),
    { skipped: { program: 'gh', reason: PROGRAM_ALLOWANCE_SKIP_REASONS.OTHER_FILE } });
  const compound = await make().match({ command: 'gh pr list && rm -rf /' });
  assert.equal(compound.skipped.program, 'gh');
});
