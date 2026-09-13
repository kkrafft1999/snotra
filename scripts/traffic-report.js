#!/usr/bin/env node
'use strict';

// Wertet die Zugriffe auf snotra-ai.dev aus den Firebase-Hosting-Logs aus
// (Issue #115). Firebase Hosting schreibt jede Anfrage nach Google Cloud
// Logging, seit das fuer das Projekt aktiviert wurde (13.09.2026). Vorher
// gibt es nichts — rueckwirkend laesst sich das nicht nachholen.
//
// Warum die Klassifikation: Eine rohe Zaehlung waere irrefuehrend. In der
// ersten Stunde nach Aktivierung stammten von 260 Anfragen 60 aus dem eigenen
// Lighthouse-CI-Lauf, 61 von KI-Crawlern, 22 von der Zertifikats-Pruefung und
// rund 55 von Scannern, die nach ungeschuetzten .env-Dateien suchen. Ohne
// Trennung liest sich jede Woche nach mehr Erfolg, als tatsaechlich da ist.
//
// Aufruf:   node scripts/traffic-report.js [Optionen]
//
// Optionen: --tage=N          Zeitraum in Tagen (Standard 7, Logs halten 30)
//           --limit=N         Obergrenze geholter Eintraege (Standard 20000)
//           --eigene-ips=A,B  Eigene IPs, die als "eigen" gelten sollen
//           --projekt=ID      Google-Cloud-Projekt (Standard snotra-ai)
//           --repo=O/R        GitHub-Repo fuer die Download-Zahlen
//           --ohne-downloads  GitHub-Release-Downloads weglassen
//           --json            Auswertung als JSON statt als Text
//
// Env:      TRAFFIC_EIGENE_IPS  wie --eigene-ips
//
// Voraussetzung: gcloud ist installiert und mit einem Konto angemeldet, das
// Leserechte auf das Projekt snotra-ai hat (gcloud auth login).

const { spawnSync } = require('node:child_process');

const ARG = (name, standard) => {
  const treffer = process.argv.find((a) => a.startsWith(`--${name}=`));
  return treffer ? treffer.slice(name.length + 3) : standard;
};
const FLAG = (name) => process.argv.includes(`--${name}`);

const PROJEKT = ARG('projekt', 'snotra-ai');
const TAGE = Math.max(1, Number(ARG('tage', '7')) || 7);
const LIMIT = Number(ARG('limit', '20000')) || 20000;
const REPO = ARG('repo', 'kkrafft1999/snotra');
const ALS_JSON = FLAG('json');
const OHNE_DOWNLOADS = FLAG('ohne-downloads');
const EIGENE_IPS = new Set(
  (ARG('eigene-ips', process.env.TRAFFIC_EIGENE_IPS || '') || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

// --- Klassifikation -------------------------------------------------------
//
// Die Reihenfolge entscheidet: Die erste zutreffende Regel gewinnt. Deshalb
// stehen die eindeutigen Faelle (Zertifikat, eigene CI) vor den unschaerferen.

// Lighthouse emuliert in der CI fest das Geraet "moto g power (2022)". Echte
// Besucher mit diesem Telefon waeren denkbar, kaemen aber nicht im Dutzend
// binnen Minuten aus einem Rechenzentrum — und der eigene Workflow laeuft
// nachweislich mit genau diesem User-Agent.
const EIGEN_UA = [/moto g power \(2022\)/i, /Chrome-Lighthouse/i, /Snotra-owner-security-review/i];

const KI_UA = [
  /GPTBot/i, /ChatGPT-User/i, /OAI-SearchBot/i, /ClaudeBot/i, /Claude-User/i,
  /Claude-SearchBot/i, /anthropic-ai/i, /PerplexityBot/i, /Perplexity-User/i,
  /Bytespider/i, /CCBot/i, /Amazonbot/i, /Applebot-Extended/i, /Google-Extended/i,
  /meta-externalagent/i, /FacebookBot/i, /Diffbot/i, /ImagesiftBot/i,
  /cohere-ai/i, /YouBot/i, /Timpibot/i, /omgili/i,
];

const SUCHMASCHINE_UA = [
  /Googlebot/i, /bingbot/i, /Slurp/i, /DuckDuckBot/i, /YandexBot/i,
  /Baiduspider/i, /Applebot/i, /Seekport/i, /AhrefsBot/i, /SemrushBot/i,
  /MJ12bot/i, /DotBot/i, /PetalBot/i,
];

// Vorschau-Bots holen Titel und Bild, wenn jemand einen Link teilt. Das ist
// ein schwaches, aber echtes Signal fuer Verbreitung.
const VORSCHAU_UA = [
  /facebookexternalhit/i, /Twitterbot/i, /LinkedInBot/i, /Slackbot/i,
  /WhatsApp/i, /TelegramBot/i, /Discordbot/i, /SkypeUriPreview/i, /Mastodon/i,
];

const SCANNER_PFAD = [
  /\.env/i, /wp-(admin|content|includes|login|config)/i, /xmlrpc\.php/i,
  /phpmyadmin/i, /\.git/i, /\.aws/i, /\.ssh/i, /\.vscode/i, /\.idea/i,
  /\.DS_Store/i, /credential/i, /server-status/i, /actuator/i, /telescope/i,
  /_ignition/i, /\/config\.(js|json|php|yml|yaml)$/i, /\/api\/config/i,
  /\/js\/env\.js$/i, /\.(bak|sql|zip|tar\.gz|rar|old)$/i, /\/(admin|administrator)\//i,
  /\/src\//i, /firebase\.json/i, /package\.json/i, /\/vendor\//i, /\/cgi-bin\//i,
];

// Standarddateien, die Clients von sich aus abfragen. Ein 404 darauf ist kein
// Angriff, sondern eine Luecke auf der eigenen Seite.
const STANDARD_PFAD = [
  '/robots.txt', '/favicon.ico', '/sitemap.xml', '/.well-known/security.txt',
  '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/browserconfig.xml',
  '/manifest.json', '/site.webmanifest',
];

const KATEGORIEN = [
  ['besucher', 'Echte Besucher'],
  ['ohne-assets', 'Abrufe ohne Mitladen'],
  ['ki', 'KI-Crawler'],
  ['suchmaschine', 'Suchmaschinen'],
  ['vorschau', 'Link-Vorschau'],
  ['eigen', 'Eigene CI und Tests'],
  ['zertifikat', 'Zertifikats-Pruefung'],
  ['scanner', 'Scanner und Angriffsversuche'],
  ['fehlend', 'Fehlende Standarddatei'],
];

function passt(muster, text) {
  return muster.some((m) => m.test(text));
}

// Eine mitgeladene Ressource, kein eigener Seitenaufruf.
function istAsset(pfad) {
  return /\.(css|js|mjs|woff2?|ttf|otf|eot|png|svg|ico|jpe?g|webp|gif|avif|map)$/i.test(pfad);
}

function klassifiziere(e) {
  const ua = e.httpRequest?.userAgent || '';
  const pfad = e.pfad;
  const status = e.httpRequest?.status;

  if (pfad.startsWith('/.well-known/acme-challenge/') || /Google-Trust-Services/i.test(ua)) return 'zertifikat';
  if (EIGENE_IPS.has(e.httpRequest?.remoteIp) || passt(EIGEN_UA, ua)) return 'eigen';
  if (passt(KI_UA, ua)) return 'ki';
  if (passt(SUCHMASCHINE_UA, ua)) return 'suchmaschine';
  if (passt(VORSCHAU_UA, ua)) return 'vorschau';
  if (status === 404 && STANDARD_PFAD.includes(pfad)) return 'fehlend';
  if (passt(SCANNER_PFAD, pfad)) return 'scanner';
  // Leerer oder als URL getarnter User-Agent ist ein verlaessliches
  // Scanner-Merkmal; Browser senden immer eine Kennung.
  if (!ua || /^https?:\/\//i.test(ua)) return 'scanner';
  // Kopfloser Browser heisst Automatisierung, nicht unbedingt Boesartigkeit —
  // ein echter Besucher ist es trotzdem nicht.
  if (/HeadlessChrome|PhantomJS|python-requests|curl\/|Go-http-client|Wget/i.test(ua)) return 'scanner';
  if (status === 404 && pfad.includes('/.')) return 'scanner';
  return 'besucher';
}

// --- Daten holen ----------------------------------------------------------

function abbruch(meldung, hinweis) {
  console.error(`\nFEHLER: ${meldung}`);
  if (hinweis) console.error(hinweis);
  console.error('');
  process.exit(1);
}

function holeLogs() {
  const args = [
    'logging', 'read', 'resource.type="firebase_domain"',
    `--project=${PROJEKT}`, `--freshness=${TAGE}d`, `--limit=${LIMIT}`, '--format=json',
  ];
  const lauf = spawnSync('gcloud', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

  if (lauf.error?.code === 'ENOENT') {
    abbruch('gcloud ist nicht installiert oder nicht im PATH.',
      'Installation: https://cloud.google.com/sdk/docs/install');
  }
  if (lauf.status !== 0) {
    const fehler = (lauf.stderr || '').trim();
    if (/invalid_grant|reauthentication|credentials/i.test(fehler)) {
      abbruch('Die gcloud-Anmeldung ist abgelaufen.', 'Bitte neu anmelden:  gcloud auth login');
    }
    if (/permission|403|does not have/i.test(fehler)) {
      abbruch(`Keine Leserechte auf das Projekt ${PROJEKT}.`,
        'Pruefe mit "gcloud auth list", ob das richtige Konto aktiv ist.');
    }
    abbruch('gcloud konnte die Logs nicht lesen.', fehler.split('\n').slice(0, 4).join('\n'));
  }

  try {
    return JSON.parse(lauf.stdout || '[]');
  } catch {
    return abbruch('Die Antwort von gcloud war kein gueltiges JSON.', '');
  }
}

function holeDownloads() {
  if (OHNE_DOWNLOADS) return null;
  const lauf = spawnSync('gh', ['api', `repos/${REPO}/releases`, '--paginate'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (lauf.status !== 0) return null;
  try {
    const releases = JSON.parse(lauf.stdout);
    return releases.map((r) => ({
      version: r.tag_name,
      datum: r.published_at,
      downloads: (r.assets || []).reduce((s, a) => s + (a.download_count || 0), 0),
    })).filter((r) => r.downloads > 0).slice(0, 6);
  } catch {
    return null;
  }
}

// --- Auswerten ------------------------------------------------------------

function auswerten(roh) {
  const eintraege = roh.map((e) => {
    let pfad = '?';
    try { pfad = new URL(e.httpRequest?.requestUrl || '').pathname; } catch { /* bleibt ? */ }
    const angereichert = { ...e, pfad, zeit: new Date(e.timestamp) };
    angereichert.kategorie = klassifiziere(angereichert);
    return angereichert;
  }).sort((a, b) => a.zeit - b.zeit);

  // Zweiter Durchgang: Ein Browser laedt zu jeder Seite auch Stylesheet,
  // Skript und Schriften nach. Wer ueber den gesamten Zeitraum nur HTML
  // abholt und nie eine Ressource, ist entweder ein Bot ohne eigene Kennung
  // oder ein Wiederkehrer mit warmem Cache (CSS und JS gelten hier einen Tag).
  // Beides ist kein neuer Besuch und wird deshalb getrennt ausgewiesen — sonst
  // zaehlt der Report Maschinen als Publikum.
  const gruppenSchluessel = (e) => `${e.httpRequest?.remoteIp}|${e.httpRequest?.userAgent}`;
  const assetsProGruppe = new Map();
  for (const e of eintraege) {
    if (e.kategorie !== 'besucher') continue;
    const k = gruppenSchluessel(e);
    assetsProGruppe.set(k, (assetsProGruppe.get(k) || 0) + (istAsset(e.pfad) ? 1 : 0));
  }
  for (const e of eintraege) {
    if (e.kategorie === 'besucher' && assetsProGruppe.get(gruppenSchluessel(e)) === 0) {
      e.kategorie = 'ohne-assets';
    }
  }

  const besucher = eintraege.filter((e) => e.kategorie === 'besucher');
  const ohneAssets = eintraege.filter((e) => e.kategorie === 'ohne-assets');

  // Sitzungen schaetzen: gleiche IP und gleicher User-Agent, eine Pause von
  // mehr als 30 Minuten beginnt eine neue Sitzung. Das ist die uebliche
  // Konvention der Webanalyse und ohne Cookies das Beste, was aus reinen
  // Serverlogs herauszuholen ist.
  const proBesucher = new Map();
  for (const e of besucher) {
    const schluessel = `${e.httpRequest?.remoteIp}|${e.httpRequest?.userAgent}`;
    if (!proBesucher.has(schluessel)) proBesucher.set(schluessel, []);
    proBesucher.get(schluessel).push(e);
  }
  let sitzungen = 0;
  for (const liste of proBesucher.values()) {
    sitzungen += 1;
    for (let i = 1; i < liste.length; i += 1) {
      if (liste[i].zeit - liste[i - 1].zeit > 30 * 60 * 1000) sitzungen += 1;
    }
  }

  const istSeite = (e) => /text\/html/i.test(e.jsonPayload?.contentType || '')
    && [200, 304].includes(e.httpRequest?.status);
  const seitenaufrufe = besucher.filter(istSeite);

  const zaehle = (liste, fn) => {
    const m = new Map();
    for (const e of liste) {
      const k = fn(e);
      if (k == null || k === '') continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const externerReferrer = (e) => {
    const r = e.httpRequest?.referer;
    if (!r) return null;
    try {
      const host = new URL(r).hostname;
      return host.endsWith('snotra-ai.dev') ? null : host;
    } catch { return null; }
  };

  const proTag = new Map();
  for (const e of eintraege) {
    const tag = e.zeit.toISOString().slice(0, 10);
    if (!proTag.has(tag)) proTag.set(tag, { gesamt: 0, besucher: 0, seiten: 0 });
    const z = proTag.get(tag);
    z.gesamt += 1;
    if (e.kategorie === 'besucher') { z.besucher += 1; if (istSeite(e)) z.seiten += 1; }
  }

  return {
    zeitraum: eintraege.length
      ? { von: eintraege[0].timestamp, bis: eintraege[eintraege.length - 1].timestamp }
      : null,
    gesamt: eintraege.length,
    kategorien: Object.fromEntries(KATEGORIEN.map(([k]) => [k, eintraege.filter((e) => e.kategorie === k).length])),
    besucher: {
      anfragen: besucher.length,
      sitzungen,
      seitenaufrufe: seitenaufrufe.length,
      seiten: zaehle(seitenaufrufe, (e) => e.pfad),
      laender: zaehle(besucher, (e) => e.jsonPayload?.remoteIpCountry),
      referrer: zaehle(besucher, externerReferrer),
    },
    ohneAssets: {
      anfragen: ohneAssets.length,
      quellen: new Set(ohneAssets.map(gruppenSchluessel)).size,
      laender: zaehle(ohneAssets, (e) => e.jsonPayload?.remoteIpCountry),
    },
    fehlend: zaehle(eintraege.filter((e) => e.kategorie === 'fehlend'), (e) => e.pfad),
    scannerZiele: zaehle(eintraege.filter((e) => e.kategorie === 'scanner'), (e) => e.pfad),
    kiBots: zaehle(eintraege.filter((e) => e.kategorie === 'ki'), (e) => kuerzeBot(e.httpRequest?.userAgent)),
    suchBots: zaehle(eintraege.filter((e) => e.kategorie === 'suchmaschine'), (e) => kuerzeBot(e.httpRequest?.userAgent)),
    fehler: zaehle(eintraege.filter((e) => e.httpRequest?.status >= 500), (e) => `${e.httpRequest.status} ${e.pfad}`),
    proTag: [...proTag.entries()].sort(),
  };
}

function kuerzeBot(ua) {
  if (!ua) return '(unbekannt)';
  const m = ua.match(/([A-Za-z][A-Za-z0-9-]*(?:[Bb]ot|[Ss]pider|-User|-Extended)[A-Za-z0-9.]*)/);
  return m ? m[1] : ua.slice(0, 40);
}

// --- Ausgabe --------------------------------------------------------------

const ESC = String.fromCharCode(27);
const B = (s) => (process.stdout.isTTY ? `${ESC}[1m${s}${ESC}[0m` : s);
const GRAU = (s) => (process.stdout.isTTY ? `${ESC}[90m${s}${ESC}[0m` : s);

function datum(iso) {
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

function liste(titel, eintraege, max = 8, leer = 'keine') {
  console.log(`\n  ${B(titel)}`);
  if (!eintraege.length) { console.log(`    ${GRAU(leer)}`); return; }
  for (const [name, anzahl] of eintraege.slice(0, max)) {
    console.log(`    ${String(anzahl).padStart(5)}  ${name}`);
  }
  const rest = eintraege.length - max;
  if (rest > 0) console.log(`    ${GRAU(`... und ${rest} weitere`)}`);
}

function ausgeben(a, downloads) {
  console.log('');
  console.log(B(`  Traffic snotra-ai.dev - letzte ${TAGE} Tage`));
  if (!a.zeitraum) {
    console.log(`\n  ${GRAU('Keine Eintraege im Zeitraum.')}`);
    console.log(`  ${GRAU('Cloud Logging protokolliert erst ab Aktivierung, nicht rueckwirkend.')}\n`);
    return;
  }
  console.log(GRAU(`  ${datum(a.zeitraum.von)} bis ${datum(a.zeitraum.bis)} · ${a.gesamt} Anfragen`));

  const b = a.besucher;
  console.log(`\n  ${B('ECHTE BESUCHER')}`);
  console.log(`    Sitzungen        ${String(b.sitzungen).padStart(6)}`);
  console.log(`    Seitenaufrufe    ${String(b.seitenaufrufe).padStart(6)}`);
  console.log(`    Anfragen gesamt  ${String(b.anfragen).padStart(6)}  ${GRAU('(inkl. CSS, Schriften, Bilder)')}`);

  liste('Aufgerufene Seiten', b.seiten);
  liste('Laender', b.laender, 6);
  liste('Verweise von ausserhalb', b.referrer, 6, 'keine - alle Aufrufe direkt');

  const o = a.ohneAssets;
  if (o.anfragen) {
    console.log(`\n  ${B('ABRUFE OHNE MITLADEN')}  ${GRAU(`- ${o.anfragen} Anfragen aus ${o.quellen} Quellen`)}`);
    console.log(GRAU('    Holen nur die HTML-Seite, nie Stylesheet, Skript oder Schriften.'));
    console.log(GRAU('    Das sind Bots ohne eigene Kennung - oder Wiederkehrer mit warmem'));
    console.log(GRAU('    Cache. Bewusst nicht als Besucher gezaehlt.'));
    console.log(`    ${GRAU('Laender:')} ${o.laender.slice(0, 8).map(([k, n]) => `${k} ${n}`).join('  ')}`);
  }

  console.log(`\n  ${B('WOHER DIE ANFRAGEN KOMMEN')}`);
  for (const [schluessel, name] of KATEGORIEN) {
    const n = a.kategorien[schluessel] || 0;
    if (!n) continue;
    const anteil = Math.round((n / a.gesamt) * 100);
    const balken = '#'.repeat(Math.max(1, Math.round(anteil / 4)));
    console.log(`    ${String(n).padStart(5)}  ${String(`${anteil}%`).padStart(4)}  ${name.padEnd(28)} ${GRAU(balken)}`);
  }

  if (a.kiBots.length) liste('KI-Crawler im Einzelnen', a.kiBots, 6);
  if (a.suchBots.length) liste('Suchmaschinen im Einzelnen', a.suchBots, 6);

  if (a.fehlend.length) {
    console.log(`\n  ${B('FEHLENDE STANDARDDATEIEN')}  ${GRAU('- hier lohnt sich Nachbessern')}`);
    for (const [pfad, n] of a.fehlend) console.log(`    ${String(n).padStart(5)}  ${pfad}  ${GRAU('404')}`);
  }

  if (a.fehler.length) {
    console.log(`\n  ${B('SERVERFEHLER')}  ${GRAU('- sollte leer sein')}`);
    for (const [k, n] of a.fehler.slice(0, 6)) console.log(`    ${String(n).padStart(5)}  ${k}`);
  }

  liste('Haeufigste Scanner-Ziele', a.scannerZiele, 6, 'keine');

  if (a.proTag.length > 1) {
    console.log(`\n  ${B('VERLAUF')}`);
    console.log(GRAU('    Tag           Besucher-Anfragen   Seitenaufrufe   alle Anfragen'));
    for (const [tag, z] of a.proTag) {
      console.log(`    ${tag}  ${String(z.besucher).padStart(13)}  ${String(z.seiten).padStart(14)}  ${String(z.gesamt).padStart(13)}`);
    }
  }

  if (downloads?.length) {
    console.log(`\n  ${B('RELEASE-DOWNLOADS')}  ${GRAU('- Gesamtstand seit Veroeffentlichung, nicht im Zeitraum')}`);
    for (const r of downloads) {
      console.log(`    ${String(r.downloads).padStart(5)}  ${r.version.padEnd(10)} ${GRAU(r.datum ? r.datum.slice(0, 10) : '')}`);
    }
  }
  console.log('');
}

// --- Hauptlauf ------------------------------------------------------------

const roh = holeLogs();
const auswertung = auswerten(roh);
const downloads = holeDownloads();

if (ALS_JSON) {
  console.log(JSON.stringify({ ...auswertung, downloads }, null, 2));
} else {
  ausgeben(auswertung, downloads);
}
