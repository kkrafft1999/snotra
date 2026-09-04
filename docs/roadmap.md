# Roadmap

Grober Fahrplan für `Snotra AI` (bis v1.0.4 „Weyouze Anything“, siehe
[#54](https://github.com/kkrafft1999/snotra/issues/54)). Diese Datei ersetzt
den bisherigen Abschnitt „Aktueller Stand“ im README als Ort für die **große
Linie**.

> **Stand: 2026-09-02, Release v1.1.0.**

Für **konkrete, abarbeitbare Aufgaben** (Bugs, einzelne Features, Aufgaben)
werden [GitHub Issues](https://github.com/kkrafft1999/snotra/issues)
verwendet — dafür gibt es Vorlagen für 🐛 Bugs und 💡 Feature-Ideen. Der
Status einzelner Issues lässt sich im zugehörigen
[GitHub Project](https://github.com/kkrafft1999/snotra/projects) als
Kanban-Board verfolgen (Spalten: *Backlog* → *To do* → *In Progress* → *Done*).

Die **Schichtenarchitektur** (Ports, Adapter, Composition Root) ist in
[`docs/architecture.md`](./architecture.md) beschrieben, der Release-Ablauf
in [`docs/release.md`](./release.md).

Solange eine Aufgabe noch nicht als Issue angelegt ist (z. B. weil gerade
kein Schreibzugriff auf GitHub besteht), wird sie zwischenzeitlich in
[`docs/task.md`](./task.md) gesammelt und beim Anlegen des Issues dort
wieder entfernt.

> Kurz gesagt: **Diese Datei = Wohin geht's grundsätzlich. Issues = Was ist
> gerade konkret zu tun. `task.md` = Warteschlange für Aufgaben, die noch
> kein Issue sind.**

## ✅ Bereits umgesetzt

### Plattform-Fundament

- 🗂️ Datei-Explorer für einen frei wählbaren Projektordner inkl. Verlauf
  zuletzt geöffneter Ordner
- 💬 Chat mit Workspace-Kontext (Modell kann Dateien lesen, Verzeichnisse
  listen, im Projekt arbeiten)
- 📎 **Dateien im Chat per `@` referenzieren**
  ([#52](https://github.com/kkrafft1999/snotra/issues/52)): Autocomplete
  über die Workspace-Dateien wie in Claude Code oder Cursor, mit den
  Ausschlussregeln von `find_files`. Eingefügt wird der relative Pfad; das
  Modell liest die Datei bei Bedarf selbst über die Lese-Tools, statt dass
  Inhalte automatisch eingebettet werden
- 🔌 Mehrere LLM-Provider: OpenAI, Anthropic, Google (Gemini), Ollama (lokal)
- 🔐 API-Keys lokal & verschlüsselt über Electrons `safeStorage`
- 📝 **System-Prompt frei konfigurierbar** in den Einstellungen; die App
  ergänzt bei geöffnetem Ordner nur noch den Workspace-Kontext (Ordnername,
  Tool-Liste, markierter Pfad) und macht keine Ton- oder Sprachvorgaben mehr
- 🛡️ Workspace-Zugriff auf den geöffneten Ordner begrenzt; Symlinks nach
  außen werden abgewiesen
  ([#24](https://github.com/kkrafft1999/snotra/pull/24))

### Tools

- 🧰 **Tool-Use-Loop mit erweiterbarer Tool-Registry**
  ([#17](https://github.com/kkrafft1999/snotra/issues/17)): Workspace-Tools
  sind aus dem Kern in `src/main/tools/workspace-tool-registry.js`
  ausgelagert und werden dort registriert; neue Tools brauchen Handler,
  Registrierung, Anzeige-Zeile und Tests, aber keinen Eingriff in den
  Chat-Kern
- 📚 **Token-effizientes Datei-Toolset** (T1–T8,
  [#35](https://github.com/kkrafft1999/snotra/issues/35)–[#41](https://github.com/kkrafft1999/snotra/issues/41),
  [#43](https://github.com/kkrafft1999/snotra/issues/43)): das Modell greift
  gezielt statt im Volltext auf lokale Dateien zu.
  Lesen und suchen: `list_directory`, `list_directory_tree`,
  `read_file_text`, `read_file_lines`, `search_in_files`, `find_files`,
  `stat_path`, `outline_file`.
  Optional schreiben (Einstellung *Schreibzugriff*): `write_file_text`,
  `edit_file`, `apply_patch`
- ☑️ **Tools einzeln zuschaltbar:** Einstellungen › Tools listet den Katalog
  der Registry mit Häkchen je Tool; abgewählte Tools erreichen das Modell
  weder als Definition noch im System-Prompt
- 🧾 **Tool-Log kompakt**
  ([#60](https://github.com/kkrafft1999/snotra/issues/60)): während des Laufs
  steht unter „Modell denkt nach …“ nur eine sich aktualisierende Tool-Zeile
  (bei parallelen Aufrufen mit „+N“); danach klappt der Log zu
  „‹letzter Schritt› · N weitere Schritte“ zusammen, Klick/Enter/Space öffnet
  die vollständige Schrittliste. Ein einzelner Schritt bleibt eine Zeile ohne
  Aufklappen; geladene Sessions verhalten sich gleich. Wartet das Modell
  zwischen zwei Tool-Runden, zeigt dieselbe Zeile „Modell denkt nach … ·
  N Schritte“ — die separate Phasen-Zeile gibt es nur noch vor dem ersten
  Tool-Schritt, damit nichts mehr springt. Die Darstellung orientiert sich an
  OpenAI Codex: Symbol je Tool-Art statt Balken und Häkchen, nach Abschluss
  eine gruppierte Zeile („1 Ordner aufgelistet · 3 Dateien gelesen · 1 Suche“),
  und die aufgeklappte Liste ist höhenbegrenzt, scrollt und blendet unten aus.
  Die Tool-Art kommt aus `src/shared/contracts/tool-categories.js` und wird im
  Verlauf mitgespeichert; Sessions von vorher zeigen weiter die Form
  „‹letzter Schritt› · N weitere Schritte“ ohne Symbole. Die Gruppen sind
  nach Wichtigkeit sortiert (Skill-Zugriff → geschrieben → Suche → gelesen →
  Ordner → Pfad → aktiver Skill → Pause), Auflistungen treten also zurück.
  Skills sind sichtbar: je aktivem Skill eine Zeile „Skill ‹name› aktiv“ am
  Anfang (Engine-Event `chat:progress` type `skills`) und eine eigene
  Kategorie für Lesezugriffe auf Skill-Dateien

### Architektur

- 📜 Gemeinsame **Contract-Schicht** (`src/shared/contracts/`): versionierte
  DTOs/Events, Enums und Validatoren für Chat, Streaming, Tools, Token-Usage
  und Einstellungen — Single Source of Truth für Main (require) und Renderer
  (generiertes ESM-Bundle)
- 🏗️ **Saubere, frontend-unabhängige Anwendungsarchitektur** (fünf Etappen):
  1. **Stabile Verträge:** `src/shared/contracts/` inkl. Settings-DTOs
     (`settings.js`)
  2. **Anwendungs-Core:** Chat-Orchestrierung in `src/application/chat/`
     (`chat-engine.js`, `chat-history-trim.js`); dünne Re-Exports unter
     `src/main/chat-engine.js` für bestehende Importe
  3. **Provider und Tools über Ports:** Anwendungs-Ports unter
     `src/application/ports/`; Adapter in `src/main/adapters/` (LLM, Tools,
     Preferences, Workspace-Pfade)
  4. **Infrastruktur abgrenzen:** Infrastruktur-Ports unter `src/main/ports/`;
     austauschbare Adapter für Storage, Dateisystem, Speech, Updates und
     Provider-Katalog; Verdrahtung in `src/main/composition/`
  5. **Frontend als Präsentationsschicht:** Renderer erhält normalisierte
     Settings-, Tool- und Verlaufs-Daten; provider-/tool-spezifische
     Semantik liegt in Main (`settings-presentation-service`,
     `chat-history-normalization`) und
     `src/shared/presentation/` — der Renderer behält nur DOM- und
     lokale Formatierung (z. B. Markdown, Zeitstempel)

### Build & Release

- 🖥️ Builds für macOS (Apple Silicon) und Windows über Electron Forge
- 🚀 **Release-Pipeline:** ein Tag `vX.Y.Z` stößt die GitHub-Actions-Pipeline
  an (`.github/workflows/release.yml`), die beide Builds baut und das
  GitHub-Release veröffentlicht; der `release`-Skill
  (`.claude/skills/release/`) bündelt Versions-Bump, Tag und Push. Bisher: v1.0.0 bis v1.1.0
- 🔔 Update-Notifier (Stufe 1) über GitHub Releases
- ⬆️ **Node 24 überall**
  ([#53](https://github.com/kkrafft1999/snotra/issues/53), v1.0.4): lokal,
  in der Release-Pipeline und bei den GitHub-Actions (alle auf ihren
  `node24`-Majors) auf Node 24 Active LTS; `engines.node >=24`, `.nvmrc`
  und `allowScripts` für npm 11. Der Release-Lauf zu v1.0.4 kam ohne
  Node-20-Warnung durch
- 🏷️ **Umbenennung zu Snotra AI**
  ([#54](https://github.com/kkrafft1999/snotra/issues/54), v1.1.0): App,
  Repo (`kkrafft1999/snotra`), npm-Paket und Release-Artefakte
  (`Snotra-AI-<version>-…`) tragen den neuen Namen, die Wordmark ist
  einzeilig, die Bundle-ID `dev.snotra-ai.app`. Beim ersten Start werden
  Einstellungen, Verlauf und Ordner-Historie aus dem alten `userData`-Ordner
  „Weyouze Anything“ kopiert (der bleibt als Backup). Unter macOS hängt der
  `safeStorage`-Schlüssel am App-Namen: API-Keys müssen einmal neu
  eingegeben werden (UI zeigt „Key neu eingeben“), ein nicht mehr lesbarer
  Chat-Verlauf wird gesichert statt überschrieben. Alte Installationen
  finden Updates über GitHubs Redirect vom alten Repo-Namen

- 🧩 **Skill-System**
  ([#18](https://github.com/kkrafft1999/snotra/issues/18)): Skills im
  Agent-Skills-Format (`SKILL.md` mit Frontmatter, agentskills.io) aus fünf
  Quellen — **System-Skills** aus `system-skills/` im App-Bundle (Teil des
  Produkts, voreingestellt aktiv, mitgeliefert: `snotra-capabilities` für
  Selbstauskunft der App) sowie **Ordner-Skills** aus `.agents/skills/` und
  `.claude/skills/`, jeweils im Workspace und unter `~`. Vorhandene
  Claude-Code-Skills sind damit direkt nutzbar, ein eigener Snotra-Ordner
  entfällt. Namenskonflikte: erster Treffer gewinnt, der Rest wird als
  „überdeckt“ angezeigt; ungültige Einträge mit Grund statt Scan-Abbruch.
  Auswahl je Skill unter Einstellungen › Skills (max. 8 gleichzeitig, kein
  Datei-Watcher, Button „Skills neu laden“); Ordner-Skills nie automatisch
  aktiv (Prompt-Injection). `allowed-tools` wird ignoriert, die Tool-Häkchen
  bleiben maßgeblich
- 📂 **Skill-Verzeichnisse als zweite Lesewurzel**
  ([#61](https://github.com/kkrafft1999/snotra/issues/61), Folge aus #18):
  Dateien neben der `SKILL.md` (`references/`, `assets/`, `scripts/`) sind
  jetzt auch dann lesbar, wenn der Skill außerhalb des geöffneten Ordners
  liegt — Adressierung über `skill:<name>/<pfad>`, nur für die Lese-Tools.
  Schreib-Tools bekommen die Skill-Wurzeln gar nicht erst übergeben, `..` und
  Symlinks werden wie beim Arbeitsordner gegen den echten Pfad geprüft, und
  die Tool-Zeile im Chat weist den Zugriff als Skill-Lesezugriff aus

## 🚧 Jetzt / als Nächstes

Entscheidung vom 2026-09-04: Bevor externe Tools dazukommen, bekommt Snotra
ein Berechtigungsmodell für Tool-Aufrufe. Reihenfolge:

1. **Sicherheitskonzept für Tool-Aufrufe**
   ([#65](https://github.com/kkrafft1999/snotra/issues/65)) — Konzept-Dokument
   `docs/sicherheitskonzept.md` nach Vorbild von Claude Code, Cursor und
   Codex: drei Modi (Auto / Immer fragen / Intelligent), Risikoklassen statt
   `requiresWrite`, Bestätigungsdialog im Chat, harte Grenzen, die kein Modus
   aufhebt.
2. **Kern-Infrastruktur umsetzen** in zwei Issues:
   [#66](https://github.com/kkrafft1999/snotra/issues/66) Kern
   (Risikoklassen in der Tool-Registry, Policy-Entscheidung, Freigabe-Schleife
   im Tool-Loop, Persistenz) und
   [#67](https://github.com/kkrafft1999/snotra/issues/67) UI (Modus-Wahl,
   Bestätigungskarte im Chat, Verwaltung gemerkter Freigaben) — getestet
   mit den vorhandenen Dateisystem-Tools.
3. Erst danach **MCP-Server**
   ([#62](https://github.com/kkrafft1999/snotra/issues/62)) und **Web-Suche**
   ([#63](https://github.com/kkrafft1999/snotra/issues/63)), die sich an die
   fertige Infrastruktur andocken.

## 💡 Später / Ideen

- 🎛️ **Skills gezielt aufrufen**: `/name` im Chat und Auto-Vorschlag anhand
  der Beschreibungen, statt der Häkchen in den Einstellungen; dazu ein
  Datei-Watcher, damit neue Skills ohne „Skills neu laden“ auftauchen

- 🎯 **Use-Case-Profile**, die Plattform + Skills + Tools zu einer
  dedizierten Anwendung bündeln (z. B. HR-, IT-, Büro-Profile aus der
  README-Vision); setzt das Skill-Konzept voraus
- 📄 **Dokument-Extraktion** (T9,
  [#42](https://github.com/kkrafft1999/snotra/issues/42)): Read-only-Tool
  `extract_document_text` für PDF/DOCX/XLSX, möglichst abschnittsweise statt
  Volltext. Bewusst zurückgestellt: bringt schwere Dependencies mit und
  sprengt den Rahmen der reinen Datei-Durchforstung
- 🌐 **Website unter `snotra-ai.dev`**
  ([#21](https://github.com/kkrafft1999/snotra/issues/21)): Landingpage mit
  Produktvorstellung, Screenshots und Download-Links auf die aktuellen
  GitHub-Releases; die Umbenennung
  ([#54](https://github.com/kkrafft1999/snotra/issues/54)) ist erledigt
- 🔏 **Code-Signing** für macOS/Windows-Builds
  ([#19](https://github.com/kkrafft1999/snotra/issues/19)): Developer-ID
  plus Notarisierung bzw. Windows-Zertifikat in der Release-Pipeline, damit
  Gatekeeper- und SmartScreen-Warnungen entfallen
- 🏗️ **Umstieg auf Electron Forge 8**, sobald es stabil ist (derzeit nur
  Alpha): behebt den letzten offenen Dependabot-Alert #71 (`extract-zip` über
  `@electron/packager` 18). Ein Override auf packager 20 scheitert an der
  geänderten Hook-API von Forge 7, deshalb bleibt der Alert bis dahin
  bewusst offen

## Workflow-Hinweise

- Neue Idee / Bug → als [Issue](https://github.com/kkrafft1999/snotra/issues/new/choose)
  anlegen (Template wählen).
- Größere Themen aus dieser Roadmap werden bei Bedarf in mehrere Issues
  aufgeteilt, sobald sie konkret angegangen werden.
- Empfohlene Labels: `bug`, `enhancement`, `docs`, `good first issue`.
  Milestones können pro Release (`vX.Y.Z`) angelegt werden, siehe
  [`release.md`](./release.md).
- Diese Datei wird nur bei größeren Verschiebungen der Gesamtrichtung
  aktualisiert, nicht für jede einzelne Aufgabe.
