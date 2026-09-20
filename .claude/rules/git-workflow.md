# Git-Workflow: pushen und PR ohne Aufforderung, Merge beim Nutzer

Konvention vom 2026-09-20.

Eine fertige Aufgabe wird bis zum offenen Pull Request durchgezogen, ohne dass
der Nutzer die einzelnen Schritte anstößt. Die Rückfrage vor dem Pushen kostet
in diesem Repo mehr, als sie schützt: Es ist ein Solo-Repo, `main` ist per
Ruleset geschützt, und ein PR ist nichts, was man zurücknehmen müsste.

**Der Merge selbst bleibt beim Nutzer.** Nicht aus Vorsicht, sondern weil die
Umgebung ihn dem Agenten verwehrt: `gh pr merge --admin` wird als
*Merge Without Review* abgelehnt, das Eintragen einer passenden Berechtigung
als *Self-Modification*, das Lockern des Rulesets als *CI Bypass* (alle drei
am 2026-09-20 belegt). Drei Wege, dieselbe Entscheidung — das letzte Wort
darüber, was auf `main` landet, hat der Mensch. Eine Regel, die etwas anderes
verspricht, wäre nur eine Regel, die täglich bricht.

## Ohne Rückfrage

**Pushen und den PR erstellen, sobald die Tests lokal grün sind.** Grün heißt:
`npm test` **und** `npm run test:e2e` vollständig durchgelaufen, ohne Fehler,
auf dem Arbeitsbranch. Der PR bekommt `Closes #N` auf das zugehörige Issue
(siehe [`task-management.md`](./task-management.md)) — auf Englisch, ein
deutsches „Schließt #N“ schließt nichts.

Danach erfährt der Nutzer in einem Satz, was ihn erwartet: PR-Nummer, worum es
geht, ob die Pipeline schon durch ist. Er muss es nicht vorher genehmigen,
aber er soll es nicht suchen müssen.

## Den Merge vorbereiten, nicht durchführen

Ist die Pipeline durch, meldet der Agent den PR als **merge-bereit** und sagt
dazu, was er geprüft hat: alle Checks grün (nicht übersprungen, nicht offen),
keine Konflikte mit `main`, keine offenen Kommentare, der Diff enthält nichts
über den Auftrag hinaus. Fällt eines davon aus, steht das da statt „bereit“.

Gemergt wird per **Squash** (`main` trägt einen Commit je PR, mit der PR-Nummer
im Titel); den Branch räumt GitHub nicht von selbst weg, das Häkchen im Merge-
Dialog erledigt es.

## Erst fragen

Alles, was nicht der glatte Fall ist:

- **Tests lokal rot** oder gar nicht gelaufen — dann wird auch nicht gepusht.
- **Konflikte mit `main`**, Force-Push, Rebase, alles, was Historie
  umschreibt.
- **Der Diff enthält mehr, als beauftragt war** — fremde Änderungen aus einer
  Parallel-Session, Zugangsdaten, Schlüssel, Änderungen am Release-Prozess
  oder an den Workflows unter `.github/`.
- **Direkt auf `main` schreiben:** nie, auch nicht mit Admin-Bypass.

Im Zweifel gilt der Zweifel: lieber den Stand melden und fragen.

## Reihenfolge

Issue → Branch → Commits → lokale Tests → Push → PR mit `Closes #N` →
Pipeline → Meldung „merge-bereit“ → **der Nutzer mergt**.
