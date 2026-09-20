// Wo steckt die Installation, und welches Release-Asset passt dazu (Issue #232)?
//
// Diese Entscheidung faellt auf jeder Plattform anders und laesst sich auf
// keiner davon gefahrlos ausprobieren — deshalb sind die Funktionen rein und
// werden hier fuer alle Plattformen gleichzeitig geprueft.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectInstallTarget,
  pickReleaseAsset,
  macAppBundlePath,
  isLinuxSystemPath,
} = require('../src/main/services/update-targets');

const RELEASE_ASSETS = [
  { name: 'Snotra-AI-1.8.0-mac-arm64.dmg', size: 120, browser_download_url: 'https://github.com/x/y/a.dmg' },
  { name: 'Snotra-AI-1.8.0-win-x64.zip', size: 130, browser_download_url: 'https://github.com/x/y/a.zip' },
  { name: 'Snotra-AI-1.8.0-linux-x64.deb', size: 140, browser_download_url: 'https://github.com/x/y/a.deb' },
  { name: 'Snotra-AI-1.8.0-linux-x64.AppImage', size: 150, browser_download_url: 'https://github.com/x/y/a.AppImage' },
  { name: 'Snotra-AI-1.8.0-linux-x64.tar.gz', size: 160, browser_download_url: 'https://github.com/x/y/a.tar.gz' },
];

test('macAppBundlePath schneidet den Bundle-Pfad aus dem Programmpfad', () => {
  assert.equal(
    macAppBundlePath('/Applications/Snotra AI.app/Contents/MacOS/Snotra AI'),
    '/Applications/Snotra AI.app'
  );
  assert.equal(macAppBundlePath('/usr/local/bin/electron'), '');
  assert.equal(macAppBundlePath(undefined), '');
});

test('isLinuxSystemPath erkennt Paketverzeichnisse', () => {
  assert.equal(isLinuxSystemPath('/opt/Snotra AI'), true);
  assert.equal(isLinuxSystemPath('/usr/lib/snotra'), true);
  assert.equal(isLinuxSystemPath('/home/konrad/apps/snotra'), false);
});

test('ein Entwicklungs-Build aktualisiert sich nicht selbst', () => {
  const target = detectInstallTarget({
    platform: 'darwin',
    execPath: '/Applications/Snotra AI.app/Contents/MacOS/Snotra AI',
    isPackaged: false,
  });
  assert.equal(target.kind, 'dev');
  assert.equal(target.canSelfUpdate, false);
  assert.match(target.reason, /Entwicklungs-Build/);
});

test('macOS liefert das .app-Bundle als Ziel', () => {
  const target = detectInstallTarget({
    platform: 'darwin',
    execPath: '/Applications/Snotra AI.app/Contents/MacOS/Snotra AI',
  });
  assert.deepEqual(target, {
    kind: 'macos-bundle',
    canSelfUpdate: true,
    appBundlePath: '/Applications/Snotra AI.app',
  });
});

test('macOS ohne Bundle-Struktur verweigert den Selbst-Tausch', () => {
  const target = detectInstallTarget({ platform: 'darwin', execPath: '/tmp/electron' });
  assert.equal(target.kind, 'unsupported');
  assert.equal(target.canSelfUpdate, false);
});

test('Windows liefert das Installationsverzeichnis', () => {
  const target = detectInstallTarget({
    platform: 'win32',
    execPath: 'C:\\Users\\k\\AppData\\Local\\Snotra AI\\Snotra AI.exe',
  });
  assert.equal(target.kind, 'windows-dir');
  assert.equal(target.installDir, 'C:\\Users\\k\\AppData\\Local\\Snotra AI');
  assert.equal(target.canSelfUpdate, true);
});

test('Linux erkennt ein laufendes AppImage an $APPIMAGE', () => {
  const target = detectInstallTarget({
    platform: 'linux',
    execPath: '/tmp/.mount_abc/snotra',
    env: { APPIMAGE: '/home/konrad/Apps/Snotra-AI.AppImage' },
  });
  assert.equal(target.kind, 'linux-appimage');
  assert.equal(target.appImagePath, '/home/konrad/Apps/Snotra-AI.AppImage');
});

test('Linux in /opt gilt als Paketinstallation und bleibt unangetastet', () => {
  const target = detectInstallTarget({
    platform: 'linux',
    execPath: '/opt/Snotra AI/Snotra AI',
  });
  assert.equal(target.kind, 'linux-package');
  assert.equal(target.canSelfUpdate, false);
  assert.match(target.reason, /Administratorrechte/);
});

test('Linux in einem entpackten Ordner darf tauschen', () => {
  const target = detectInstallTarget({
    platform: 'linux',
    execPath: '/home/konrad/apps/snotra-ai/Snotra AI',
  });
  assert.equal(target.kind, 'linux-dir');
  assert.equal(target.installDir, '/home/konrad/apps/snotra-ai');
});

test('eine unbekannte Plattform aktualisiert sich nicht selbst', () => {
  const target = detectInstallTarget({ platform: 'aix', execPath: '/x/y' });
  assert.equal(target.kind, 'unsupported');
  assert.equal(target.canSelfUpdate, false);
});

test('jede Installationsart bekommt ihr eigenes Asset', () => {
  const pick = (kind, arch) => pickReleaseAsset({ assets: RELEASE_ASSETS, kind, arch })?.name;
  assert.equal(pick('macos-bundle', 'arm64'), 'Snotra-AI-1.8.0-mac-arm64.dmg');
  assert.equal(pick('windows-dir', 'x64'), 'Snotra-AI-1.8.0-win-x64.zip');
  assert.equal(pick('linux-appimage', 'x64'), 'Snotra-AI-1.8.0-linux-x64.AppImage');
  assert.equal(pick('linux-dir', 'x64'), 'Snotra-AI-1.8.0-linux-x64.tar.gz');
});

test('das Tarball-Asset zieht nicht das AppImage mit und umgekehrt', () => {
  const tar = pickReleaseAsset({ assets: RELEASE_ASSETS, kind: 'linux-dir', arch: 'x64' });
  const img = pickReleaseAsset({ assets: RELEASE_ASSETS, kind: 'linux-appimage', arch: 'x64' });
  assert.ok(tar.name.endsWith('.tar.gz'));
  assert.ok(img.name.endsWith('.AppImage'));
});

test('Installationsarten ohne Selbst-Update bekommen kein Asset', () => {
  for (const kind of ['dev', 'linux-package', 'unsupported']) {
    assert.equal(pickReleaseAsset({ assets: RELEASE_ASSETS, kind }), null, kind);
  }
});

test('ein Release ohne passendes Paket liefert null statt zu raten', () => {
  const assets = [
    { name: 'quelltext.tar.gz', size: 1, browser_download_url: 'https://github.com/x/y/s.tar.gz' },
    { name: 'symbole.tar.gz', size: 1, browser_download_url: 'https://github.com/x/y/d.tar.gz' },
  ];
  // Zwei Kandidaten, keiner mit Arch-Kennung: lieber nichts anbieten, als das
  // Falsche einzuspielen.
  assert.equal(pickReleaseAsset({ assets, kind: 'linux-dir', arch: 'x64' }), null);
  assert.equal(pickReleaseAsset({ assets: [], kind: 'macos-bundle' }), null);
});

test('ein einzelner Kandidat ohne Arch-Kennung wird genommen', () => {
  const assets = [{ name: 'Snotra-AI.dmg', size: 7, browser_download_url: 'https://github.com/x/y/a.dmg' }];
  assert.equal(pickReleaseAsset({ assets, kind: 'macos-bundle', arch: 'arm64' })?.size, 7);
});

test('Assets ohne Download-Adresse werden verworfen', () => {
  const assets = [{ name: 'Snotra-AI-1.8.0-mac-arm64.dmg', size: 5 }];
  assert.equal(pickReleaseAsset({ assets, kind: 'macos-bundle', arch: 'arm64' }), null);
});
