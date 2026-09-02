# Roadmap

Grober Fahrplan für `Weyouze Anything`. Diese Datei ersetzt den bisherigen
Abschnitt „Aktueller Stand“ im README als Ort für die **große Linie**.

Für **konkrete, abarbeitbare Aufgaben** (Bugs, einzelne Features, Aufgaben)
werden [GitHub Issues](https://github.com/kkrafft1999/weyouze/issues)
verwendet — dafür gibt es Vorlagen für 🐛 Bugs und 💡 Feature-Ideen. Der
Status einzelner Issues lässt sich im zugehörigen
[GitHub Project](https://github.com/kkrafft1999/weyouze/projects) als
Kanban-Board verfolgen (Spalten: *Backlog* → *To do* → *In Progress* → *Done*).

Die **Schichtenarchitektur** (Ports, Adapter, Composition Root) ist in
[`docs/architecture.md`](./architecture.md) beschrieben.

Solange eine Aufgabe noch nicht als Issue angelegt ist (z. B. weil gerade
kein Schreibzugriff auf GitHub besteht), wird sie zwischenzeitlich in
[`docs/task.md`](./task.md) gesammelt und beim Anlegen des Issues dort
wieder entfernt.

> Kurz gesagt: **Diese Datei = Wohin geht's grundsätzlich. Issues = Was ist
> gerade konkret zu tun. `task.md` = Warteschlange für Aufgaben, die noch
> kein Issue sind.**

## ✅ Bereits umgesetzt

- 🗂️ Datei-Explorer für einen frei wählbaren Projektordner inkl. Verlauf
  zuletzt geöffneter Ordner
- 💬 Chat mit Workspace-Kontext (Modell kann Dateien lesen, Verzeichnisse
  listen, im Projekt arbeiten)
- 🔌 Mehrere LLM-Provider: OpenAI, Anthropic, Google (Gemini), Ollama (lokal)
- 🔐 API-Keys lokal & verschlüsselt über Electrons `safeStorage`
- 🧰 Tool-Use-Loop mit eingebauten Workspace-Tools: lesen und suchen
  (`list_directory`, `list_directory_tree`, `read_file_text`,
  `read_file_lines`, `search_in_files`, `find_files`, `stat_path`,
  `outline_file`), optional schreiben (`write_file_text`, `edit_file`,
  `apply_patch`)
- 🔔 Update-Notifier (Stufe 1) über GitHub Releases
- 🖥️ Builds für macOS (Apple Silicon) und Windows über Electron Forge
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

## 🚧 Jetzt / als Nächstes

- 🧩 Erweiterbares **Skill-Konzept** (Konfiguration + dynamisches Laden)
- 🛠️ Erweiterbares **Tool-Konzept** über das bestehende Workspace-Tool-Set
  hinaus

## 💡 Später / Ideen

- 🎯 **Use-Case-Profile**, die Plattform + Skills + Tools zu einer
  dedizierten Anwendung bündeln (z. B. HR-, IT-, Büro-Profile aus der
  README-Vision)
- 🔏 Code-Signing für macOS/Windows-Builds (Gatekeeper/SmartScreen entfällt)

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
