'use strict';

// Re-signs the finished macOS bundle ad hoc and verifies the result (#657).
//
// Runs as an @electron/packager `afterComplete` hook (package.json ->
// config.forge.packagerConfig.afterComplete), i.e. after every change the
// packager makes to the bundle. The fuses plugin signs much earlier, in
// `packageAfterCopy`, while the bundle is still Electron's template; the
// packager rewrites Info.plist afterwards, and the signature no longer
// matches. macOS then refuses the keychain without asking, and safeStorage
// is unavailable for the whole run — that is what shipped in 1.13.3.
//
// Verifying in the same step turns a broken signature into a failed build
// instead of a broken release. Once the app is signed with a Developer ID
// (#19), this hook steps aside for `osxSign`.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function findAppBundle(buildPath, readdir = fs.readdirSync) {
  const apps = readdir(buildPath).filter((name) => name.endsWith('.app'));
  if (apps.length !== 1) {
    throw new Error(`Expected exactly one .app in ${buildPath}, found ${apps.length}.`);
  }
  return path.join(buildPath, apps[0]);
}

function signAndVerify(appPath, run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' })) {
  run('/usr/bin/codesign', ['--sign', '-', '--force', '--deep', appPath]);
  try {
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || String(error);
    throw new Error(`The ad-hoc signature of ${appPath} does not verify: ${detail}`);
  }
}

function afterComplete(buildPath, _electronVersion, platform, _arch, done) {
  if (platform !== 'darwin' && platform !== 'mas') {
    done();
    return;
  }
  try {
    signAndVerify(findAppBundle(buildPath));
    done();
  } catch (error) {
    done(error);
  }
}

module.exports = afterComplete;
module.exports.findAppBundle = findAppBundle;
module.exports.signAndVerify = signAndVerify;
