# Weyouze Anything

> **WeUseAnything** – eine Electron-basierte Plattform, die per **Skills** und **Tools** zu Use-Case-spezifischen KI-Anwendungen ausgebaut werden kann.

## Vision

`Weyouze Anything` (gesprochen: *"We Use Anything"*) ist bewusst **kein** fertig zugeschnittenes Produkt, sondern eine **Plattform**:

- Die Electron-App liefert das Fundament: Fenster, Datei-Explorer, Chat-UI, Provider-Anbindung, sicheres Speichern von Keys, Tool-Use-Loop.
- Darauf aufgesetzt werden **Skills** (vorgefertigte Arbeitsweisen, Prompts, Abläufe) und **Tools** (konkrete Aktionen, die das Modell ausführen kann) – **dynamisch oder per Konfiguration**.
- So entstehen aus *einem* Basis-Programm viele **Use-Case-spezifische Anwendungen**:
  - 🏢 **Büroarbeit:** Angebote erstellen, Kampagnen planen, Präsentationen vorbereiten
  - 👥 **HR:** Stellenausschreibungen, Onboarding-Pakete, Mitarbeiterkommunikation
  - 🖥️ **IT:** Runbooks, Incident-Begleitung, Doku-Pflege
  - 👩‍💻 **Software-Engineering:** projektbezogene Code- und Repo-Assistenz

Der Name betont den Plattform-Charakter: *"Wir nutzen alles"* – jedes Modell, jeden Workspace, jeden Skill, jedes Tool.

> Status: **persönliches Hobby- / Experimentier-Projekt.** Schnittstellen, UI und Konfiguration können sich jederzeit ändern.

## Aktueller Stand & Roadmap

Den aktuellen Stand, was gerade in Arbeit ist und was als Nächstes geplant ist, gibt es in [`docs/roadmap.md`](./docs/roadmap.md). Konkrete Aufgaben (Bugs, einzelne Features) werden als [GitHub Issues](https://github.com/kkrafft1999/weyouze/issues) getrackt, der Fortschritt im zugehörigen [GitHub Project](https://github.com/kkrafft1999/weyouze/projects) (Kanban-Board).

## Tech-Stack

- [Electron](https://www.electronjs.org/) (Main + Renderer + Preload)
- [Electron Forge](https://www.electronforge.io/) für Packaging & Maker (DMG / ZIP)
- Vanilla JS im Renderer + [`marked`](https://github.com/markedjs/marked) und [`DOMPurify`](https://github.com/cure53/DOMPurify) für Markdown
- [`@fontsource/inter`](https://fontsource.org/fonts/inter) als Schriftart

## Voraussetzungen

- **Node.js** ≥ 24 (Active LTS, siehe `.nvmrc`; mit nvm: `nvm use`)
- **npm** (kommt mit Node)
- macOS oder Windows
- Optional: API-Key für OpenAI / Anthropic / Google bzw. ein lokales [Ollama](https://ollama.com/)

## Schnellstart

```bash
# Repository klonen
git clone git@github.com:<dein-user>/weyouze.git
cd weyouze

# Abhängigkeiten installieren
npm install

# App im Entwicklungsmodus starten
npm start
```

Beim ersten Start kannst du in den Einstellungen einen Provider wählen und deinen API-Key eintragen. Der Key wird verschlüsselt im Benutzerprofil deines Betriebssystems abgelegt – er landet **nicht** im Projektordner und nicht im Repository.

## App bauen / paketieren

```bash
# macOS (Apple Silicon) – DMG + ZIP
npm run make

# Nur paketieren ohne Installer
npm run package         # macOS arm64
npm run package:win     # Windows x64
```

Die fertigen Artefakte landen im Ordner `out/` (per `.gitignore` ausgeschlossen).

## Konfiguration

Die meisten Einstellungen (Provider, Modelle, System-Prompt, Sprache) pflegst du direkt in der App unter **Einstellungen**. Darüber hinaus liegen im Benutzerprofil (`userData`-Ordner von Electron) ein paar JSON-Dateien, u. a. `ui-preferences.json` mit folgenden Optionen:

| Schlüssel          | Bedeutung                                                                  | Default   | Bereich          |
| ------------------ | -------------------------------------------------------------------------- | --------- | ---------------- |
| `maxToolRounds`    | Maximale Tool-Runden pro Chat-Anfrage (auch in der App einstellbar)         | 14        | 1 – 500          |
| `historyCharLimit` | Zeichen-Budget für den an den Provider gesendeten Chat-Verlauf (siehe unten)| 200 000   | 4 000 – 2 000 000 |
| `allowWorkspaceWrite` | Schaltet die Schreib-Tools `write_file_text`, `edit_file` und `apply_patch` frei (Einstellungen › Tools); ohne diese Option kann das Modell Dateien nur lesen | `false` | – |

**Verlaufs-Trimming (`historyCharLimit`):** Damit lange Sessions nicht ins Token-Limit des Providers laufen, wird der Verlauf pro Anfrage budgetiert (Heuristik: 1 Token ≈ 4 Zeichen). Ältere Nachrichten jenseits des Budgets werden weggelassen, und große Tool-Ausgaben früherer Tool-Runden (z. B. gelesene Dateien) werden auf einen Platzhalter gekürzt. Die aktuelle Frage, alle User-Nachrichten im Fenster und die Tool-Ausgaben der jüngsten Runde bleiben immer vollständig erhalten.

**Schreibzugriff:** Standardmäßig kann das Modell im Workspace nur lesen. Wird `allowWorkspaceWrite` aktiviert, kommen drei Schreib-Tools hinzu (max. 2 MB pro Datei):

| Tool | Wofür |
| ---- | ----- |
| `write_file_text` | Textdatei anlegen oder komplett überschreiben; fehlende Zwischenordner werden automatisch erzeugt |
| `edit_file` | Eine gezielte Ersetzung in einer bestehenden Datei (`old_string` → `new_string`), ohne die ganze Datei neu zu schreiben |
| `apply_patch` | Mehrere zusammenhängende Änderungen in einem Aufruf — als Liste von Ersetzungen in einer Datei oder als unified diff über mehrere Dateien. Alles oder nichts: schlägt ein Schritt bzw. ein Hunk fehl, bleibt jede betroffene Datei unverändert. Dateien anlegen, löschen oder umbenennen kann das Tool nicht |

Der Zugriff bleibt wie bei den Lese-Tools strikt auf den Projektordner beschränkt.

## Projektstruktur

```
.
├── src/
│   ├── application/     transport-agnostischer Anwendungs-Core (Chat, Ports)
│   │   ├── chat/        Chat-Engine, Verlaufstrim
│   │   └── ports/       LLM-, Tool-, Preferences- und weitere Kern-Ports
│   ├── main/            Electron Main-Prozess
│   │   ├── composition/ Composition Root (Verdrahtung aller Adapter)
│   │   ├── adapters/    Port-Implementierungen (LLM, Tools, Storage, FS, …)
│   │   ├── ports/       Infrastruktur-Port-Schnittstellen
│   │   ├── ipc/         dünne IPC-Handler
│   │   ├── providers/   LLM-Provider-Implementierungen
│   │   ├── services/    Infrastruktur (Storage, FS, Whisper, Updates, Präsentation)
│   │   └── tools/       Workspace-Tool-Registry
│   ├── preload/         sichere Bridge zwischen Main und Renderer (gebundelt)
│   ├── renderer/        UI (HTML, CSS, JS) — reine Präsentationsschicht
│   └── shared/          Contracts, IPC-Kanäle, gemeinsame Presentation-Helfer
├── test/                Tests (node:test), inkl. Architektur-Grenzwächter
├── scripts/             Build-Helfer (z. B. Vendor-Sync für den Renderer)
├── docs/                Roadmap, Architektur (`architecture.md`, SVG-Diagramme)
├── icon.icns / icon.ico App-Icons für macOS / Windows
└── package.json
```

Details zur Schichtenarchitektur: [`docs/architecture.md`](./docs/architecture.md).

## Sicherheitshinweise

- API-Keys werden **lokal** gespeichert und nicht an Dritte weitergegeben.
- Der Workspace-Zugriff der Tools ist auf den jeweils geöffneten Projektordner beschränkt.
- Schreibzugriff (`write_file_text`, `edit_file`, `apply_patch`) ist standardmäßig **deaktiviert** und muss bewusst unter Einstellungen › Tools aktiviert werden.
- Trotzdem gilt: lass das Modell nichts in Ordnern arbeiten, in denen sensible Daten liegen, denen du nicht traust.

## Lizenz

Apache License 2.0 – siehe [`LICENSE`](./LICENSE).

Copyright © 2026 Konrad Krafft.
