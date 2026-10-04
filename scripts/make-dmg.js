'use strict';

// Builds the macOS DMG from the packaged bundle (#685).
//
// Replaces @electron-forge/maker-dmg, which went through electron-installer-dmg
// and appdmg. That chain showed the Electron logo as the volume icon, failed
// now and then on `hdiutil detach`, and kept appdmg's unmaintained image-size
// dependency in the lock file. Everything here is a system tool: hdiutil,
// ditto and xattr.
//
// The image holds the signed bundle, an /Applications symlink, Snotra's icon
// as .VolumeIcon.icns and a checked-in .DS_Store (assets/macos/dmg-layout.DS_Store)
// that opens the window in icon view, without toolbar or sidebar, with the app
// on the left and Applications on the right. It has no background picture, so
// Finder draws the window in the system colours and the labels stay readable
// in light and dark mode. The layout was decided on a mockup in #685; to change
// it, regenerate the file with Finder on a mounted read-write image and keep
// `backgroundType` at 0.
//
// One step cannot be done from a source folder: Finder shows .VolumeIcon.icns
// only when the volume root carries the custom-icon flag, and `hdiutil create
// -srcfolder` does not copy the root folder's FinderInfo. (`hdiutil makehybrid`
// does, but it also writes a Finder position into every file of the bundle,
// which `codesign --strict` rejects.) So the image is built read-write,
// mounted once without Finder seeing it, flagged, detached and converted to a
// compressed read-only image. appdmg's flaky detach came from a volume Finder
// had been scripting; this mount is never shown to Finder, and a volume that
// is already gone counts as detached.
//
// Signing, notarising and stapling the DMG stay in release.yml (#662).
//
// Usage: node scripts/make-dmg.js   (after `npm run package`; `npm run make`
// does both). Writes out/make/Snotra-AI-<version>-mac-arm64.dmg.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VOLUME_NAME = 'Snotra AI';
const LAYOUT = path.join(ROOT, 'assets', 'macos', 'dmg-layout.DS_Store');
const VOLUME_ICON = path.join(ROOT, 'icon.icns');

// Byte 8 of a folder's FinderInfo holds the high byte of its Finder flags;
// 0x04 there is kHasCustomIcon (0x0400).
const FINDER_INFO = 'com.apple.FinderInfo';
const CUSTOM_ICON_BYTE = 8;
const CUSTOM_ICON_BIT = 0x04;

const DETACH_ATTEMPTS = 5;

const defaultRun = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dmgFileName(version, arch = 'arm64') {
  return `Snotra-AI-${version}-mac-${arch}.dmg`;
}

function stage(dir, { appPath, layoutPath = LAYOUT, iconPath = VOLUME_ICON, run = defaultRun }) {
  fs.mkdirSync(dir, { recursive: true });
  // `ditto` keeps the bundle's symlinks, modes and extended attributes intact,
  // which the signature depends on.
  run('/usr/bin/ditto', [appPath, path.join(dir, path.basename(appPath))]);
  fs.symlinkSync('/Applications', path.join(dir, 'Applications'));
  fs.copyFileSync(iconPath, path.join(dir, '.VolumeIcon.icns'));
  fs.copyFileSync(layoutPath, path.join(dir, '.DS_Store'));
}

function withCustomIconFlag(finderInfoHex) {
  const bytes = Buffer.alloc(32);
  const current = Buffer.from((finderInfoHex || '').replace(/\s+/g, ''), 'hex');
  current.copy(bytes, 0, 0, Math.min(current.length, bytes.length));
  bytes[CUSTOM_ICON_BYTE] |= CUSTOM_ICON_BIT;
  return bytes.toString('hex');
}

function setCustomIcon(volumePath, run = defaultRun) {
  let current = '';
  try {
    current = run('/usr/bin/xattr', ['-px', FINDER_INFO, volumePath]).toString();
  } catch {
    // A fresh volume root has no FinderInfo yet; start from zeros.
  }
  run('/usr/bin/xattr', ['-wx', FINDER_INFO, withCustomIconFlag(current), volumePath]);
}

function isMounted(mountPoint) {
  try {
    return fs.statSync(mountPoint).dev !== fs.statSync(path.dirname(mountPoint)).dev;
  } catch {
    return false;
  }
}

async function detach(mountPoint, {
  run = defaultRun, sleep = defaultSleep, mounted = isMounted, attempts = DETACH_ATTEMPTS,
} = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    if (!mounted(mountPoint)) return;
    try {
      run('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet', ...(i === attempts ? ['-force'] : [])]);
      return;
    } catch (error) {
      lastError = error;
      await sleep(1000 * i);
    }
  }
  if (!mounted(mountPoint)) return;
  const detail = lastError?.stderr?.toString().trim() || lastError?.message || String(lastError);
  throw new Error(`Could not detach ${mountPoint}: ${detail}`);
}

async function makeDmg({
  appPath, outPath, layoutPath = LAYOUT, iconPath = VOLUME_ICON,
  run = defaultRun, sleep = defaultSleep, mounted = isMounted, tmpRoot = os.tmpdir(),
}) {
  const work = fs.mkdtempSync(path.join(tmpRoot, 'snotra-dmg-'));
  try {
    const source = path.join(work, 'stage');
    const rwImage = path.join(work, 'rw.dmg');
    const mountPoint = path.join(work, 'mnt');
    stage(source, { appPath, layoutPath, iconPath, run });

    run('/usr/bin/hdiutil', [
      'create', '-quiet', '-srcfolder', source, '-volname', VOLUME_NAME,
      '-fs', 'HFS+', '-format', 'UDRW', '-ov', rwImage,
    ]);
    fs.mkdirSync(mountPoint);
    run('/usr/bin/hdiutil', [
      'attach', '-quiet', rwImage, '-readwrite', '-nobrowse', '-noverify', '-noautoopen',
      '-mountpoint', mountPoint,
    ]);
    try {
      setCustomIcon(mountPoint, run);
    } finally {
      await detach(mountPoint, { run, sleep, mounted });
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    run('/usr/bin/hdiutil', ['convert', '-quiet', rwImage, '-format', 'ULFO', '-ov', '-o', outPath]);
    return outPath;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('make-dmg needs macOS (hdiutil).');
  }
  const pkg = require(path.join(ROOT, 'package.json'));
  const arch = 'arm64';
  const buildPath = path.join(ROOT, 'out', `${pkg.productName}-darwin-${arch}`);
  const appPath = path.join(buildPath, `${pkg.productName}.app`);
  if (!fs.existsSync(appPath)) {
    throw new Error(`${appPath} not found. Run \`npm run package\` first.`);
  }
  const outPath = path.join(ROOT, 'out', 'make', dmgFileName(pkg.version, arch));
  await makeDmg({ appPath, outPath });
  console.log(`DMG written: ${path.relative(ROOT, outPath)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  makeDmg, stage, detach, setCustomIcon, withCustomIconFlag, isMounted, dmgFileName,
  VOLUME_NAME, LAYOUT, VOLUME_ICON,
};
