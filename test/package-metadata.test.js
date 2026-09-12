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

  const dmg = pkg.config.forge.makers.find((m) => m.name === '@electron-forge/maker-dmg');
  assert.ok(dmg, 'maker-dmg configured');
  assert.equal(dmg.config.name, pkg.productName);
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
  assert.equal(deb.config.options.icon['512x512'], 'icon.png');
});

test('no field of package.json still carries the old product name', () => {
  assert.doesNotMatch(JSON.stringify(pkg), /weyouze/i);
});
