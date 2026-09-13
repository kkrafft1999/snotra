---
name: traffic
description: >-
  Erstellt und deutet den Traffic-Report für snotra-ai.dev aus den
  Firebase-Hosting-Logs: holt die Zugriffe per gcloud, trennt echte Besucher
  von der eigenen CI, von KI-Crawlern und von Scannern und ordnet die Zahlen
  ein. Auslösen bei Sätzen wie "wie läuft die Website", "Traffic-Report",
  "wie viele Besucher hatte die Seite", "Zugriffszahlen", "Website-Statistik",
  "wer war auf snotra-ai.dev", "schau mal, was auf der Seite los ist",
  "Besucher letzte Woche". Nur in diesem Repo (snotra) sinnvoll.
---

# Traffic-Report für snotra-ai.dev

Dieser Skill übernimmt das komplette Reporting: Daten holen, auswerten und —
das ist der eigentliche Punkt — **einordnen**. Die nackten Zahlen sind
irreführend, wenn man sie nicht liest wie unten beschrieben.

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

Für eigene Weiterverarbeitung (Vergleiche, Diagramme) liefert
`--json` dieselbe Auswertung maschinenlesbar.

## Schritt 3 — Zahlen einordnen

Gib **nicht** die rohe Skriptausgabe weiter und lass sie auch nicht
unkommentiert stehen. Fasse zusammen, was sie bedeutet. Dabei gilt:

**„Echte Besucher" ist die einzige Zahl, die zählt.** Sie ist bewusst streng:
gezählt wird nur, wer neben der HTML-Seite auch Stylesheet, Skript oder
Schriften nachlädt — also wirklich einen Browser benutzt.

**„Abrufe ohne Mitladen" sind keine Besucher.** Diese Quellen holen nur das
HTML. Das sind fast immer Bots ohne eigene Kennung; es können auch
Wiederkehrer mit warmem Cache sein. Niemals zu den Besuchern addieren, auch
wenn die Zahl verlockend größer ist.

**Die eigene CI dominiert.** Jeder Lighthouse-Lauf erzeugt rund 60 Anfragen
vom emulierten Gerät „moto g power (2022)". Ein Anteil von 40 bis 50 % ist
normal und **kein** Traffic — nur erwähnen, wenn er auffällig abweicht.

**KI-Crawler sind ein eigenes Signal.** ClaudeBot, GPTBot und Verwandte holen
die Seite für Sprachmodelle. Das ist keine Reichweite bei Menschen, aber
durchaus Sichtbarkeit. Getrennt ausweisen.

**Scanner sind Rauschen.** Zugriffe auf `/.env`, `/wp-admin/…` und Ähnliches
sind Dauerzustand jeder öffentlichen Domain. Die Entscheidung, nichts dagegen
zu tun, ist bewusst gefallen (Firebase Hosting bietet kein WAF) — also **nicht**
jedes Mal Alarm schlagen. Erwähnenswert nur bei einer auffälligen Häufung oder
wenn ein Scan-Versuch **erfolgreich** war, also Status 200 statt 404.

### Referenzwerte vom 13.09.2026 (erste Betriebsstunden)

Zum Vergleich, ob eine Zahl aus dem Rahmen fällt:

| Kategorie | Anteil |
| --- | --- |
| Eigene CI | ~48 % |
| KI-Crawler | ~15 % |
| Abrufe ohne Mitladen | ~10 % |
| Scanner | ~8 % |
| **Echte Besucher** | **~5 %** |

Die Website ist frisch, das Projekt ein Hobby-Projekt: Einstellige
Besucherzahlen pro Tag sind der Normalfall und kein Anlass zur Sorge. Rede sie
weder schön noch schlecht — nenne sie, wie sie sind.

## Schritt 4 — Auffälligkeiten melden

Diese drei Blöcke im Report sind Handlungsaufforderungen, nicht Statistik:

1. **„Fehlende Standarddateien"** — 404 auf `/robots.txt`, `/favicon.ico`,
   `/sitemap.xml`. Das sind echte Lücken der eigenen Seite.
   Bekannt und erfasst: [#116](https://github.com/kkrafft1999/snotra/issues/116).
   Nur melden, was dort noch nicht steht.
2. **„Serverfehler"** — jeder Status ab 500 ist ein Fehler der Auslieferung.
   Der Block sollte leer sein. Ist er es nicht, ist das der wichtigste Punkt
   des ganzen Reports.
3. **Erfolgreiche Scanner-Treffer** — ein Scanner-Pfad mit Status 200 wäre
   ernst. Prüfen mit:

   ```sh
   node scripts/traffic-report.js --json --tage=7
   ```

Kommt dabei etwas Neues heraus, das Arbeit bedeutet: **Issue anlegen**, so wie
es [`.claude/rules/task-management.md`](../../rules/task-management.md)
vorschreibt — keine Notiz im Repo, keine Aufgabenliste.

## Grenzen, die du kennen musst

- **Downloads sind ein Gesamtstand.** Die Zahlen stammen aus der GitHub-API,
  weil die Release-Dateien nicht über Firebase laufen. GitHub liefert dafür
  keine zeitliche Aufschlüsselung — es ist die Summe seit Veröffentlichung,
  nicht der gewählte Zeitraum. Nie als „Downloads diese Woche" verkaufen.
- **Sitzungen sind geschätzt.** Gleiche IP und gleicher Browser, eine Pause von
  über 30 Minuten beginnt eine neue. Ohne Cookies geht es genauer nicht — und
  Cookies will die Seite bewusst nicht.
- **IP-Adressen sind personenbezogene Daten.** Sie bleiben im Log und in der
  lokalen Auswertung. Schreibe sie nicht in Issues, Commits oder Dateien im
  Repo. Der Report zeigt deshalb Länder, keine Adressen.
- Eigene Zugriffe lassen sich ausblenden:
  `npm run traffic -- --eigene-ips=1.2.3.4` oder über `TRAFFIC_EIGENE_IPS`.
