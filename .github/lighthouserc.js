'use strict';

// Konfiguration fuer Lighthouse CI (Issue #113). Wird von
// .github/workflows/website-performance.yml per --config aufgerufen und misst
// die *ausgelieferte* Seite unter snotra-ai.dev, nicht das Arbeitsverzeichnis —
// gemessen wird also genau das, was Besucher bekommen.
//
// Keine Messung im Browser des Besuchers: Auf der Seite selbst liegt keine
// Zeile Code dafuer. Das ist Absicht, siehe Issue #113 (Firebase Performance
// Monitoring haette eine Geraete-ID auf dem Endgeraet abgelegt und damit eine
// Einwilligung noetig gemacht).
//
// Die Schwellwerte sind am Ist-Zustand vom 2026-09-13 kalibriert (Startseite
// perf 0.97 / a11y 0.97 / bp 1.00 / seo 1.00, Rechtsseiten perf 0.91-1.00).
// Sie sollen eine Verschlechterung melden, nicht bei normalem Messrauschen
// anschlagen — deshalb liegen sie ein Stueck unter den gemessenen Werten.

const START = '^https://snotra-ai\\.dev/(\\?.*)?$';
// Die Rechtsseiten haengen per JavaScript ein ?lang=… an die URL, das Muster
// darf also nicht auf Zeilenende enden.
const RECHTSSEITEN = '^https://snotra-ai\\.dev/(impressum|datenschutz)';

module.exports = {
  ci: {
    collect: {
      url: [
        'https://snotra-ai.dev/',
        'https://snotra-ai.dev/impressum',
        'https://snotra-ai.dev/datenschutz',
      ],
      // Drei Laeufe je Seite; Lighthouse CI bewertet den Median und buegelt so
      // Ausreisser des Runners aus.
      numberOfRuns: 3,
      settings: {
        // Voreinstellung ist die Mobil-Emulation mit gedrosselter Leitung —
        // das entspricht dem, was auch der Chrome UX Report als PHONE misst.
        chromeFlags: '--no-sandbox --disable-dev-shm-usage',
      },
    },
    assert: {
      assertMatrix: [
        {
          matchingUrlPattern: START,
          assertions: {
            'categories:performance': ['error', { minScore: 0.9 }],
            'categories:accessibility': ['error', { minScore: 0.95 }],
            'categories:best-practices': ['error', { minScore: 0.95 }],
            'categories:seo': ['error', { minScore: 0.95 }],
            // Der LCP lag zuletzt bei 2,5 s und damit hart an der Grenze
            // zwischen "gut" und "verbesserungswuerdig". Als Warnung, damit
            // eine Verschlechterung sichtbar wird, ohne den Lauf zu faellen.
            'largest-contentful-paint': ['warn', { maxNumericValue: 3000 }],
          },
        },
        {
          matchingUrlPattern: RECHTSSEITEN,
          assertions: {
            'categories:performance': ['error', { minScore: 0.85 }],
            'categories:accessibility': ['error', { minScore: 0.95 }],
            'categories:best-practices': ['error', { minScore: 0.95 }],
            // Kein SEO-Schwellwert: Impressum und Datenschutz tragen bewusst
            // <meta name="robots" content="noindex">, woran sich Lighthouse
            // stoert (Kategorie faellt dadurch auf ~0.54).
          },
        },
      ],
    },
    upload: {
      // Bewusst nicht "temporary-public-storage": die Reports landen sonst in
      // einem oeffentlich abrufbaren Google-Bucket. Stattdessen ins Dateisystem
      // und von dort als Artefakt an den Workflow-Lauf.
      target: 'filesystem',
      // Der Ordnername traegt bewusst keinen fuehrenden Punkt:
      // actions/upload-artifact laesst versteckte Pfade aus, ein
      // .lighthouse-report waere stillschweigend nicht im Artefakt gelandet.
      outputDir: './lighthouse-report',
      reportFilenamePattern: '%%PATHNAME%%-%%DATETIME%%-report.%%EXTENSION%%',
    },
  },
};
