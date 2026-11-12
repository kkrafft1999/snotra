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

test('a redirection target is the host\'s to judge; without a judge no file is accepted (#1379)', async () => {
  const seen = [];
  const matcher = createProgramAllowanceMatcher({
    readAllowances: async () => [ENTRY],
    locate: async () => '/opt/bin/gh',
    realPath: async (target) => target,
    isFileInFolder: async (target, cwd, root) => { seen.push([target, cwd, root]); return target.startsWith('out/'); },
    sandboxSupported: true,
    trustdApplies: true,
  });
  const inside = await matcher.match({ command: 'gh pr list --json number > out/prs.json', cwd: '/ws', workspaceRoot: '/ws' });
  assert.equal(inside.command, '/opt/bin/gh pr list --json number > out/prs.json');
  assert.deepEqual(seen, [['out/prs.json', '/ws', '/ws']]);
  assert.deepEqual((await matcher.match({ command: 'gh pr list > prs.json', cwd: '/ws', workspaceRoot: '/ws' })).skipped,
    { program: 'gh', reason: PROGRAM_ALLOWANCE_SKIP_REASONS.REDIRECT_OUTSIDE });
  assert.deepEqual((await make().match({ command: 'gh pr list > out/prs.json', cwd: '/ws', workspaceRoot: '/ws' })).skipped,
    { program: 'gh', reason: PROGRAM_ALLOWANCE_SKIP_REASONS.REDIRECT_OUTSIDE });
  // /dev/null and duplications need no judge.
  assert.ok((await make().match({ command: 'gh pr list 2>/dev/null 2>&1', cwd: '/ws', workspaceRoot: '/ws' })).allowance);
});
