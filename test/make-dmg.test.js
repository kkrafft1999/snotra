const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pkg = require('../package.json');
const {
  makeDmg, detach, withCustomIconFlag, dmgFileName, VOLUME_NAME, LAYOUT, VOLUME_ICON, BACKGROUND,
  BACKGROUND_IN_VOLUME,
} = require('../scripts/make-dmg');

// #685: the DMG is built with hdiutil instead of maker-dmg/appdmg. These tests
// replace every system tool; the real image is checked by the release job.

// Symlinks need extra rights on Windows; the script only ever runs on macOS.
const posixOnly = { skip: process.platform === 'win32' && 'symlinks need extra rights on Windows' };

const ROOT = path.join(__dirname, '..');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-make-dmg-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Records the commands and plays the parts of ditto and hdiutil that the
// script looks at afterwards.
function fakeTools({ failDetach = 0 } = {}) {
  const calls = [];
  let staged = null;
  let detachFailures = failDetach;
  const run = (cmd, args) => {
    calls.push([path.basename(cmd), ...args]);
    if (cmd.endsWith('ditto')) fs.mkdirSync(args[1], { recursive: true });
    if (cmd.endsWith('hdiutil') && args[0] === 'create') {
      const src = args[args.indexOf('-srcfolder') + 1];
      staged = Object.fromEntries(fs.readdirSync(src).map((name) => [name, fs.lstatSync(path.join(src, name))]));
      staged.applicationsTarget = fs.readlinkSync(path.join(src, 'Applications'));
      staged.background = fs.statSync(path.join(src, BACKGROUND_IN_VOLUME));
    }
    if (cmd.endsWith('hdiutil') && args[0] === 'detach' && detachFailures > 0) {
      detachFailures -= 1;
      throw Object.assign(new Error('detach failed'), { stderr: Buffer.from('Resource busy') });
    }
    if (cmd.endsWith('hdiutil') && args[0] === 'convert') fs.writeFileSync(args[args.indexOf('-o') + 1], 'dmg');
    if (cmd.endsWith('xattr') && args[0] === '-px') throw new Error('No such xattr');
    return Buffer.alloc(0);
  };
  return { run, calls, staged: () => staged };
}

test('the DMG name matches what release.yml and the self-updater expect', () => {
  assert.equal(dmgFileName('1.15.0'), 'Snotra-Agent-1.15.0-mac-arm64.dmg');
  assert.ok(dmgFileName('1.15.0').endsWith('.dmg'), 'update-targets picks the macOS asset by its .dmg suffix');
  assert.equal(VOLUME_NAME, pkg.productName);
});

test('maker-dmg is gone, npm run make builds the DMG with the script', () => {
  assert.equal(pkg.config.forge.makers.some((m) => m.name === '@electron-forge/maker-dmg'), false);
  assert.equal(pkg.devDependencies['@electron-forge/maker-dmg'], undefined);
  assert.match(pkg.scripts.make, /npm run package && node scripts\/make-dmg\.js$/);
});

test('sets only the custom-icon flag and keeps the rest of the FinderInfo', () => {
  const empty = withCustomIconFlag('');
  assert.equal(empty.length, 64);
  assert.equal(Buffer.from(empty, 'hex')[8], 0x04);
  assert.equal(Buffer.from(empty, 'hex').filter(Boolean).length, 1);

  const existing = '00 00 00 00 00 00 00 00 40 10 00 00 00 00 00 00\n'
    + '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00';
  const flagged = Buffer.from(withCustomIconFlag(existing), 'hex');
  assert.equal(flagged[8], 0x44);
  assert.equal(flagged[9], 0x10);
});

test('stages the bundle, Applications, the volume icon, the background and the layout, then flags, detaches and converts', posixOnly, async (t) => {
  const dir = tmpDir(t);
  const appPath = path.join(dir, 'Snotra Agent.app');
  const outPath = path.join(dir, 'out', 'make', dmgFileName('1.0.0'));
  const tools = fakeTools();
  let mountedChecks = 0;

  await makeDmg({
    appPath, outPath, run: tools.run, tmpRoot: dir, sleep: async () => {},
    mounted: () => (mountedChecks += 1) === 1,
  });

  const staged = tools.staged();
  assert.ok(staged['Snotra Agent.app'].isDirectory());
  assert.ok(staged.Applications.isSymbolicLink());
  assert.equal(staged.applicationsTarget, '/Applications');
  assert.equal(staged['.VolumeIcon.icns'].size, fs.statSync(VOLUME_ICON).size);
  assert.equal(staged['.DS_Store'].size, fs.statSync(LAYOUT).size);
  assert.equal(staged.background.size, fs.statSync(BACKGROUND).size);

  assert.deepEqual(tools.calls.map((c) => c.slice(0, 2)), [
    ['ditto', appPath],
    ['hdiutil', 'create'],
    ['hdiutil', 'attach'],
    ['xattr', '-px'],
    ['xattr', '-wx'],
    ['hdiutil', 'detach'],
    ['hdiutil', 'convert'],
  ]);
  const create = tools.calls[1];
  assert.equal(create[create.indexOf('-volname') + 1], 'Snotra Agent');
  assert.equal(create[create.indexOf('-format') + 1], 'UDRW');
  // The mount stays hidden from Finder: no window, no Spotlight, no surprise.
  assert.ok(tools.calls[2].includes('-nobrowse'));
  assert.ok(tools.calls[2].includes('-noautoopen'));
  const write = tools.calls[4];
  assert.equal(write[2], 'com.apple.FinderInfo');
  assert.equal(Buffer.from(write[3], 'hex')[8], 0x04);
  const convert = tools.calls[6];
  assert.equal(convert[convert.indexOf('-format') + 1], 'ULFO');
  assert.equal(convert[convert.indexOf('-o') + 1], outPath);

  assert.ok(fs.existsSync(outPath));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('snotra-dmg-')), [], 'work folder removed');
});

test('still detaches and cleans up when flagging the volume fails', posixOnly, async (t) => {
  const dir = tmpDir(t);
  const tools = fakeTools();
  const run = (cmd, args) => {
    if (cmd.endsWith('xattr') && args[0] === '-wx') {
      tools.calls.push(['xattr', '-wx']);
      throw new Error('Operation not permitted');
    }
    return tools.run(cmd, args);
  };
  let mountedChecks = 0;

  await assert.rejects(makeDmg({
    appPath: path.join(dir, 'Snotra Agent.app'), outPath: path.join(dir, 'x.dmg'), run, tmpRoot: dir,
    sleep: async () => {}, mounted: () => (mountedChecks += 1) === 1,
  }), /Operation not permitted/);

  assert.ok(tools.calls.some((c) => c[0] === 'hdiutil' && c[1] === 'detach'));
  assert.equal(tools.calls.some((c) => c[1] === 'convert'), false);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('snotra-dmg-')), []);
});

test('detach retries a busy volume and forces the last attempt', async () => {
  const tools = fakeTools({ failDetach: 4 });
  const waits = [];
  await detach('/mnt', { run: tools.run, sleep: async (ms) => waits.push(ms), mounted: () => true, attempts: 5 });
  const detaches = tools.calls.filter((c) => c[1] === 'detach');
  assert.equal(detaches.length, 5);
  assert.equal(detaches.slice(0, 4).some((c) => c.includes('-force')), false);
  assert.ok(detaches[4].includes('-force'));
  assert.deepEqual(waits, [1000, 2000, 3000, 4000]);
});

// appdmg failed exactly here: the volume was already gone when it detached.
test('a volume that is already gone counts as detached', async () => {
  const tools = fakeTools({ failDetach: 1 });
  let checks = 0;
  await detach('/mnt', { run: tools.run, sleep: async () => {}, mounted: () => (checks += 1) === 1 });
  assert.equal(tools.calls.filter((c) => c[1] === 'detach').length, 1);
});

test('detach gives up with the tool\'s message when the volume stays mounted', async () => {
  const tools = fakeTools({ failDetach: 3 });
  await assert.rejects(
    detach('/mnt', { run: tools.run, sleep: async () => {}, mounted: () => true, attempts: 3 }),
    /Could not detach \/mnt: Resource busy/,
  );
});

// Reads the few bplist00 types Finder writes into a .DS_Store record.
function readBinaryPlist(buf) {
  assert.equal(buf.subarray(0, 8).toString('latin1'), 'bplist00');
  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer[6];
  const refSize = trailer[7];
  const top = Number(trailer.readBigUInt64BE(16));
  const tableAt = Number(trailer.readBigUInt64BE(24));
  const uint = (at, size) => buf.subarray(at, at + size).reduce((n, b) => n * 256 + b, 0);
  const offset = (ref) => uint(tableAt + ref * offsetSize, offsetSize);
  const read = (ref) => {
    let at = offset(ref);
    const marker = buf[at];
    const [type, info] = [marker >> 4, marker & 0x0f];
    if (type === 0x0) return info === 0x09;
    if (type === 0x1) return uint(at + 1, 1 << info);
    if (type === 0x2) return info === 3 ? buf.readDoubleBE(at + 1) : buf.readFloatBE(at + 1);
    let count = info;
    at += 1;
    if (count === 0x0f) {
      const size = 1 << (buf[at] & 0x0f);
      count = uint(at + 1, size);
      at += 1 + size;
    }
    if (type === 0x4) return Buffer.from(buf.subarray(at, at + count));
    if (type === 0x5) return buf.subarray(at, at + count).toString('latin1');
    if (type === 0x6) return Buffer.from(buf.subarray(at, at + 2 * count)).swap16().toString('utf16le');
    if (type === 0xd) {
      const ref = (i) => uint(at + i * refSize, refSize);
      return Object.fromEntries(Array.from({ length: count }, (_, i) => [read(ref(i)), read(ref(count + i))]));
    }
    throw new Error(`bplist type 0x${type.toString(16)} not supported`);
  };
  return read(top);
}

// The layout was decided on a mockup (#685): icon view without bars, the app
// left, Applications right. Since then an arrow sits between them, painted on a
// transparent background picture that the layout refers to by an alias.
test('the checked-in window layout keeps the decided look', () => {
  const ds = fs.readFileSync(LAYOUT);
  const plist = (code) => {
    const at = ds.indexOf(Buffer.from(`${code}blob`, 'latin1'));
    assert.ok(at > 0, `${code} record present`);
    const length = ds.readUInt32BE(at + 8);
    return readBinaryPlist(ds.subarray(at + 12, at + 12 + length));
  };
  const position = (name) => {
    const record = Buffer.concat([Buffer.alloc(4), Buffer.from(name, 'utf16le').swap16(), Buffer.from('Ilocblob', 'latin1')]);
    record.writeUInt32BE(name.length, 0);
    const at = ds.indexOf(record);
    assert.ok(at >= 0, `position for ${name}`);
    const data = at + record.length + 4;
    return [ds.readUInt32BE(data), ds.readUInt32BE(data + 4)];
  };

  const [app, applications] = [position('Snotra Agent.app'), position('Applications')];
  assert.ok(app[0] < applications[0], 'app left of Applications');
  assert.equal(app[1], applications[1], 'both on one line');

  const win = plist('bwsp');
  assert.equal(win.ShowToolbar, false);
  assert.equal(win.ShowSidebar, false);
  assert.equal(win.ShowStatusBar, false);
  const [, , width, height] = win.WindowBounds.match(/\d+/g).map(Number);
  for (const hidden of ['.VolumeIcon.icns', '.background']) {
    assert.ok(position(hidden)[1] > height, `${hidden} below the visible area`);
  }

  const view = plist('icvp');
  assert.equal(view.backgroundType, 2, 'background picture');
  assert.equal(view.iconSize, 128);
  assert.equal(view.arrangeBy, 'none');
  assert.ok(Buffer.isBuffer(view.backgroundImageAlias), 'alias to the background picture');
  const alias = view.backgroundImageAlias.toString('latin1');
  assert.ok(alias.includes(`/${BACKGROUND_IN_VOLUME}`), 'alias points at the staged background');
  assert.ok(alias.includes(`/Volumes/${VOLUME_NAME}`), 'alias names the real volume');
  assert.equal(ds.includes(Buffer.from('/Users/', 'latin1')), false, 'no local paths');
  assert.equal(ds.includes(Buffer.from('claude', 'latin1')), false, 'no paths of an agent session');

  // The arrow in the SVG source is drawn at the icons' height and between them.
  const svg = fs.readFileSync(path.join(ROOT, 'assets', 'macos', 'dmg-background.svg'), 'utf8');
  const [, svgWidth, svgHeight] = svg.match(/width="(\d+)" height="(\d+)"/).map(Number);
  assert.deepEqual([svgWidth, svgHeight], [width, height], 'background as large as the window');
  const [, x1, y1, x2] = svg.match(/M(\d+) (\d+) H(\d+)/).map(Number);
  assert.equal(y1, app[1], 'arrow on the icons\' line');
  assert.ok(app[0] + 64 < x1 && x2 < applications[0] - 64, 'arrow between the icons');
});
