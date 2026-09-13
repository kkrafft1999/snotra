---
name: traffic
description: >-
  Ruft den Traffic-Report für snotra-ai.dev aus den Firebase-Hosting-Logs ab
  (per gcloud), gibt ihn aus und erzeugt daraus grundsätzlich einen HTML-Report
  mit den Charts — sonst nichts, keine Einordnung in Prosa und keine
  Folgeaktionen. Auslösen bei Sätzen wie "wie läuft die Website",
  "Traffic-Report", "wie viele Besucher hatte die Seite", "Zugriffszahlen",
  "Website-Statistik", "wer war auf snotra-ai.dev", "schau mal, was auf der
  Seite los ist", "Besucher letzte Woche", "Traffic-Chart" oder "Diagramm zum
  Traffic". Nur in diesem Repo (snotra) sinnvoll.
---

# Traffic-Report für snotra-ai.dev

Dieser Skill tut zwei Dinge: den Report ziehen und ausgeben (Schritte 1–2) und
daraus einen HTML-Report mit den Charts bauen (Schritt 3). Sonst nichts — keine
Einordnung der Zahlen in Prosa, keine Anomalie-Prüfung, kein Issue-Anlegen,
keine Gegenrecherche auf der Live-Seite. Dafür gibt es keinen Auftrag, außer der
Nutzer verlangt es in der jeweiligen Nachricht ausdrücklich.

Die Maschine dahinter ist [`scripts/traffic-report.js`](../../../scripts/traffic-report.js),
Hintergrund steht in Issue
[#115](https://github.com/kkrafft1999/snotra/issues/115).

## Schritt 1 — Zeitraum bestimmen

Leite ihn aus der Nutzeräußerung ab, frage nicht nach:

- „heute", „gerade", „aktuell" → `--tage=1`
- „diese Woche", „letzte Woche", nichts gesagt → `--tage=7` (Standard)
- „diesen Monat", „insgesamt", „seit dem Start" → `--tage=30`

**Mehr als 30 Tage gibt es nicht.** Cloud Logging hält die Einträge 30 Tage im
Standard-Bucket, und protokolliert wird ohnehin erst seit dem **13.09.2026** —
dem Tag, an dem das Logging aktiviert wurde. Vorher existiert nichts, und das
lässt sich nicht nachholen. Sag das klar, wenn jemand nach früheren Zahlen
fragt, statt eine leere Auswertung zu zeigen.

## Schritt 2 — Report ziehen

```sh
npm run traffic -- --tage=7
```

Läuft rund 10 bis 30 Sekunden, weil `gcloud` die Logs seitenweise holt.

Schlägt der Aufruf fehl, sagt das Skript selbst, was zu tun ist. Die beiden
häufigen Fälle:

- **„Die gcloud-Anmeldung ist abgelaufen"** — der Nutzer muss selbst
  `gcloud auth login` ausführen. Melde dich **nicht** für ihn an und gib keine
  Zugangsdaten ein; reiche den Befehl weiter.
- **„Keine Leserechte auf das Projekt snotra-ai"** — meist ist das falsche
  Konto aktiv. Auf diesem Rechner sind zwei angemeldet; nötig ist das
  **private** Konto, nicht das doubleSlash-Konto. Prüfen mit `gcloud auth list`,
  wechseln mit `gcloud config set account <konto>`.

Gib die Ausgabe des Skripts unverändert weiter — nicht umformulieren, nicht
einordnen, nicht kommentieren, keine Folgeaktionen ableiten.

Für den HTML-Report in Schritt 3 dieselbe Auswertung maschinenlesbar ziehen und
gleich wegschreiben, damit die Zahlen nicht abgetippt werden müssen:

```sh
mkdir -p out/traffic && node scripts/traffic-report.js --json --tage=7 > out/traffic/report.json
```

Eigene Zugriffe lassen sich ausblenden:
`npm run traffic -- --eigene-ips=1.2.3.4` oder über `TRAFFIC_EIGENE_IPS`.

## Schritt 3 — HTML-Report erstellen

**Grundsätzlich, immer, ohne dass der Nutzer danach fragen muss.** Der
HTML-Report ist das Ergebnis dieses Skills; die Terminal-Ausgabe aus Schritt 2
bleibt daneben stehen, ersetzt ihn aber nicht.

### Ablageort

Eine einzelne, in sich geschlossene HTML-Datei:

```
out/traffic/traffic-<YYYY-MM-DD>-<tage>t.html
```

`out/` ist gitignored — der Report wird **nicht** committet. Die Datei muss
**innerhalb des Projekts** liegen, sonst rendert der Preview-Pane sie nur
statisch ohne JavaScript. Kein Artifact veröffentlichen: die Logdaten sind
nichts, was nach außen gehört, außer der Nutzer bittet ausdrücklich darum.

Kein externes CSS, kein CDN-Skript, keine Build-Schritte — Styles und, falls
nötig, Skript inline. Die Charts als reines HTML/CSS oder inline-SVG aus den
Zahlen bauen; eine Chart-Bibliothek braucht es dafür nicht.

### Inhalt

1. **Kopf** — Titel „Traffic-Report snotra-ai.dev", der **tatsächlich
   abgedeckte Zeitraum** aus `zeitraum.von`/`zeitraum.bis` (nicht der
   angefragte), Gesamtzahl der Anfragen.
2. **Kennzahlen** — Sitzungen, Seitenaufrufe und Anfragen echter Besucher als
   hervorgehobene Zahlen ganz oben.
3. **Anfragen nach Kategorie** — horizontales Balkendiagramm über alle
   Kategorien aus `kategorien` (Echte Besucher, Abrufe ohne Mitladen,
   KI-Crawler, Suchmaschinen, Link-Vorschau, Eigene CI und Tests,
   Zertifikats-Prüfung, Scanner und Angriffsversuche, Fehlende Standarddatei).
   Direkt beschriftet mit Anzahl und Anteil. Die Kategorien sind disjunkt und
   ergeben zusammen `gesamt`.
4. **Echte Besucher im Detail** — Sitzungen, Seitenaufrufe und die
   aufgerufenen Seiten (`besucher.seiten`), dazu Länder und externe Referrer,
   sofern vorhanden. Das ist die Zahl, um die es geht; sie geht im großen
   Balkendiagramm sonst unter.
5. **Verlauf pro Tag** — `proTag` als kleines Balken- oder Liniendiagramm, wenn
   der Zeitraum mehr als einen Tag umfasst.
6. **Weitere Tabellen**, nur wenn nicht leer: `kiBots`, `suchBots`,
   `scannerZiele`, `fehlend`, `fehler`, `downloads`.

### Regeln

- **Echte Besucher** visuell hervorheben; die übrigen Kategorien bleiben
  trotzdem einzeln unterscheidbar, nicht zu „Rest" zusammenfassen.
- Nur Zahlen aus dem Report übernehmen. Keine IP-Adressen, keine erfundenen
  Trends, keine Vergleiche mit Zeiträumen, die nicht abgefragt wurden.
- Leere Abschnitte weglassen statt mit Nullen zu füllen.
- Hell und dunkel lesbar (`prefers-color-scheme`), Tabellen mit eigenem
  `overflow-x: auto`, die Seite selbst scrollt nicht seitwärts.
- Der Report trägt eine sichtbare Überschrift und einen Erstellungsstempel mit
  Datum, Modell und Reasoning-Effort.

### Zeigen

Nach dem Schreiben die Datei im Browser-Pane öffnen (`preview_start` mit der
`file://`-URL der erzeugten Datei) und den Pfad im Gespräch nennen. Keine
Zusammenfassung des Reports hinterherschieben.
