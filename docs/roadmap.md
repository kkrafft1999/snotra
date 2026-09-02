# Roadmap

Grober Fahrplan für `Weyouze Anything`. Diese Datei ersetzt den bisherigen
Abschnitt „Aktueller Stand“ im README als Ort für die **große Linie**.

> **Stand: 2026-09-02, Release v1.0.3.**

Für **konkrete, abarbeitbare Aufgaben** (Bugs, einzelne Features, Aufgaben)
werden [GitHub Issues](https://github.com/kkrafft1999/weyouze/issues)
verwendet — dafür gibt es Vorlagen für 🐛 Bugs und 💡 Feature-Ideen. Der
Status einzelner Issues lässt sich im zugehörigen
[GitHub Project](https://github.com/kkrafft1999/weyouze/projects) als
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
- 🔌 Mehrere LLM-Provider: OpenAI, Anthropic, Google (Gemini), Ollama (lokal)
- 🔐 API-Keys lokal & verschlüsselt über Electrons `safeStorage`
- 📝 **System-Prompt frei konfigurierbar** in den Einstellungen; die App
  ergänzt bei geöffnetem Ordner nur noch den Workspace-Kontext (Ordnername,
  Tool-Liste, markierter Pfad) und macht keine Ton- oder Sprachvorgaben mehr
- 🛡️ Workspace-Zugriff auf den geöffneten Ordner begrenzt; Symlinks nach
  außen werden abgewiesen
  ([#24](https://github.com/kkrafft1999/weyouze/pull/24))

### Tools

- 🧰 **Tool-Use-Loop mit erweiterbarer Tool-Registry**
  ([#17](https://github.com/kkrafft1999/weyouze/issues/17)): Workspace-Tools
  sind aus dem Kern in `src/main/tools/workspace-tool-registry.js`
  ausgelagert und werden dort registriert; neue Tools brauchen Handler,
  Registrierung, Anzeige-Zeile und Tests, aber keinen Eingriff in den
  Chat-Kern
- 📚 **Token-effizientes Datei-Toolset** (T1–T8,
  [#35](https://github.com/kkrafft1999/weyouze/issues/35)–[#41](https://github.com/kkrafft1999/weyouze/issues/41),
  [#43](https://github.com/kkrafft1999/weyouze/issues/43)): das Modell greift
  gezielt statt im Volltext auf lokale Dateien zu.
  Lesen und suchen: `list_directory`, `list_directory_tree`,
  `read_file_text`, `read_file_lines`, `search_in_files`, `find_files`,
  `stat_path`, `outline_file`.
  Optional schreiben (Einstellung *Schreibzugriff*): `write_file_text`,
  `edit_file`, `apply_patch`
- ☑️ **Tools einzeln zuschaltbar:** Einstellungen › Tools listet den Katalog
  der Registry mit Häkchen je Tool; abgewählte Tools erreichen das Modell
  weder als Definition noch im System-Prompt

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
  GitHub-Release veröffentlicht; der `release`-Skill (für Claude Code unter
  `.claude/skills/`, für Antigravity unter `.agents/skills/`) bündelt
  Versions-Bump, Tag und Push. Bisher: v1.0.0 bis v1.0.3
- 🔔 Update-Notifier (Stufe 1) über GitHub Releases

## 🚧 Jetzt / als Nächstes

- ⬆️ **Node 24 überall**
  ([#53](https://github.com/kkrafft1999/weyouze/issues/53), Priorität hoch):
  Node 20 ist seit April 2026 End of Life. Lokal, in der Release-Pipeline
  und bei den GitHub-Actions auf Node 24 (Active LTS) wechseln,
  `engines.node` und `.nvmrc` nachziehen
- 🧩 **Skill-Konzept (MVP)**
  ([#18](https://github.com/kkrafft1999/weyouze/issues/18)): Kern der
  Plattform-Vision. Ein Skill = Prompt/Arbeitsweise + Menge erlaubter Tools
  + optional Ablauf, als Konfiguration in einem `skills/`-Ordner, beim Start
  geladen und in den Einstellungen auswählbar. Baut auf Tool-Registry und
  Tool-Häkchen auf; dynamisches Nachladen zur Laufzeit ist Ausbaustufe
- 📎 **Dateien im Chat per `@` referenzieren**
  ([#52](https://github.com/kkrafft1999/weyouze/issues/52)): Autocomplete
  über die Workspace-Dateien wie in Claude Code oder Cursor. Eingefügt wird
  der relative Pfad; das Modell liest die Datei bei Bedarf selbst über die
  Lese-Tools, statt dass Inhalte automatisch eingebettet werden

## 💡 Später / Ideen

- 🎯 **Use-Case-Profile**, die Plattform + Skills + Tools zu einer
  dedizierten Anwendung bündeln (z. B. HR-, IT-, Büro-Profile aus der
  README-Vision); setzt das Skill-Konzept voraus
- 📄 **Dokument-Extraktion** (T9,
  [#42](https://github.com/kkrafft1999/weyouze/issues/42)): Read-only-Tool
  `extract_document_text` für PDF/DOCX/XLSX, möglichst abschnittsweise statt
  Volltext. Bewusst zurückgestellt: bringt schwere Dependencies mit und
  sprengt den Rahmen der reinen Datei-Durchforstung
- 🌐 **Website unter `snotra-ai.dev`**
  ([#21](https://github.com/kkrafft1999/weyouze/issues/21)): Landingpage mit
  Produktvorstellung, Screenshots und Download-Links auf die aktuellen
  GitHub-Releases. Die Domain `weyouze.dev` aus dem Issue ist durch
  `snotra-ai.dev` ersetzt
- 🔏 **Code-Signing** für macOS/Windows-Builds
  ([#19](https://github.com/kkrafft1999/weyouze/issues/19)): Developer-ID
  plus Notarisierung bzw. Windows-Zertifikat in der Release-Pipeline, damit
  Gatekeeper- und SmartScreen-Warnungen entfallen
- 🏗️ **Umstieg auf Electron Forge 8**, sobald es stabil ist (derzeit nur
  Alpha): behebt den letzten offenen Dependabot-Alert #71 (`extract-zip` über
  `@electron/packager` 18). Ein Override auf packager 20 scheitert an der
  geänderten Hook-API von Forge 7, deshalb bleibt der Alert bis dahin
  bewusst offen

## Workflow-Hinweise

- Neue Idee / Bug → als [Issue](https://github.com/kkrafft1999/weyouze/issues/new/choose)
  anlegen (Template wählen).
- Größere Themen aus dieser Roadmap werden bei Bedarf in mehrere Issues
  aufgeteilt, sobald sie konkret angegangen werden.
- Empfohlene Labels: `bug`, `enhancement`, `docs`, `good first issue`.
  Milestones können pro Release (`vX.Y.Z`) angelegt werden, siehe
  [`release.md`](./release.md).
- Diese Datei wird nur bei größeren Verschiebungen der Gesamtrichtung
  aktualisiert, nicht für jede einzelne Aufgabe.
