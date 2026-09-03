# Task-Management

Für dieses Projekt gilt folgende Konvention (Entscheidung vom 2026-07-01, siehe PR #16):

- **Konkrete, abarbeitbare Aufgaben** (Bugs, einzelne Features, Tasks) werden als
  **GitHub Issues** erfasst — https://github.com/kkrafft1999/snotra/issues.
  Vorlagen: `.github/ISSUE_TEMPLATE/bug_report.yml` (🐛) und
  `.github/ISSUE_TEMPLATE/feature_request.yml` (💡).
- Der **Fortschritt** einzelner Issues wird in einem **GitHub Project**
  (Kanban-Board: Backlog → To do → In Progress → Done) verfolgt —
  https://github.com/kkrafft1999/snotra/projects.
- Die **grobe Richtung / der Fahrplan** (was ist umgesetzt, was ist als
  Nächstes geplant, was sind spätere Ideen) steht in
  [`docs/roadmap.md`](../../docs/roadmap.md). Diese Datei wird nur bei
  größeren Verschiebungen aktualisiert, nicht für jede einzelne Aufgabe.
- Neue Issues werden **direkt per `gh issue create`** angelegt — `gh` ist in
  dieser Umgebung mit Schreibzugriff eingerichtet (Token-Scope `repo`,
  Stand 2026-09-03). Nur wenn das ausnahmsweise nicht geht (anderer Rechner,
  fehlender Scope, kein Netz), werden Aufgaben vorübergehend in
  [`docs/task.md`](../../docs/task.md) gesammelt — siehe eigener Abschnitt
  „Zwischenablage `docs/task.md`“ unten (Entscheidung vom 2026-07-01,
  Fallback-Rolle seit 2026-09-03).
- Bewusst **kein** externes Tool (Linear/Trello/Notion/Jira) — alles bleibt
  in GitHub bzw. im Repo, da Solo-/Hobby-Projekt und bereits vollständig
  GitHub-basiert.

## Zwischenablage `docs/task.md`

- **Zweck:** Aufgaben/Ideen zwischenspeichern, die schon konkret genug für
  ein GitHub Issue sind, aber (noch) nicht als Issue angelegt wurden.
- **Regelmäßig synchronisieren**: Vor größeren Antworten zum Thema
  Aufgaben/Backlog mit den GitHub Issues abgleichen (`gh issue list
  --repo kkrafft1999/snotra --state all`).
- **Sobald ein Eintrag als GitHub Issue existiert**, wird der Eintrag aus
  `docs/task.md` **entfernt** — das Issue ist danach die einzige Quelle der
  Wahrheit, keine Duplikate pflegen.
- **Reiner Zwischenspeicher, kein Archiv:** `docs/task.md` bleibt leer
  (Abschnitt „Offene Einträge“ nur mit Platzhaltertext), sobald alle
  gesammelten Punkte als Issues angelegt sind. Es wird **keine
  Verweisliste/Historie** der bereits übertragenen Issues in `task.md`
  zurückgelassen (auch keine Liste mit Issue-Links) — diese Information
  steht ausschließlich in GitHub selbst (Entscheidung vom 2026-07-12).
- Details zum genauen Ablauf stehen direkt in der Kopfzeile von
  `docs/task.md`.

## Verhalten bei Fragen wie "Was steht an?", "Was ist der aktuelle Stand?", "Backlog?"

1. **GitHub Issues abfragen** (offene Tasks), z. B. mit dem `gh` CLI:
   ```sh
   gh issue list --repo kkrafft1999/snotra --state open
   ```
2. **`docs/task.md` lesen** für Aufgaben, die schon formuliert, aber noch
   nicht als Issue angelegt sind.
3. **`docs/roadmap.md` lesen** für die grobe Richtung (Abschnitte „Jetzt / als
   Nächstes“ und „Später / Ideen“).
4. Alle drei Quellen zusammenfassen: offene Issues + `task.md`-Einträge =
   konkrete nächste Schritte, Roadmap = übergeordneter Kontext dazu.
5. Falls keine der drei Quellen etwas liefert, das explizit sagen statt
   etwas zu erfinden.

## Verhalten bei neuen Aufgaben/Ideen im Gespräch

- Wenn der Nutzer eine **konkrete Aufgabe oder einen Bug** nennt: Issue-Text
  nach dem passenden Template formulieren (Abschnitte des Templates als
  Überschriften, dazu bewährt: Ist-Zustand mit Prüfdatum, Querbezüge,
  Definition of Done) und das Issue **direkt anlegen**:
  ```sh
  gh issue create --repo kkrafft1999/snotra --label enhancement \
    --title "…" --body-file <datei>
  ```
  (Bugs mit `--label bug`.) Den Link danach im Gespräch nennen. Der Token hat
  **keinen `project`-Scope** — die Zuordnung zum Kanban-Board macht der
  Nutzer selbst; darauf hinweisen.
- Nur wenn `gh` nicht schreiben kann (`gh auth status` zeigt keinen
  `repo`-Scope oder der Aufruf scheitert): fertigen Issue-Text in
  `docs/task.md` ablegen und zum manuellen Anlegen anbieten. Sobald das Issue
  existiert, den Eintrag aus `docs/task.md` wieder entfernen.
- Wenn der Nutzer eine **größere/grundsätzliche Idee** nennt (Epic-Level,
  passt eher zur Vision als zu einer einzelnen Aufgabe): Ergänzung in
  `docs/roadmap.md` vorschlagen statt (nur) ein Issue/Task.
