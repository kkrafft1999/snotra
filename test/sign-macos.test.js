const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const afterComplete = require('../scripts/sign-macos');

const { findAppBundle, signAndVerify, readSigningConfig, signBundle, developerIdSignOptions, ENTITLEMENTS } = afterComplete;

// #657: the fuses plugin signs before the packager rewrites Info.plist, so the
// finished bundle has to be signed again — and checked — at the very end.
// #662: in the release job that signature is a Developer ID, notarised.

test('the hook is registered as the last step of the packager', () => {
  assert.deepEqual(pkg.config.forge.packagerConfig.afterComplete, ['./scripts/sign-macos.js']);
});

// Forge 8 imports a hook given as a path and keeps only its default export; a
// path that does not resolve is dropped silently, and the app ships unsigned.
// This loads it the way Forge's importSearch does (#88).
test('Forge can load the hook from its path', async () => {
  const { pathToFileURL } = require('node:url');
  const root = path.join(__dirname, '..');
  for (const hook of pkg.config.forge.packagerConfig.afterComplete) {
    const loaded = await import(pathToFileURL(path.resolve(root, hook)).href);
    assert.equal(loaded.default, afterComplete);
  }
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
  assert.throws(() => signAndVerify('/out/Snotra AI.app', run), /ad-hoc signature .* does not verify: invalid Info\.plist/);
});

test('finds exactly one bundle in the build directory', () => {
  assert.equal(findAppBundle('/out/x', () => ['LICENSE', 'Snotra AI.app']), path.join('/out/x', 'Snotra AI.app'));
  assert.throws(() => findAppBundle('/out/x', () => ['LICENSE']), /exactly one \.app/);
  assert.throws(() => findAppBundle('/out/x', () => ['a.app', 'b.app']), /exactly one \.app/);
});

test('leaves Windows and Linux builds alone', async () => {
  for (const platform of ['win32', 'linux']) {
    await afterComplete({ buildPath: '/does/not/exist', electronVersion: '44.5.1', platform, arch: 'x64' });
  }
});

test('hands a failure to the packager as a rejected promise', async () => {
  await assert.rejects(
    afterComplete({ buildPath: '/does/not/exist', electronVersion: '44.5.1', platform: 'darwin', arch: 'arm64' }),
    /ENOENT/,
  );
});

test('without an identity in the environment the build stays ad hoc', () => {
  assert.deepEqual(readSigningConfig({}), { mode: 'adhoc' });
  assert.deepEqual(readSigningConfig({ SNOTRA_MACOS_SIGN_IDENTITY: '  ' }), { mode: 'adhoc' });
});

test('an identity selects Developer ID; notarisation only with all three API values', () => {
  const identity = 'Developer ID Application: Jane Doe (TEAM123456)';
  assert.deepEqual(readSigningConfig({ SNOTRA_MACOS_SIGN_IDENTITY: identity, APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'KEY' }), {
    mode: 'developer-id', identity, keychain: undefined, notarize: null,
  });
  assert.deepEqual(readSigningConfig({
    SNOTRA_MACOS_SIGN_IDENTITY: identity, SNOTRA_MACOS_KEYCHAIN: '/tmp/signing.keychain-db',
    APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'KEY', APPLE_API_ISSUER: 'ISSUER',
  }), {
    mode: 'developer-id', identity, keychain: '/tmp/signing.keychain-db',
    notarize: { appleApiKey: '/k.p8', appleApiKeyId: 'KEY', appleApiIssuer: 'ISSUER' },
  });
});

test('the main bundle gets our entitlements, every part the hardened runtime', () => {
  const options = developerIdSignOptions('/out/Snotra AI.app', { identity: 'X', keychain: undefined });
  assert.equal(options.platform, 'darwin');
  assert.deepEqual(options.optionsForFile('/out/Snotra AI.app'), { entitlements: ENTITLEMENTS, hardenedRuntime: true });
  assert.deepEqual(
    options.optionsForFile('/out/Snotra AI.app/Contents/Frameworks/Snotra AI Helper (Renderer).app'),
    { hardenedRuntime: true },
  );
});

test('the entitlements grant only JIT and the microphone', () => {
  const plist = fs.readFileSync(ENTITLEMENTS, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input']);
});

test('Developer ID: signs, verifies, notarises, then validates the stapled ticket', async () => {
  const steps = [];
  const run = (cmd, args) => steps.push(['run', path.basename(cmd), ...args]);
  await signBundle('/out/Snotra AI.app', {
    mode: 'developer-id', identity: 'X', notarize: { appleApiKey: '/k.p8', appleApiKeyId: 'KEY', appleApiIssuer: 'ISSUER' },
  }, {
    run,
    sign: async (opts) => steps.push(['sign', opts.identity]),
    notarize: async (opts) => steps.push(['notarize', opts.appPath, opts.appleApiKeyId]),
  });
  assert.deepEqual(steps, [
    ['sign', 'X'],
    ['run', 'codesign', '--verify', '--deep', '--strict', '/out/Snotra AI.app'],
    ['notarize', '/out/Snotra AI.app', 'KEY'],
    ['run', 'xcrun', 'stapler', 'validate', '/out/Snotra AI.app'],
  ]);
});

test('Developer ID without API values signs but does not notarise', async () => {
  const steps = [];
  await signBundle('/out/Snotra AI.app', { mode: 'developer-id', identity: 'X', notarize: null }, {
    run: (cmd) => steps.push(path.basename(cmd)),
    sign: async () => steps.push('sign'),
    notarize: async () => { throw new Error('must not notarise'); },
  });
  assert.deepEqual(steps, ['sign', 'codesign']);
});

test('a Developer ID signature that does not verify stops before notarisation', async () => {
  const run = () => { throw Object.assign(new Error('exit 1'), { stderr: Buffer.from('code object is not signed at all') }); };
  await assert.rejects(
    signBundle('/out/Snotra AI.app', { mode: 'developer-id', identity: 'X', notarize: { appleApiKey: 'k' } }, {
      run, sign: async () => {}, notarize: async () => { throw new Error('must not notarise'); },
    }),
    /Developer ID signature .* does not verify: code object is not signed at all/,
  );
});
