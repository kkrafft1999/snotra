#!/usr/bin/env node
'use strict';

/**
 * Baut die App-Icons aus den SVG-Quellen in `assets/icon/`:
 *
 *   assets/icon/icon-macos.svg   -> icon.icns  (16 … 512 px, jeweils 1x und @2x)
 *   assets/icon/icon-windows.svg -> icon.ico   (16, 32, 48, 64, 128, 256 px als PNG-Einträge)
 *
 * `package.json` referenziert die Ausgaben als `"icon": "./icon"` (ohne Endung),
 * die Dateinamen dürfen sich also nicht ändern.
 *
 * Voraussetzungen (macOS): `rsvg-convert` (brew install librsvg) und `iconutil`
 * (Xcode Command Line Tools). Aufruf: `node scripts/build-icons.js`
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_MAC = path.join(ROOT, 'assets', 'icon', 'icon-macos.svg');
const SRC_WIN = path.join(ROOT, 'assets', 'icon', 'icon-windows.svg');
const OUT_ICNS = path.join(ROOT, 'icon.icns');
const OUT_ICO = path.join(ROOT, 'icon.ico');

// Apple-Iconset: [Punktgröße, Skalierung] -> Dateiname icon_<pt>x<pt>[@2x].png
const ICONSET = [
  [16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2],
  [256, 1], [256, 2], [512, 1], [512, 2],
];
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error(`Werkzeug fehlt: ${cmd}`);
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} ist fehlgeschlagen:\n${result.stderr}`);
  }
  return result.stdout;
}

function renderPng(svgPath, size, outPath) {
  run('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', outPath, svgPath]);
}

function buildIcns(tmpDir) {
  const iconset = path.join(tmpDir, 'icon.iconset');
  fs.mkdirSync(iconset);
  for (const [pt, scale] of ICONSET) {
    const suffix = scale === 1 ? '' : `@${scale}x`;
    renderPng(SRC_MAC, pt * scale, path.join(iconset, `icon_${pt}x${pt}${suffix}.png`));
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', OUT_ICNS]);
}

/**
 * ICO-Container mit PNG-komprimierten Einträgen (seit Windows Vista unterstützt,
 * so lag auch das bisherige icon.ico vor). Aufbau: ICONDIR (6 Byte),
 * ICONDIRENTRY je Bild (16 Byte), danach die Bilddaten.
 */
function buildIco(tmpDir) {
  const images = ICO_SIZES.map((size) => {
    const pngPath = path.join(tmpDir, `win-${size}.png`);
    renderPng(SRC_WIN, size, pngPath);
    return { size, data: fs.readFileSync(pngPath) };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserviert
  header.writeUInt16LE(1, 2); // Typ 1 = Icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, data }, index) => {
    const o = index * 16;
    const dim = size === 256 ? 0 : size; // 0 steht für 256
    directory.writeUInt8(dim, o);
    directory.writeUInt8(dim, o + 1);
    directory.writeUInt8(0, o + 2); // Farbpalette: keine
    directory.writeUInt8(0, o + 3); // reserviert
    directory.writeUInt16LE(1, o + 4); // Farbebenen
    directory.writeUInt16LE(32, o + 6); // Bits pro Pixel
    directory.writeUInt32LE(data.length, o + 8);
    directory.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });

  fs.writeFileSync(OUT_ICO, Buffer.concat([header, directory, ...images.map((img) => img.data)]));
}

function main() {
  for (const src of [SRC_MAC, SRC_WIN]) {
    if (!fs.existsSync(src)) throw new Error(`Quelle fehlt: ${path.relative(ROOT, src)}`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-icons-'));
  try {
    buildIcns(tmpDir);
    console.log(`✔ ${path.relative(ROOT, OUT_ICNS)} (${ICONSET.length} Größen)`);
    buildIco(tmpDir);
    console.log(`✔ ${path.relative(ROOT, OUT_ICO)} (${ICO_SIZES.length} Größen)`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`✖ ${err.message}`);
  if (/Werkzeug fehlt/.test(err.message)) {
    console.error('Hinweis: rsvg-convert per `brew install librsvg`; iconutil kommt mit den Xcode Command Line Tools.');
  }
  process.exit(1);
}
