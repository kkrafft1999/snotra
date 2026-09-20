# Git-Workflow: pushen, PR und Merge ohne Aufforderung

Konvention vom 2026-09-20.

Eine fertige Aufgabe wird bis zum gemergten Pull Request durchgezogen, ohne
dass der Nutzer die einzelnen Schritte anstoßen muss. Die Rückfrage kostet in
diesem Projekt mehr, als sie schützt: Es ist ein Solo-Repo, `main` ist per
Ruleset geschützt, und das Test-Gate läuft ohnehin auf macOS, Windows und
Linux, bevor irgendetwas hineinkommt.

## Ohne Rückfrage

1. **Pushen und den PR erstellen, sobald die Tests lokal grün sind.** Grün
   heißt: `npm test` **und** `npm run test:e2e` vollständig durchgelaufen,
   ohne Fehler, auf dem Arbeitsbranch. Der PR bekommt `Closes #N` auf das
   zugehörige Issue (siehe [`task-management.md`](./task-management.md)) —
   auf Englisch, ein deutsches „Schließt #N“ schließt nichts.
2. **Mergen, sobald die Pipeline grün ist** und sonst nichts auffällt. Per
   **Squash** (Standard des Repos): `main` trägt einen Commit je PR, mit der
   PR-Nummer im Titel. Danach den Branch auf GitHub löschen — das Repo räumt
   nicht von selbst auf.

Der Nutzer erfährt hinterher in einem Satz, was passiert ist: PR-Nummer,
Merge, gelöschter Branch. Er muss es nicht vorher genehmigen, aber er soll es
nicht suchen müssen.

## Erst fragen

Alles, was nicht der glatte Fall ist:

- **Tests lokal rot** oder gar nicht gelaufen — dann wird auch nicht gepusht.
- **Checks rot, übersprungen oder noch offen.** Ein Merge wartet auf das
  vollständige Ergebnis; „läuft schon durch“ ist kein Ergebnis.
- **Offene Reviews oder Kommentare am PR**, die eine Antwort verlangen —
  auch von Bots, wenn sie einen echten Einwand tragen.
- **Konflikte mit `main`**, Force-Push, Rebase, alles, was Historie
  umschreibt.
- **Der Diff enthält mehr, als beauftragt war** — fremde Änderungen aus einer
  Parallel-Session, Zugangsdaten, Schlüssel, Änderungen am Release-Prozess
  oder an den Workflows unter `.github/`.
- **Direkt auf `main` schreiben:** nie, auch nicht mit Admin-Bypass.

Im Zweifel gilt der Zweifel: lieber den Stand melden und fragen, als einen
Merge zurückdrehen.

## Reihenfolge

Issue → Branch → Commits → lokale Tests → Push → PR mit `Closes #N` →
Pipeline → Squash-Merge → Branch löschen.
