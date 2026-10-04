const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

// Schutz gegen ein halbes Rename: Paketname, Produktname, Forge-Konfiguration
// und Bundle-ID muessen zusammenpassen (Issue #54).
test('package metadata carries the Snotra AI identity consistently', () => {
  assert.equal(pkg.name, 'snotra');
  assert.equal(pkg.productName, 'Snotra AI');

  const packager = pkg.config.forge.packagerConfig;
  assert.equal(packager.name, pkg.productName);
  assert.equal(packager.executableName, pkg.productName);
  assert.equal(packager.appBundleId, 'dev.snotra-ai.app');
  // The DMG volume name comes from scripts/make-dmg.js since #685, checked in
  // test/make-dmg.test.js.
});

// Der deb-Maker legt /usr/bin/snotra als Symlink auf das Binary im Paket an und
// nimmt dafuer 'options.bin'. Weicht der Wert vom executableName ab, zeigt der
// Symlink ins Leere und die installierte App startet nicht (Issue #100).
test('deb maker points at the packaged executable', () => {
  const deb = pkg.config.forge.makers.find((m) => m.name === '@electron-forge/maker-deb');
  assert.ok(deb, 'maker-deb configured');
  assert.deepEqual(deb.platforms, ['linux']);
  assert.equal(deb.config.options.bin, pkg.config.forge.packagerConfig.executableName);
  assert.match(deb.config.options.maintainer, /^.+ <.+@.+>$/);
  // The .deb control file publishes this address with every Linux download;
  // it is the project's contact address, not an employer's (#453).
  assert.equal(deb.config.options.maintainer, 'Konrad Krafft <konrad.krafft@gmail.com>');
  assert.equal(deb.config.options.icon['512x512'], 'icon.png');
});

// Der AppImage-Maker startet das Binary ueber 'bin' — gleiche Falle wie beim
// deb. The runtime he puts at the front of every AppImage is a binary from
// another project: since #573 it is a local file that
// scripts/fetch-appimage-runtime.js writes only after checking a pinned
// SHA-256, instead of a URL the maker downloads unchecked.
test('AppImage maker starts the packaged executable from a verified runtime', () => {
  const path = require('node:path');
  const { RUNTIME } = require('../scripts/fetch-appimage-runtime.js');
  const appImage = pkg.config.forge.makers.find((m) => m.name === '@reforged/maker-appimage');
  assert.ok(appImage, 'maker-appimage configured');
  assert.deepEqual(appImage.platforms, ['linux']);
  assert.equal(appImage.config.options.bin, pkg.config.forge.packagerConfig.executableName);
  assert.equal(appImage.config.options.icon, 'icon.png');

  assert.equal(appImage.config.options.runtime, RUNTIME.target.split(path.sep).join('/'));
  assert.match(RUNTIME.url, /^https:\/\/github\.com\/AppImage\/type2-runtime\/releases\/download\/\d+\//);
  assert.match(RUNTIME.sha256, /^[0-9a-f]{64}$/);
  assert.match(pkg.scripts['make:linux'], /node scripts\/fetch-appimage-runtime\.js && electron-forge make/);
});

// @reforged/maker-appimage 5.3.1 still asks for maker-base 6 or 7. Left alone,
// it drags the whole Forge 7 chain back in, packager 18 and extract-zip
// included, which is what the move to Forge 8 removed (#88). The override in
// package.json hands it Forge 8's maker-base; once the maker allows ^8 itself,
// the override can go.
test('the AppImage maker runs on the same maker-base as Forge', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const versionOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  const major = (version) => version.split('.')[0];
  const modules = path.join(__dirname, '..', 'node_modules');
  const forge = versionOf(path.join(modules, '@electron-forge', 'core'));
  const nested = path.join(modules, '@reforged', 'maker-appimage', 'node_modules', '@electron-forge', 'maker-base');
  const makerBase = versionOf(fs.existsSync(nested) ? nested : path.join(modules, '@electron-forge', 'maker-base'));
  assert.equal(major(makerBase), major(forge));
});

test('the runtime check accepts only the pinned hash', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { isVerified, sha256 } = require('../scripts/fetch-appimage-runtime.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'runtime');
  fs.writeFileSync(file, 'runtime bytes');
  assert.equal(isVerified(file, sha256(Buffer.from('runtime bytes'))), true);
  assert.equal(isVerified(file, sha256(Buffer.from('other bytes'))), false);
  assert.equal(isVerified(path.join(dir, 'missing')), false);
});

// #572: without fuses, ELECTRON_RUN_AS_NODE turned the shipped binary into a
// plain Node runtime under the app's identity. The keys in package.json are
// FuseV1Options values, so the test spells them out by name.
test('the packaged app flips the Electron fuses that cost nothing', () => {
  const { FuseV1Options, FuseVersion } = require('@electron/fuses');
  const plugin = (pkg.config.forge.plugins || []).find((p) => p.name === '@electron-forge/plugin-fuses');
  assert.ok(plugin, 'fuses plugin configured');
  const fuses = plugin.config;
  assert.equal(fuses.version, FuseVersion.V1);
  assert.equal(fuses[FuseV1Options.RunAsNode], false);
  assert.equal(fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
  assert.equal(fuses[FuseV1Options.EnableNodeCliInspectArguments], false);
  assert.equal(fuses[FuseV1Options.OnlyLoadAppFromAsar], true);
  // Needs a signed build on macOS; decided with code signing (#19).
  assert.equal(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], undefined);
  assert.ok(pkg.devDependencies['@electron-forge/plugin-fuses']);
  assert.ok(pkg.devDependencies['@electron/fuses']);
});

// #573: the renderer loads its own copies from src/renderer/vendor/. As
// dependencies the packages shipped a second time in app.asar/node_modules.
test('vendored renderer libraries are build-time sources only', () => {
  for (const name of ['marked', 'dompurify', 'pdfjs-dist', '@fontsource/inter']) {
    assert.ok(pkg.devDependencies[name], `${name} is a devDependency`);
    assert.equal(pkg.dependencies[name], undefined, `${name} is not shipped as a package`);
  }
});

test('no field of package.json still carries the old product name', () => {
  assert.doesNotMatch(JSON.stringify(pkg), /weyouze/i);
});
