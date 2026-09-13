#!/usr/bin/env node
'use strict';

// Holt die Felddaten des Chrome UX Report (CrUX) fuer snotra-ai.dev und
// schreibt sie in die Job-Summary des Workflow-Laufs (Issue #113).
//
// Warum ueberhaupt CrUX: Es sind echte Messwerte echter Besucher, aber Google
// erhebt sie ohnehin in Chrome — auf der Seite selbst laeuft dafuer kein Code,
// es wird nichts auf dem Endgeraet gespeichert und es braucht keine
// Einwilligung. Lighthouse liefert daneben nur Labordaten aus dem Runner.
//
// Aufruf:   node scripts/crux-report.js [origin]
// Env:      CRUX_API_KEY   API-Key fuer die Chrome-UX-Report-API (Pflicht)
//           CRUX_ORIGIN    Origin, falls nicht als Argument uebergeben
//
// Ohne Key beendet sich das Skript mit Hinweis und Code 0: Die Messung ist
// eine Zugabe, sie soll den Lauf nicht faellen. Ebenso bei "record not found" —
// das heisst nur, dass die Domain noch unter der Traffic-Schwelle liegt, ab der
// CrUX ueberhaupt aggregiert.

const ENDPUNKT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';

const ORIGIN = process.argv[2] || process.env.CRUX_ORIGIN || 'https://snotra-ai.dev';

// Schluessel der CrUX-API -> Anzeige. Die Reihenfolge ist die Ausgabereihenfolge;
// LCP, INP und CLS sind die drei Core Web Vitals.
const METRIKEN = [
  { key: 'largest_contentful_paint', name: 'LCP (Groesstes Element)', einheit: 'ms', gut: 2500 },
  { key: 'interaction_to_next_paint', name: 'INP (Reaktion)', einheit: 'ms', gut: 200 },
  { key: 'cumulative_layout_shift', name: 'CLS (Layout-Sprung)', einheit: '', gut: 0.1 },
  { key: 'first_contentful_paint', name: 'FCP (Erster Inhalt)', einheit: 'ms', gut: 1800 },
  { key: 'experimental_time_to_first_byte', name: 'TTFB (Server-Antwort)', einheit: 'ms', gut: 800 },
];

const FORMFAKTOREN = [
  { wert: null, name: 'Alle Geraete' },
  { wert: 'PHONE', name: 'Smartphone' },
  { wert: 'DESKTOP', name: 'Desktop' },
];

/** Fragt einen Datensatz ab. Gibt null zurueck, wenn CrUX nichts kennt. */
async function hole(apiKey, formFactor) {
  const koerper = { origin: ORIGIN };
  if (formFactor) koerper.formFactor = formFactor;

  const antwort = await fetch(`${ENDPUNKT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(koerper),
  });

  if (antwort.status === 404) return null; // noch keine Felddaten
  if (!antwort.ok) {
    const text = await antwort.text();
    throw new Error(`CrUX-API antwortete ${antwort.status}: ${text.slice(0, 400)}`);
  }
  return (await antwort.json()).record;
}

/** p75 der Metrik als Zahl; CrUX liefert CLS als Zeichenkette. */
function p75(metrik) {
  const roh = metrik?.percentiles?.p75;
  return roh === undefined ? null : Number(roh);
}

/** Anteil der Besuche im gruenen Bereich, in Prozent. */
function anteilGut(metrik) {
  const dichte = metrik?.histogram?.[0]?.density;
  return typeof dichte === 'number' ? Math.round(dichte * 100) : null;
}

function formatiere(wert, einheit) {
  if (wert === null) return '—';
  return einheit === 'ms' ? `${Math.round(wert)} ms` : wert.toFixed(3);
}

function zeilenFuerDatensatz(record) {
  const zeilen = [];
  for (const m of METRIKEN) {
    const metrik = record.metrics?.[m.key];
    if (!metrik) continue;
    const wert = p75(metrik);
    const ampel = wert === null ? '' : wert <= m.gut ? '🟢' : '🟠';
    const gut = anteilGut(metrik);
    zeilen.push(`| ${m.name} | ${formatiere(wert, m.einheit)} ${ampel} | ${gut === null ? '—' : `${gut} %`} |`);
  }
  return zeilen;
}

function schreibe(zeilen) {
  const text = zeilen.join('\n');
  process.stdout.write(`${text}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) require('fs').appendFileSync(summary, `${text}\n`);
}

async function main() {
  const apiKey = process.env.CRUX_API_KEY;
  if (!apiKey) {
    schreibe([
      '## Felddaten (Chrome UX Report)',
      '',
      'Uebersprungen: Das Repository-Secret `CRUX_API_KEY` ist nicht gesetzt.',
      'Key anlegen: Google Cloud Console -> Projekt `snotra-ai` -> APIs & Dienste ->',
      '"Chrome UX Report API" aktivieren -> Anmeldedaten -> API-Schluessel.',
    ]);
    return;
  }

  const zeilen = ['## Felddaten (Chrome UX Report)', '', `Origin: \`${ORIGIN}\``, ''];
  let irgendwasGefunden = false;

  for (const ff of FORMFAKTOREN) {
    const record = await hole(apiKey, ff.wert);
    if (!record) continue;
    irgendwasGefunden = true;
    zeilen.push(
      `### ${ff.name}`,
      '',
      '| Metrik | p75 | Anteil "gut" |',
      '| --- | --- | --- |',
      ...zeilenFuerDatensatz(record),
      '',
    );
  }

  if (!irgendwasGefunden) {
    zeilen.push(
      'Noch keine Felddaten. CrUX veroeffentlicht einen Origin erst, wenn er genug',
      'Besuche von Chrome-Nutzern hat — das ist eine Aussage ueber die Reichweite,',
      'kein Fehler. Die Labordaten aus dem Lighthouse-Lauf gelten weiterhin.',
    );
  }

  schreibe(zeilen);
}

main().catch((fehler) => {
  console.error(`CrUX-Abfrage fehlgeschlagen: ${fehler.message}`);
  process.exitCode = 1;
});
