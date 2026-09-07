# Task-Management

Für dieses Projekt gilt: **Alles läuft über GitHub Issues.** Es gibt keine
`docs/roadmap.md` und keine `docs/task.md` mehr (Entscheidung vom 2026-09-07;
ursprüngliche Konvention vom 2026-07-01, siehe PR #16).

- **Jede Aufgabe** — Bug, einzelnes Feature, größeres Thema — wird als
  **GitHub Issue** erfasst: https://github.com/kkrafft1999/snotra/issues.
  Vorlagen: `.github/ISSUE_TEMPLATE/bug_report.yml` (🐛) und
  `.github/ISSUE_TEMPLATE/feature_request.yml` (💡).
- Der **Fortschritt** wird in einem **GitHub Project**
  (Kanban-Board: Backlog → To do → In Progress → Done) verfolgt —
  https://github.com/kkrafft1999/snotra/projects.
- Issues werden **direkt per `gh issue create`** angelegt — `gh` ist in dieser
  Umgebung mit Schreibzugriff eingerichtet (Token-Scope `repo`, Stand
  2026-09-03). Der Token hat **keinen `project`-Scope**: die Zuordnung zum
  Kanban-Board macht der Nutzer selbst, darauf hinweisen.
- Bewusst **kein** externes Tool (Linear/Trello/Notion/Jira) und **keine**
  Aufgabenlisten im Repo — alles bleibt in GitHub, da Solo-/Hobby-Projekt und
  bereits vollständig GitHub-basiert.

## Keine Task-Dateien im Repo anlegen

Die frühere Zwischenablage `docs/task.md` und der Fahrplan `docs/roadmap.md`
sind am 2026-09-07 ersatzlos entfernt worden, weil sie neben den Issues
veraltet sind. Also:

- **Keine** neue `task.md`, `roadmap.md`, `TODO.md`, `backlog.md` o. Ä.
  anlegen — auch nicht als „Zwischenspeicher“.
- Kann `gh` ausnahmsweise nicht schreiben (anderer Rechner, fehlender Scope,
  kein Netz): den fertigen Issue-Text **im Gespräch** ausgeben und den Nutzer
  bitten, ihn anzulegen. Nicht ins Repo schreiben.
- Der **Ist-Zustand** der App wird im `README.md` (Nutzersicht) und in
  `docs/architecture.md` (Struktur) beschrieben, nicht in einer Statusliste.

## Verhalten bei Fragen wie "Was steht an?", "Was ist der aktuelle Stand?", "Backlog?"

1. **Offene Issues abfragen:**
   ```sh
   gh issue list --repo kkrafft1999/snotra --state open
   ```
2. Bei Bedarf einzelne Issues nachlesen (`gh issue view <nr>`), um Abhängigkeiten
   und Prioritäten einzuordnen.
3. Zusätzlich den **Arbeitsbaum prüfen** (`git status`) — angefangene, noch nicht
   committete Arbeit gehört zur Antwort auf „Was steht an?“.
4. Zusammenfassen und eine Reihenfolge empfehlen. Falls es keine offenen Issues
   gibt, das explizit sagen statt etwas zu erfinden.

## Verhalten bei neuen Aufgaben/Ideen im Gespräch

- Wenn der Nutzer eine **konkrete Aufgabe, einen Bug oder eine Idee** nennt:
  Issue-Text nach dem passenden Template formulieren (Abschnitte des Templates
  als Überschriften, dazu bewährt: Ist-Zustand mit Prüfdatum, Querbezüge,
  Definition of Done) und das Issue **direkt anlegen**:
  ```sh
  gh issue create --repo kkrafft1999/snotra --label enhancement \
    --title "…" --body-file <datei>
  ```
  (Bugs mit `--label bug`.) Die Body-Datei in den Scratchpad legen, nicht ins
  Repo. Den Issue-Link danach im Gespräch nennen.
- **Größere/grundsätzliche Themen** (Epic-Level) bekommen ebenfalls ein Issue —
  ausformuliert genug, dass es später in mehrere Issues aufgeteilt werden kann.
  Es gibt keinen separaten Ort mehr für „die große Linie“.
