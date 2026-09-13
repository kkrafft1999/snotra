#!/usr/bin/env node
'use strict';

// Fasst die Lighthouse-Reports aus lighthouse-report/manifest.json als
// Markdown-Tabelle zusammen und haengt sie an die Job-Summary des Laufs
// (Issue #113). Laeuft in .github/workflows/website-performance.yml zwischen
// "Reports ablegen" und der Schwellwert-Pruefung, damit die Zahlen auch dann in
// der Summary stehen, wenn anschliessend ein Schwellwert reisst.
//
// Ohne Manifest (Messung gar nicht erst gelaufen) endet das Skript mit einem
// Hinweis und Code 0 — die eigentliche Fehlermeldung kommt dann vom lhci-Schritt.

const fs = require('fs');
const path = require('path');

const BERICHTE = path.resolve(__dirname, '..', 'lighthouse-report');
const MANIFEST = path.join(BERICHTE, 'manifest.json');

// Anzeigename je Lighthouse-Kategorie, zugleich die Spaltenreihenfolge.
const KATEGORIEN = [
  ['performance', 'Performance'],
  ['accessibility', 'Barrierefreiheit'],
  ['best-practices', 'Best Practices'],
  ['seo', 'SEO'],
];

function schreibe(zeilen) {
  const text = zeilen.join('\n');
  process.stdout.write(`${text}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, `${text}\n`);
}

function prozent(wert) {
  if (typeof wert !== 'number') return '—';
  const zahl = Math.round(wert * 100);
  // Dieselben Schwellen, die Lighthouse selbst zur Einfaerbung nutzt.
  const ampel = zahl >= 90 ? '🟢' : zahl >= 50 ? '🟠' : '🔴';
  return `${zahl} ${ampel}`;
}

function main() {
  if (!fs.existsSync(MANIFEST)) {
    schreibe(['## Labordaten (Lighthouse)', '', 'Keine Reports gefunden — die Messung ist nicht durchgelaufen.']);
    return;
  }

  const eintraege = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  // Je Seite laufen mehrere Messungen; Lighthouse CI markiert die mittlere als
  // repraesentativ und bewertet genau die.
  const massgeblich = eintraege.filter((e) => e.isRepresentativeRun);

  const zeilen = [
    '## Labordaten (Lighthouse)',
    '',
    `| Seite | ${KATEGORIEN.map(([, name]) => name).join(' | ')} |`,
    `| --- | ${KATEGORIEN.map(() => '---').join(' | ')} |`,
  ];

  for (const eintrag of massgeblich) {
    const seite = new URL(eintrag.url).pathname || '/';
    const werte = KATEGORIEN.map(([schluessel]) => prozent(eintrag.summary?.[schluessel]));
    zeilen.push(`| \`${seite}\` | ${werte.join(' | ')} |`);
  }

  zeilen.push('', 'Die vollstaendigen HTML-Reports haengen als Artefakt `lighthouse-reports` am Lauf.');
  schreibe(zeilen);
}

main();
