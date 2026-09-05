#!/usr/bin/env node
'use strict';

// Prueft nach dem Packaging, dass das app.asar nur die erlaubten Laufzeit-
// dateien enthaelt (Issue #72). Quelle der Wahrheit ist die Allowlist in
// package.json -> config.forge.packagerConfig.ignore: Alles, was dort per
// Regex ausgeschlossen ist, darf im Archiv nicht auftauchen. Zusaetzlich
// muessen einige Kernpfade vorhanden sein, damit eine zu strenge Allowlist
// nicht unbemerkt eine leere App erzeugt.
//
// Aufruf: node scripts/check-asar-contents.js [pfad/zu/app.asar]
// Ohne Argument wird unter out/ nach app.asar gesucht (macOS- und Windows-
// Layout von electron-forge). Laeuft in release.yml nach den Build-Schritten.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Pfade, die im Archiv zwingend vorhanden sein muessen.
const REQUIRED_ENTRIES = ['/package.json', '/src/main/index.js', '/system-skills'];

// Top-Level-Eintraege, die nie ausgeliefert werden duerfen (Kernanliegen des
// Issues) – unabhaengig davon, wie die Allowlist gerade formuliert ist.
const FORBIDDEN_TOP_LEVEL = ['.claude', '.github', '.git', 'docs', 'test', 'scripts', 'out', '.env', '.venv'];

function loadIgnorePatterns(pkg = require(path.join(ROOT, 'package.json'))) {
  const ignore = pkg?.config?.forge?.packagerConfig?.ignore;
  if (!Array.isArray(ignore) || ignore.length === 0) {
    throw new Error('package.json: config.forge.packagerConfig.ignore fehlt oder ist leer');
  }
  return ignore.map((source) => new RegExp(source));
}

function topLevelOf(entry) {
  return entry.split('/').filter(Boolean)[0] ?? '';
}

/**
 * Klassifiziert die Archiv-Eintraege (Pfade mit fuehrendem "/", wie sie
 * `@electron/asar` liefert). Reine Funktion, damit sie testbar ist.
 */
function findViolations(entries, ignorePatterns) {
  const normalized = entries.map((e) => String(e).replace(/\\/g, '/'));
  const set = new Set(normalized);
  const ignored = normalized.filter((entry) => ignorePatterns.some((re) => re.test(entry)));
  const forbidden = normalized.filter((entry) => FORBIDDEN_TOP_LEVEL.includes(topLevelOf(entry)));
  const missing = REQUIRED_ENTRIES.filter((req) => !set.has(req));
  const topLevel = [...new Set(normalized.map(topLevelOf).filter(Boolean))].sort();
  return {
    ok: ignored.length === 0 && forbidden.length === 0 && missing.length === 0,
    ignored: [...new Set([...ignored, ...forbidden])].sort(),
    missing,
    topLevel,
  };
}

function findAsar(dir, depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return null;
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isFile() && dirent.name === 'app.asar') return full;
    if (dirent.isDirectory() && dirent.name !== 'node_modules') {
      const found = findAsar(full, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function main() {
  const asarPath = process.argv[2] ? path.resolve(process.argv[2]) : findAsar(path.join(ROOT, 'out'));
  if (!asarPath || !fs.existsSync(asarPath)) {
    console.error('Kein app.asar gefunden. Erst "npm run package" ausfuehren oder Pfad angeben.');
    process.exit(2);
  }
  const asar = require('@electron/asar');
  const entries = asar.listPackage(asarPath, { isPack: false });
  const result = findViolations(entries, loadIgnorePatterns());

  console.log(`app.asar: ${asarPath}`);
  console.log(`Top-Level-Eintraege: ${result.topLevel.join(', ')}`);
  if (result.ok) {
    console.log(`OK – ${entries.length} Eintraege, keine ausgeschlossenen Dateien im Archiv.`);
    return;
  }
  if (result.missing.length) {
    console.error(`FEHLER – Pflichteintraege fehlen: ${result.missing.join(', ')}`);
  }
  if (result.ignored.length) {
    const shown = result.ignored.slice(0, 25);
    console.error(`FEHLER – ${result.ignored.length} Eintraege verletzen die Allowlist, z. B.:`);
    for (const entry of shown) console.error(`  ${entry}`);
    if (result.ignored.length > shown.length) console.error(`  … und ${result.ignored.length - shown.length} weitere`);
  }
  process.exit(1);
}

module.exports = { findViolations, loadIgnorePatterns, REQUIRED_ENTRIES, FORBIDDEN_TOP_LEVEL };

if (require.main === module) main();
