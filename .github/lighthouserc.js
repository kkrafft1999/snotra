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
// Die Schwellwerte sind an den Werten des GitHub-Runners vom 2026-09-13
// kalibriert, nicht an lokalen Messungen: Der Runner misst spuerbar schlechter
// und streut staerker (Startseite perf 0.98-0.99, Impressum 0.92-1.00,
// Datenschutz 0.84-0.95). Sie sollen eine Verschlechterung melden, nicht bei
// normalem Messrauschen anschlagen — deshalb der Abstand nach unten.

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

            // SEO wird als Einzel-Audits geprueft statt als Kategorie, weil ein
            // Audit darin nicht verlaesslich ist: app.js schreibt beim Laden
            // ein ?lang=… in die URL (app.js:1189, silent: false), waehrend
            // Lighthouse das <link rel="canonical"> aus dem ausgelieferten HTML
            // liest. Ob beide zusammenpassen, haengt davon ab, auf welcher
            // Seite des Umschreibens der Schnappschuss faellt — mit deutschem
            // Browser meist gruen, mit englischem (so der Runner) rot. Die
            // Seite selbst ist in Ordnung, im DOM steht das richtige canonical.
            'document-title': 'error',
            'meta-description': 'error',
            'http-status-code': 'error',
            'link-text': 'error',
            'crawlable-anchors': 'error',
            'is-crawlable': 'error',
            'canonical': 'warn',

            // Der LCP lag zuletzt bei 2,5 s und damit hart an der Grenze
            // zwischen "gut" und "verbesserungswuerdig". Als Warnung, damit
            // eine Verschlechterung sichtbar wird, ohne den Lauf zu faellen.
            'largest-contentful-paint': ['warn', { maxNumericValue: 3000 }],
          },
        },
        {
          matchingUrlPattern: RECHTSSEITEN,
          assertions: {
            // Tiefer angesetzt als bei der Startseite: Die Rechtsseiten
            // streuten auf dem Runner zwischen 0.84 und 1.00.
            'categories:performance': ['error', { minScore: 0.75 }],
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
