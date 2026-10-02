const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const pkg = require('../package.json');
const afterComplete = require('../scripts/sign-macos-adhoc');

const { findAppBundle, signAndVerify } = afterComplete;

// #657: the fuses plugin signs before the packager rewrites Info.plist, so the
// finished bundle has to be signed again — and checked — at the very end.

test('the hook is registered as the last step of the packager', () => {
  assert.deepEqual(pkg.config.forge.packagerConfig.afterComplete, ['./scripts/sign-macos-adhoc.js']);
});

test('signs the whole bundle ad hoc, then verifies it strictly', () => {
  const calls = [];
  signAndVerify('/out/Snotra AI.app', (cmd, args) => calls.push([cmd, ...args]));
  assert.deepEqual(calls, [
    ['/usr/bin/codesign', '--sign', '-', '--force', '--deep', '/out/Snotra AI.app'],
    ['/usr/bin/codesign', '--verify', '--deep', '--strict', '/out/Snotra AI.app'],
  ]);
});

test('a signature that does not verify fails with the reason from codesign', () => {
  const run = (_cmd, args) => {
    if (args[0] === '--verify') {
      throw Object.assign(new Error('exit 1'), { stderr: Buffer.from('invalid Info.plist (plist or signature have been modified)\n') });
    }
  };
  assert.throws(() => signAndVerify('/out/Snotra AI.app', run), /does not verify: invalid Info\.plist/);
});

test('finds exactly one bundle in the build directory', () => {
  assert.equal(findAppBundle('/out/x', () => ['LICENSE', 'Snotra AI.app']), path.join('/out/x', 'Snotra AI.app'));
  assert.throws(() => findAppBundle('/out/x', () => ['LICENSE']), /exactly one \.app/);
  assert.throws(() => findAppBundle('/out/x', () => ['a.app', 'b.app']), /exactly one \.app/);
});

test('leaves Windows and Linux builds alone', () => {
  for (const platform of ['win32', 'linux']) {
    let result = 'not called';
    afterComplete('/does/not/exist', '44.5.1', platform, 'x64', (error) => { result = error; });
    assert.equal(result, undefined);
  }
});

test('hands a failure to the packager instead of throwing', () => {
  let result;
  afterComplete('/does/not/exist', '44.5.1', 'darwin', 'arm64', (error) => { result = error; });
  assert.ok(result instanceof Error);
});
