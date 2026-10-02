#!/usr/bin/env node
'use strict';

// Downloads the Electron binary before anything needs it (#666).
//
// Since Electron 44 `npm ci` installs only the JavaScript part of the
// `electron` package; the binary is fetched on the first `require('electron')`.
// In CI that first require used to happen in the middle of `npm test`, so a
// network blip on the runner showed up as a failing test. Run right after
// `npm ci`, a failed download is an install problem with a retry instead.
//
// Usage: node scripts/install-electron.js
// Does nothing when the binary for the installed version is already there.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ATTEMPTS = 3;
const ELECTRON_DIR = path.dirname(require.resolve('electron/package.json'));
const INSTALL_SCRIPT = path.join(ELECTRON_DIR, 'install.js');

function binaryPath() {
  try {
    const relative = fs.readFileSync(path.join(ELECTRON_DIR, 'path.txt'), 'utf8');
    const full = path.join(ELECTRON_DIR, 'dist', relative);
    return fs.existsSync(full) ? full : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  // Electron's own installer: checks the checksum and exits early when the
  // binary of this version is already in place.
  const result = spawnSync(process.execPath, [INSTALL_SCRIPT], { stdio: 'inherit' });
  const binary = binaryPath();
  if (result.status === 0 && binary) {
    console.log(`Electron binary ready: ${path.relative(process.cwd(), binary)}`);
    process.exit(0);
  }
  if (attempt < ATTEMPTS) {
    const wait = attempt * 10;
    console.warn(`Electron download failed (attempt ${attempt} of ${ATTEMPTS}), trying again in ${wait} s`);
    sleep(wait * 1000);
  }
}

console.error(`Electron binary could not be downloaded after ${ATTEMPTS} attempts.`);
process.exit(1);
