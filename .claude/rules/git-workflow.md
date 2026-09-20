# Git-Workflow: pushen, PR und Merge ohne gesonderte Aufforderung

Konvention vom 2026-09-20.

Eine fertige Aufgabe wird bis zum gemergten Pull Request durchgezogen, ohne
dass der Nutzer die einzelnen Schritte anstößt. Die Rückfrage kostet in diesem
Repo mehr, als sie schützt — was sie schützen soll, prüft eine Maschine
ohnehin zuverlässiger:

**Ruleset `23177645` auf `main`** verlangt einen Pull Request, verbietet
Force-Push und das Löschen des Branches und macht die drei Kontexte
`Tests (macos-14)`, `Tests (windows-latest)` und `Tests (ubuntu-latest)` zur
Pflicht. Ein roter Stand kommt damit nicht durch, auch nicht aus Versehen.

Bis zum 2026-09-20 verlangte das Ruleset stattdessen ein Review. Da es in
einem Solo-Repo niemanden gibt, der es geben könnte, war jeder Merge ein
Admin-Bypass — und den verweigert die Agent-Umgebung als *Merge Without
Review*, zu Recht. Mit dem Tausch Review → Pflicht-Checks ist der Merge ein
gewöhnlicher Merge über ein grünes Gate; am selben Tag belegt.

## Ohne Rückfrage

1. **Pushen und den PR anlegen, sobald die Tests lokal grün sind.** Grün
   heißt: `npm test` **und** `npm run test:e2e` vollständig durchgelaufen,
   ohne Fehler, auf dem Arbeitsbranch. Der PR bekommt `Closes #N` auf das
   zugehörige Issue (siehe [`task-management.md`](./task-management.md)) — auf
   Englisch, ein deutsches „Schließt #N" schließt nichts.
2. **Mergen, sobald die Pipeline grün ist** und die Prüfung unten nichts
   findet. Per **Squash**: `main` trägt einen Commit je PR, mit der PR-Nummer
   im Titel. Danach den Branch löschen, das Repo räumt nicht von selbst auf.

Der Nutzer erfährt hinterher in einem Satz, was passiert ist: PR-Nummer,
Merge, gelöschter Branch. Er muss es nicht vorher genehmigen, aber er soll es
nicht suchen müssen.

## Was vor dem Merge geprüft wird

- **Alle Pflicht-Checks grün** — nicht übersprungen, nicht noch offen.
  „Läuft schon durch" ist kein Ergebnis.
- **Keine Konflikte mit `main`** (`mergeable: MERGEABLE`, Status `CLEAN`).
- **Keine offenen Reviews oder Kommentare**, die eine Antwort verlangen —
  auch von Bots, wenn sie einen echten Einwand tragen.
- **Der Diff enthält nichts über den Auftrag hinaus** — keine fremden
  Änderungen aus einer Parallel-Session, keine Zugangsdaten oder Schlüssel,
  nichts am Release-Prozess oder an den Workflows unter `.github/`.

Fällt eines davon aus, wird nicht gemergt, sondern gemeldet.

Eine Lücke bleibt bewusst offen: Die CI fährt nur `npm test`, der
Electron-Smoke-Test läuft allein vor dem Push auf dem Rechner des Agenten
(#237). Solange das so ist, deckt das Pflicht-Gate nur eine der beiden
Testebenen ab — die andere bleibt Zusage, nicht Prüfung.

## Erst fragen

- **Tests lokal rot** oder gar nicht gelaufen — dann wird auch nicht gepusht.
- **Konflikte, Force-Push, Rebase**, alles, was Historie umschreibt.
- **Änderungen am Ruleset selbst** oder am Schutz von `main`. Wer das Gate
  verstellt, verstellt die Grundlage dieser Regel.
- **Direkt auf `main` schreiben:** nie, auch nicht mit Admin-Bypass.

Im Zweifel gilt der Zweifel: lieber den Stand melden und fragen, als einen
Merge zurückdrehen.

## Reihenfolge

Issue → Branch → Commits → lokale Tests → Push → PR mit `Closes #N` →
Pipeline → Prüfung oben → Squash-Merge → Branch löschen → ein Satz an den
Nutzer.
