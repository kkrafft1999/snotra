---
name: traffic
description: >-
  Ruft den Traffic-Report für snotra-ai.dev aus den Firebase-Hosting-Logs ab
  (per gcloud), gibt ihn aus und visualisiert die Zahlen als Chart — sonst
  nichts, keine Einordnung in Prosa und keine Folgeaktionen. Auslösen bei
  Sätzen wie "wie läuft die Website", "Traffic-Report", "wie viele Besucher
  hatte die Seite", "Zugriffszahlen", "Website-Statistik", "wer war auf
  snotra-ai.dev", "schau mal, was auf der Seite los ist", "Besucher letzte
  Woche", "Traffic-Chart" oder "Diagramm zum Traffic". Nur in diesem Repo
  (snotra) sinnvoll.
---

# Traffic-Report für snotra-ai.dev

Dieser Skill tut zwei Dinge: den Report ziehen und ausgeben (Schritte 1–2) und
die Zahlen als Chart zeigen (Schritt 3). Sonst nichts — keine Einordnung der
Zahlen in Prosa, keine Anomalie-Prüfung, kein Issue-Anlegen, keine
Gegenrecherche auf der Live-Seite. Dafür gibt es keinen Auftrag, außer der
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
einordnen, nicht kommentieren, keine Folgeaktionen ableiten. Für das Chart in
Schritt 3 liefert `--json` dieselbe Auswertung maschinenlesbar:

```sh
node scripts/traffic-report.js --json --tage=7
```

Eigene Zugriffe lassen sich ausblenden:
`npm run traffic -- --eigene-ips=1.2.3.4` oder über `TRAFFIC_EIGENE_IPS`.

## Schritt 3 — Charts erstellen

Immer, ohne dass der Nutzer danach fragen muss. Die reinen Zahlen zeigen die
Verhältnisse nicht, genau dafür sind die Charts da.

Zeige zwei Diagramme, beide ausschließlich aus den Zahlen des gerade
gezogenen Reports:

1. **Anfragen nach Kategorie** — horizontales Balkendiagramm über alle
   Kategorien aus dem Block „Woher die Anfragen kommen" (Echte Besucher,
   Abrufe ohne Mitladen, KI-Crawler, Suchmaschinen, Eigene CI und Tests,
   Zertifikats-Prüfung, Scanner, Fehlende Standarddatei). Direkt beschriftet
   mit Anzahl und Anteil. Die Kategorien sind disjunkt und ergeben zusammen
   den Gesamtwert.
2. **Echte Besucher im Detail** — Sitzungen, Seitenaufrufe und die
   aufgerufenen Seiten. Das ist die Zahl, um die es geht; sie geht im großen
   Balkendiagramm sonst unter.

Regeln für beide:

- **Echte Besucher** visuell hervorheben; die übrigen Kategorien bleiben
  trotzdem einzeln unterscheidbar, nicht zu „Rest" zusammenfassen.
- Den **tatsächlich abgedeckten Zeitraum** aus dem Report nennen, nicht den
  angefragten. Ein `--tage=7`-Abruf kann wegen Log-Retention oder erst
  kürzlich aktivierter Protokollierung deutlich weniger enthalten.
- Nur Zahlen aus dem Report übernehmen. Keine IP-Adressen, keine erfundenen
  Trends, keine Vergleiche mit Zeiträumen, die nicht abgefragt wurden.
- Jedes Chart bekommt eine sichtbare Überschrift und einen Erstellungsstempel
  mit Datum, Modell und Reasoning-Effort.
