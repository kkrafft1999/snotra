# Snotra AI

> Eine Electron-basierte Plattform, die per **Skills** und **Tools** zu Use-Case-spezifischen KI-Anwendungen ausgebaut werden kann.

## Vision

`Snotra AI` ist bewusst **kein** fertig zugeschnittenes Produkt, sondern eine **Plattform**:

- Die Electron-App liefert das Fundament: Fenster, Datei-Explorer, Chat-UI, Provider-Anbindung, sicheres Speichern von Keys, Tool-Use-Loop.
- Darauf aufgesetzt werden **Skills** (vorgefertigte Arbeitsweisen, Prompts, Abläufe) und **Tools** (konkrete Aktionen, die das Modell ausführen kann) – **dynamisch oder per Konfiguration**.
- So entstehen aus *einem* Basis-Programm viele **Use-Case-spezifische Anwendungen**:
  - 🏢 **Büroarbeit:** Angebote erstellen, Kampagnen planen, Präsentationen vorbereiten
  - 👥 **HR:** Stellenausschreibungen, Onboarding-Pakete, Mitarbeiterkommunikation
  - 🖥️ **IT:** Runbooks, Incident-Begleitung, Doku-Pflege
  - 👩‍💻 **Software-Engineering:** projektbezogene Code- und Repo-Assistenz

Der Name stammt aus der nordischen Mythologie: Snotra ist die Göttin der Klugheit und Besonnenheit. Er steht für einen Assistenten, der den Kontext seines Workspace kennt und überlegt handelt. Bis Version 1.0.4 hieß das Projekt „Weyouze Anything“.

> Status: **persönliches Hobby- / Experimentier-Projekt.** Schnittstellen, UI und Konfiguration können sich jederzeit ändern.

## Aktueller Stand & Roadmap

Den aktuellen Stand, was gerade in Arbeit ist und was als Nächstes geplant ist, gibt es in [`docs/roadmap.md`](./docs/roadmap.md). Konkrete Aufgaben (Bugs, einzelne Features) werden als [GitHub Issues](https://github.com/kkrafft1999/snotra/issues) getrackt, der Fortschritt im zugehörigen [GitHub Project](https://github.com/kkrafft1999/snotra/projects) (Kanban-Board).

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
git clone git@github.com:<dein-user>/snotra.git
cd snotra

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

## Chat

- **Senden:** `Enter` schickt die Nachricht ab, `Shift+Enter` fügt einen Zeilenumbruch ein. Während das Modell antwortet, wird der Senden-Button zum Abbrechen-Button.
- **Dateien per `@` referenzieren:** Tippst du `@` in die Eingabe, öffnet sich über dem Textfeld eine Liste der Dateien und Ordner des geöffneten Projektordners. Weiteres Tippen filtert – auch unscharf, `@rdmp` findet z. B. `docs/roadmap.md` –, `↑`/`↓` wählt, `Enter` oder `Tab` übernimmt, `Esc` schließt. Eingefügt wird der Pfad relativ zur Projektwurzel (`@docs/roadmap.md`); bei Ordnern bleibt die Liste offen (`@src/`), so dass du direkt in den Ordner weitertippen kannst. Die Liste blendet aus, was auch das Tool `find_files` überspringt: versteckte Einträge, `.git` und Muster aus der `.gitignore` des Projektroots. Ohne geöffneten Ordner bleibt `@` normaler Text.
- **Was das Modell davon sieht:** nur die Referenz im Text. Der System-Prompt erklärt die `@pfad`-Konvention; die Datei liest das Modell bei Bedarf selbst über die Lese-Tools, Inhalte werden nicht automatisch eingebettet (Token-Ziel).

## Konfiguration

Die meisten Einstellungen (Provider, Modelle, System-Prompt, Sprache) pflegst du direkt in der App unter **Einstellungen**. Darüber hinaus liegen im Benutzerprofil (`userData`-Ordner von Electron: macOS `~/Library/Application Support/Snotra AI`, Windows `%APPDATA%\Snotra AI`) ein paar JSON-Dateien, u. a. `ui-preferences.json` mit folgenden Optionen:

| Schlüssel          | Bedeutung                                                                  | Default   | Bereich          |
| ------------------ | -------------------------------------------------------------------------- | --------- | ---------------- |
| `maxToolRounds`    | Maximale Tool-Runden pro Chat-Anfrage (auch in der App einstellbar)         | 14        | 1 – 500          |
| `historyCharLimit` | Zeichen-Budget für den an den Provider gesendeten Chat-Verlauf (siehe unten)| 200 000   | 4 000 – 2 000 000 |
| `allowWorkspaceWrite` | Schaltet die Schreib-Tools `write_file_text`, `edit_file` und `apply_patch` frei (Einstellungen › Tools); ohne diese Option kann das Modell Dateien nur lesen | `false` | – |

**Umstieg von „Weyouze Anything“ (bis v1.0.4):** Beim ersten Start kopiert Snotra AI Einstellungen, Presets, Ordner-Historie und Chat-Verlauf aus dem alten `userData`-Ordner; der alte Ordner bleibt unverändert als Backup liegen. Unter macOS müssen die API-Keys einmal neu eingegeben werden, weil der Keychain-Eintrag von Electrons `safeStorage` am App-Namen hängt; die Einstellungen zeigen dann „Key neu eingeben“. Ein dadurch nicht mehr entschlüsselbarer Chat-Verlauf wird als `chat-history.json.undecryptable-<Zeitstempel>` gesichert statt überschrieben.

**Verlaufs-Trimming (`historyCharLimit`):** Damit lange Sessions nicht ins Token-Limit des Providers laufen, wird der Verlauf pro Anfrage budgetiert (Heuristik: 1 Token ≈ 4 Zeichen). Ältere Nachrichten jenseits des Budgets werden weggelassen, und große Tool-Ausgaben früherer Tool-Runden (z. B. gelesene Dateien) werden auf einen Platzhalter gekürzt. Die aktuelle Frage, alle User-Nachrichten im Fenster und die Tool-Ausgaben der jüngsten Runde bleiben immer vollständig erhalten.

**Schreibzugriff:** Standardmäßig kann das Modell im Workspace nur lesen. Wird `allowWorkspaceWrite` aktiviert, kommen drei Schreib-Tools hinzu (max. 2 MB pro Datei):

| Tool | Wofür |
| ---- | ----- |
| `write_file_text` | Textdatei anlegen oder komplett überschreiben; fehlende Zwischenordner werden automatisch erzeugt |
| `edit_file` | Eine gezielte Ersetzung in einer bestehenden Datei (`old_string` → `new_string`), ohne die ganze Datei neu zu schreiben |
| `apply_patch` | Mehrere zusammenhängende Änderungen in einem Aufruf — als Liste von Ersetzungen in einer Datei oder als unified diff über mehrere Dateien. Alles oder nichts: schlägt ein Schritt bzw. ein Hunk fehl, bleibt jede betroffene Datei unverändert. Dateien anlegen, löschen oder umbenennen kann das Tool nicht |

Der Zugriff bleibt wie bei den Lese-Tools strikt auf den Projektordner beschränkt. Im Chat erscheint die Tool-Zeile (z. B. „Datei docs/neu.md wird geschrieben …“) bereits, während das Modell den Inhalt noch erzeugt — nicht erst nach dem eigentlichen Schreibvorgang.

## Skills

Ein **Skill** ist ein Verzeichnis mit einer `SKILL.md` im
[Agent-Skills-Format](https://agentskills.io/specification): YAML-Frontmatter
mit `name` (muss dem Verzeichnisnamen entsprechen) und `description`, darunter
die Anweisungen als Markdown. Eingeschaltete Skills gehen als Teil des
System-Prompts ans Modell.

**System-Skills** liegen unter `system-skills/` im App-Bundle, gehören zum
Produkt und sind voreingestellt aktiv. Mitgeliefert wird
`snotra-capabilities` — damit kann die App Auskunft über sich selbst geben
(was geht, was nicht, wo etwas eingestellt wird), statt zu raten.

**Ordner-Skills** liest Snotra beim Öffnen eines Ordners aus vier Quellen, in
dieser Reihenfolge:

| # | Ebene | Pfad |
|---|-------|------|
| 1 | Workspace | `<ordner>/.agents/skills/*/SKILL.md` |
| 2 | Workspace | `<ordner>/.claude/skills/*/SKILL.md` |
| 3 | Benutzer | `~/.agents/skills/*/SKILL.md` |
| 4 | Benutzer | `~/.claude/skills/*/SKILL.md` |

Vorhandene Claude-Code-Skills sind damit direkt nutzbar; einen eigenen
Snotra-Ordner gibt es bewusst nicht. Gibt es denselben Namen mehrfach, gewinnt
der erste Treffer — die übrigen erscheinen in den Einstellungen als
„überdeckt“ mit Pfad. System-Skills stehen ganz vorn und lassen sich nicht
durch ein untergeschobenes Verzeichnis ersetzen. Ungültige Einträge (kein
Verzeichnis, fehlende `SKILL.md`, Name ≠ Verzeichnis) werden übersprungen und
mit Grund angezeigt, statt den Scan abzubrechen.

Verwaltet wird alles unter **Einstellungen › Skills**: Häkchen je Skill
(höchstens acht gleichzeitig), gruppiert nach Quelle, plus „Skills neu laden“
— gescannt wird beim Öffnen eines Ordners und auf Knopfdruck, es gibt keinen
Datei-Watcher. **Ordner-Skills sind nie automatisch aktiv:** Sie sind fremder
Inhalt und damit ein Prompt-Injection-Risiko, deshalb braucht jeder eine
ausdrückliche Auswahl. `allowed-tools` aus dem Frontmatter wird ignoriert —
maßgeblich bleiben die Tool-Häkchen unter Einstellungen › Tools.

Noch offen: Dateien neben der `SKILL.md` (`references/`, `assets/`,
`scripts/`) kann das Modell nur lesen, wenn sie im geöffneten Ordner liegen —
die Lese-Tools kennen bislang keine zweite Wurzel.

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
├── system-skills/       eingebaute System-Skills (je Verzeichnis eine `SKILL.md`)
├── test/                Tests (node:test), inkl. Architektur-Grenzwächter
├── scripts/             Build-Helfer (Vendor-Sync für den Renderer, Icon-Build)
├── docs/                Roadmap, Architektur (`architecture.md`, SVG-Diagramme)
├── assets/icon/         SVG-Quellen des App-Icons (macOS- und Windows-Layout)
├── icon.icns / icon.ico App-Icons für macOS / Windows, erzeugt per `node scripts/build-icons.js`
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
