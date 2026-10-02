'use strict';

// Signs the finished macOS bundle and verifies the result (#657, #662).
//
// Runs as an @electron/packager `afterComplete` hook (package.json ->
// config.forge.packagerConfig.afterComplete), i.e. after every change the
// packager makes to the bundle. The fuses plugin signs much earlier, in
// `packageAfterCopy`, while the bundle is still Electron's template; the
// packager rewrites Info.plist afterwards, and the signature no longer
// matches. macOS then refuses the keychain without asking, and safeStorage
// is unavailable for the whole run — that is what shipped in 1.13.3.
//
// Two ways to sign, chosen by the environment:
//
// - SNOTRA_MACOS_SIGN_IDENTITY set (the release job): Developer ID with the
//   hardened runtime and the entitlements in assets/macos/entitlements.plist.
//   With APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER also set, the
//   app is notarised and the ticket stapled to it.
// - otherwise (local builds, no certificate): ad hoc, as before.
//
// The signing lives here rather than in packagerConfig.osxSign because the
// Forge config is static JSON and cannot tell a release build from a local
// one. Verifying in the same step turns a broken signature into a failed
// build instead of a broken release.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ENTITLEMENTS = path.join(__dirname, '..', 'assets', 'macos', 'entitlements.plist');

const defaultRun = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });

function findAppBundle(buildPath, readdir = fs.readdirSync) {
  const apps = readdir(buildPath).filter((name) => name.endsWith('.app'));
  if (apps.length !== 1) {
    throw new Error(`Expected exactly one .app in ${buildPath}, found ${apps.length}.`);
  }
  return path.join(buildPath, apps[0]);
}

function readSigningConfig(env = process.env) {
  const identity = env.SNOTRA_MACOS_SIGN_IDENTITY?.trim();
  if (!identity) return { mode: 'adhoc' };
  const notarize = [env.APPLE_API_KEY, env.APPLE_API_KEY_ID, env.APPLE_API_ISSUER].every(Boolean)
    ? { appleApiKey: env.APPLE_API_KEY, appleApiKeyId: env.APPLE_API_KEY_ID, appleApiIssuer: env.APPLE_API_ISSUER }
    : null;
  return { mode: 'developer-id', identity, keychain: env.SNOTRA_MACOS_KEYCHAIN || undefined, notarize };
}

function verify(appPath, run, what) {
  try {
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || String(error);
    throw new Error(`The ${what} signature of ${appPath} does not verify: ${detail}`);
  }
}

function signAndVerify(appPath, run = defaultRun) {
  run('/usr/bin/codesign', ['--sign', '-', '--force', '--deep', appPath]);
  verify(appPath, run, 'ad-hoc');
}

function developerIdSignOptions(appPath, { identity, keychain }) {
  return {
    app: appPath,
    platform: 'darwin',
    identity,
    keychain,
    // Only the main bundle gets our entitlements; for the helpers osx-sign
    // picks its per-helper defaults when no entitlements are returned.
    optionsForFile: (filePath) => (path.resolve(filePath) === path.resolve(appPath)
      ? { entitlements: ENTITLEMENTS, hardenedRuntime: true }
      : { hardenedRuntime: true }),
  };
}

async function signDeveloperId(appPath, config, {
  sign = require('@electron/osx-sign').signAsync,
  notarize = require('@electron/notarize').notarize,
  run = defaultRun,
} = {}) {
  await sign(developerIdSignOptions(appPath, config));
  verify(appPath, run, 'Developer ID');
  if (!config.notarize) return;
  // Submits a zip of the bundle with notarytool, waits for Apple's verdict
  // and staples the ticket to the app, so it opens offline as well.
  await notarize({ appPath, ...config.notarize });
  run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
}

async function signBundle(appPath, config = readSigningConfig(), deps = {}) {
  if (config.mode === 'developer-id') {
    await signDeveloperId(appPath, config, deps);
  } else {
    signAndVerify(appPath, deps.run);
  }
}

function afterComplete(buildPath, _electronVersion, platform, _arch, done) {
  if (platform !== 'darwin' && platform !== 'mas') {
    done();
    return;
  }
  let appPath;
  try {
    appPath = findAppBundle(buildPath);
  } catch (error) {
    done(error);
    return;
  }
  signBundle(appPath).then(() => done(), (error) => done(error));
}

module.exports = afterComplete;
module.exports.findAppBundle = findAppBundle;
module.exports.readSigningConfig = readSigningConfig;
module.exports.signAndVerify = signAndVerify;
module.exports.signBundle = signBundle;
module.exports.developerIdSignOptions = developerIdSignOptions;
module.exports.ENTITLEMENTS = ENTITLEMENTS;
