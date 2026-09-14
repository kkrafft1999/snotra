#!/usr/bin/env node
'use strict';

/**
 * Coverage mit ehrlichem Nenner und getrennten Schwellen (Issue #78).
 *
 * `node --test --experimental-test-coverage` misst nur, was der Lauf laedt,
 * und kennt nur **eine** Schwelle fuer alles. Beides passt hier nicht:
 *
 *   * Der Renderer ist rund ein Drittel des Codes und aus einem Testlauf
 *     heraus schwerer zu erreichen als der Kern. Eine gemeinsame Schwelle
 *     muesste sich am schwaecheren Teil orientieren und wuerde den Kern
 *     verwahrlosen lassen.
 *   * Dateien, die kein Test laedt, tauchen im Bericht gar nicht auf. Die
 *     Gesamtzahl beschreibt dann eine Auswahl, nicht das Projekt. Dagegen
 *     haelt `test/source-files-load.test.js` dagegen — und was trotzdem
 *     fehlt, listet dieses Skript ausdruecklich auf, statt es zu verschweigen.
 *
 * Aufruf: `npm run coverage`. Exit-Code 1, wenn ein Bereich unter seiner
 * Schwelle liegt oder eine Quelldatei ueberhaupt nicht im Bericht steht.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SRC_DIR,
  GENERATED_DIRS,
  ELECTRON_ENTRY_POINTS,
  collectSourceFiles,
} = require('./source-files.js');

const ROOT = path.join(__dirname, '..');

/**
 * Schwellen je Bereich, in Prozent. Sie sind eine Sperrklinke: knapp unter dem
 * gemessenen Stand, damit ein Rueckschritt auffaellt, ohne dass jede Aenderung
 * am Code die Zahl anhebt. Wer sie senkt, sollte im Commit sagen, warum.
 *
 * Der Abstand von rund einem Punkt ist kein Schlendrian: die Zweig-Abdeckung
 * schwankt zwischen zwei Laeufen um etwa ein Zehntel Prozentpunkt, weil
 * einzelne Tests Zeitgrenzen und Abbrueche pruefen und dabei mal den einen,
 * mal den anderen Zweig nehmen.
 */
const AREAS = [
  {
    key: 'kern',
    label: 'Kern (main, application, shared, preload)',
    matches: (rel) => !rel.startsWith('renderer/'),
    thresholds: { lines: 94, branches: 85, functions: 88 },
  },
  {
    key: 'renderer',
    label: 'Renderer',
    matches: (rel) => rel.startsWith('renderer/'),
    // Deutlich niedriger, und das ist kein Versehen: Oberflaechenmodule werden
    // ueber den DOM-Stack angefasst, aber nicht in jeder Verzweigung. Was hier
    // fehlt, faengt der Smoke-Test (`npm run test:e2e`) auf einer anderen
    // Ebene ab.
    thresholds: { lines: 41, branches: 72, functions: 56 },
  },
];

/** lcov auf das reduzieren, was hier zaehlt: Summen je Datei. */
function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const [tag, ...rest] = line.trim().split(':');
    const value = rest.join(':');
    if (tag === 'SF') {
      current = { lines: [0, 0], branches: [0, 0], functions: [0, 0] };
      files.set(path.relative(SRC_DIR, path.resolve(ROOT, value)).split(path.sep).join('/'), current);
    } else if (!current) {
      continue;
    } else if (tag === 'LF') current.lines[0] = Number(value);
    else if (tag === 'LH') current.lines[1] = Number(value);
    else if (tag === 'BRF') current.branches[0] = Number(value);
    else if (tag === 'BRH') current.branches[1] = Number(value);
    else if (tag === 'FNF') current.functions[0] = Number(value);
    else if (tag === 'FNH') current.functions[1] = Number(value);
    else if (tag === 'end_of_record') current = null;
  }
  return files;
}

const percent = (hit, found) => (found === 0 ? 100 : (hit / found) * 100);
const fmt = (value) => `${value.toFixed(2).padStart(6)} %`;

function main() {
  const lcovPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-coverage-')), 'lcov.info');
  const result = spawnSync(process.execPath, [
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-include=src/**',
    ...GENERATED_DIRS.map((d) => `--test-coverage-exclude=src/${d}/**`),
    '--test-reporter=lcov',
    `--test-reporter-destination=${lcovPath}`,
    '--test-reporter=dot',
    '--test-reporter-destination=stdout',
    'test/**/*.test.js',
  ], { cwd: ROOT, stdio: 'inherit' });

  if (result.status !== 0) {
    console.error('\nDie Test-Suite ist rot — Coverage sagt dann ohnehin nichts.');
    process.exit(result.status ?? 1);
  }

  const measured = parseLcov(fs.readFileSync(lcovPath, 'utf8'));
  const sources = collectSourceFiles();
  const missing = sources.filter((rel) => !measured.has(rel));

  console.log('\nCoverage je Bereich (Nenner: alle Dateien unter src/)\n');
  console.log(`${'Bereich'.padEnd(42)} ${'Dateien'.padStart(7)} ${'Zeilen'.padStart(8)} ${'Zweige'.padStart(8)} ${'Funktionen'.padStart(10)}`);
  console.log('-'.repeat(82));

  let failed = false;
  for (const area of AREAS) {
    const relevant = sources.filter(area.matches);
    const totals = { lines: [0, 0], branches: [0, 0], functions: [0, 0] };
    for (const rel of relevant) {
      const entry = measured.get(rel);
      if (!entry) continue;
      for (const metric of ['lines', 'branches', 'functions']) {
        totals[metric][0] += entry[metric][0];
        totals[metric][1] += entry[metric][1];
      }
    }
    const values = Object.fromEntries(
      ['lines', 'branches', 'functions'].map((m) => [m, percent(totals[m][1], totals[m][0])])
    );
    const countMissing = relevant.filter((rel) => !measured.has(rel)).length;
    console.log(
      `${area.label.padEnd(42)} ${String(relevant.length - countMissing).padStart(3)}/${String(relevant.length).padEnd(3)} `
      + `${fmt(values.lines)} ${fmt(values.branches)} ${fmt(values.functions)}`
    );
    for (const [metric, min] of Object.entries(area.thresholds)) {
      if (values[metric] + 1e-9 < min) {
        failed = true;
        console.log(`   ✖ ${metric}: ${values[metric].toFixed(2)} % liegt unter der Schwelle von ${min} %`);
      }
    }
  }

  if (missing.length > 0) {
    console.log(`\nNicht im Bericht (${missing.length}):`);
    for (const rel of missing) {
      const reason = ELECTRON_ENTRY_POINTS.get(rel);
      console.log(`   ${reason ? '•' : '✖'} src/${rel}${reason ? ` — ${reason}` : ' — kein Test laedt diese Datei'}`);
      if (!reason) failed = true;
    }
    if (failed) {
      console.log('\nEine Datei ohne Begruendung fehlt im Nenner. Entweder laedt sie');
      console.log('test/source-files-load.test.js kuenftig mit, oder sie gehoert mit Grund');
      console.log('in die Liste in scripts/source-files.js.');
    }
  }

  console.log('');
  process.exit(failed ? 1 : 0);
}

main();
