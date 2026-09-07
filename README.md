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

## Aktueller Stand & Planung

Alles, was ansteht — Bugs, einzelne Features und größere Themen —, läuft über [GitHub Issues](https://github.com/kkrafft1999/snotra/issues). Den Fortschritt zeigt das zugehörige [GitHub Project](https://github.com/kkrafft1999/snotra/projects) (Kanban-Board: *Backlog* → *To do* → *In Progress* → *Done*).

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
- **Dateien per `@` referenzieren:** Tippst du `@` in die Eingabe, öffnet sich über dem Textfeld eine Liste der Dateien und Ordner des geöffneten Projektordners. Weiteres Tippen filtert – auch unscharf, `@rlse` findet z. B. `docs/release.md` –, `↑`/`↓` wählt, `Enter` oder `Tab` übernimmt, `Esc` schließt. Eingefügt wird der Pfad relativ zur Projektwurzel (`@docs/release.md`); bei Ordnern bleibt die Liste offen (`@src/`), so dass du direkt in den Ordner weitertippen kannst. Die Liste blendet aus, was auch das Tool `find_files` überspringt: versteckte Einträge, `.git` und Muster aus der `.gitignore` des Projektroots. Ohne geöffneten Ordner bleibt `@` normaler Text.
- **Screenshots einfügen:** Ein Bild in der Zwischenablage (macOS `Cmd+Ctrl+Shift+4`, Windows Snipping Tool) landet mit `Cmd/Ctrl+V` als Anhang über der Eingabezeile — mit Vorschau, Dateigröße und einem Knopf zum Entfernen. Der getippte Text bleibt dabei unberührt; ein Screenshot ohne Begleitfrage lässt sich ebenfalls abschicken. Erlaubt sind PNG, JPEG, GIF und WebP, bis zu 4 Bilder je Nachricht und 5 MB pro Bild; größere Bilder werden vor dem Senden auf 1568 px längste Kante verkleinert. Weil ein Screenshot oft mehr zeigt, als man bewusst teilen will, siehst du vor dem Senden immer die Vorschau — bei einem Cloud-Anbieter verlässt das Bild deinen Rechner. Aktuell reicht **OpenAI** die Bilder an das Modell weiter; für die übrigen Anbieter ist das in Arbeit, und im gespeicherten Verlauf sind Bilder noch nicht enthalten.
- **Was das Modell davon sieht:** nur die Referenz im Text. Der System-Prompt erklärt die `@pfad`-Konvention; die Datei liest das Modell bei Bedarf selbst über die Lese-Tools, Inhalte werden nicht automatisch eingebettet (Token-Ziel).

- **Websuche:** Mit einem hinterlegten Tavily-Schlüssel (Einstellungen › Tools › Websuche) bekommt das Modell das Tool `web_search` — es liefert Titel, URL und einen kurzen Auszug je Treffer, keine ganzen Seiten. Ohne Schlüssel wird das Tool gar nicht erst angeboten. Die Suchanfrage verlässt deinen Rechner, deshalb ist das Tool als **externer Dienst** eingestuft: im Modus „Intelligent“ fragt Snotra vor jeder Suche nach. Einen kostenlosen Schlüssel gibt es unter [app.tavily.com](https://app.tavily.com); er wird wie die Modell-Schlüssel verschlüsselt abgelegt. Wie alle Tools braucht auch die Suche einen geöffneten Projektordner.

**Netzwerk-Zeitlimits:** Modelllisten brechen nach 15 Sekunden (Cloud) bzw. 30 Sekunden (Ollama/MLX-LM) mit einer verständlichen Fehlermeldung ab, Sprachtranskriptionen nach 120 Sekunden. Die Zeitlimits umfassen auch das Lesen der Antwort. Schließen des Modell- oder Einstellungsdialogs sowie ein Anbieterwechsel brechen eine laufende Modellabfrage ab. Eine Transkription lässt sich über den Mikrofonknopf abbrechen; auch ein Kontextwechsel oder das Ausblenden der App verwirft die Spracheingabe. Verspätete Ergebnisse werden nicht mehr eingefügt.

## Konfiguration

Die meisten Einstellungen (Provider, Modelle, System-Prompt, Sprache) pflegst du direkt in der App unter **Einstellungen**. Darüber hinaus liegen im Benutzerprofil (`userData`-Ordner von Electron: macOS `~/Library/Application Support/Snotra AI`, Windows `%APPDATA%\Snotra AI`) ein paar JSON-Dateien, u. a. `ui-preferences.json` mit folgenden Optionen:

| Schlüssel          | Bedeutung                                                                  | Default   | Bereich          |
| ------------------ | -------------------------------------------------------------------------- | --------- | ---------------- |
| `maxToolRounds`    | Maximale Tool-Runden pro Chat-Anfrage (auch in der App einstellbar)         | 14        | 1 – 500          |
| `historyCharLimit` | Zeichen-Budget für den an den Provider gesendeten Chat-Verlauf (siehe unten)| 200 000   | 4 000 – 2 000 000 |

**Umstieg von „Weyouze Anything“ (bis v1.0.4):** Beim ersten Start kopiert Snotra AI Einstellungen, Presets, Ordner-Historie und Chat-Verlauf aus dem alten `userData`-Ordner; der alte Ordner bleibt unverändert als Backup liegen. Unter macOS müssen die API-Keys einmal neu eingegeben werden, weil der Keychain-Eintrag von Electrons `safeStorage` am App-Namen hängt; die Einstellungen zeigen dann „Key neu eingeben“. Ein dadurch nicht mehr entschlüsselbarer Chat-Verlauf wird als `chat-history.json.undecryptable-<Zeitstempel>` gesichert statt überschrieben.

**Verlaufs-Trimming (`historyCharLimit`):** Damit lange Sessions nicht ins Token-Limit des Providers laufen, wird der Verlauf pro Anfrage budgetiert (Heuristik: 1 Token ≈ 4 Zeichen). Ältere Nachrichten jenseits des Budgets werden weggelassen, und große Tool-Ausgaben früherer Tool-Runden (z. B. gelesene Dateien) werden auf einen Platzhalter gekürzt. Die aktuelle Frage, alle User-Nachrichten im Fenster und die Tool-Ausgaben der jüngsten Runde bleiben immer vollständig erhalten.

**Tool-Berechtigungen:** Ob ein Tool-Aufruf läuft, entscheidet Snotra pro Aufruf nach Risikoklasse (`read`, `read-sensitive`, `write`, `delete`, `execute`, `external`) und Modus. Den Modus wählst du in der **Chat-Leiste** (Pille neben der Modell-Auswahl) oder unter **Einstellungen › Tools › Berechtigungen** – beide zeigen denselben Stand. „Auto“ verlangt eine Bestätigung in einem Systemdialog, der Weg zurück zu „Intelligent“ geht jederzeit ohne Rückfrage. Modus, Sperr-/Erlaubnisregeln und eigene sensible Pfadmuster liegen in einer eigenen, HMAC-signierten Datei `tool-policy.json` im `userData`-Ordner (Schlüssel über `safeStorage` geschützt); wird die Datei manipuliert, fällt Snotra auf den Modus „Intelligent“ zurück und verwirft Erlaubnisse, Sperren bleiben wirksam. Der bis v1.3.1 genutzte Schalter `allowWorkspaceWrite` entfällt; beide Altwerte laufen auf den Standardmodus hinaus, die Einstellungen weisen einmalig darauf hin.

| Modus | Lesen | Sensible Daten lesen, Ändern, Überschreiben ohne Rückweg, Ausführen, externe Dienste |
| ----- | ----- | ----- |
| **Intelligent** (`smart`, Standard) | läuft | fragt im Chat nach Freigabe |
| **Immer fragen** (`ask-all`) | fragt | fragt |
| **Auto** (`auto`) | läuft | läuft ohne Rückfrage |

Harte Grenzen gelten in jedem Modus: kein Ausbruch aus dem Projektordner, Skill-Verzeichnisse bleiben schreibgeschützt, der `userData`-Ordner von Snotra ist für Tools gesperrt, und Ausgaben, die einen der eigenen Provider-Schlüssel enthalten, werden zurückgehalten. Sensible Pfade (`.env*`, `*.pem`, `*.key`, `id_*`, `credentials*`, `secrets*`, `*.p12`, `*.pfx`, `.netrc`, `.npmrc`, `.pypirc`, Ordner `.ssh`, `.aws`, `.gnupg`, `.kube`) und Inhalte (Private-Key-Header, bekannte Token-Präfixe, Credential-Zuweisungen, Bearer-Token) werden lokal erkannt: gezielte Zugriffe brauchen eine Freigabe, breite Suchen und Listen lassen solche Einträge weg und melden nur die Anzahl (`omitted_sensitive`). Das Konzept dazu steht in [`docs/sicherheitskonzept.md`](docs/sicherheitskonzept.md).

Die drei Schreib-Tools (max. 2 MB pro Datei):

| Tool | Wofür |
| ---- | ----- |
| `write_file_text` | Textdatei anlegen oder komplett überschreiben; fehlende Zwischenordner werden automatisch erzeugt. Beim Überschreiben landet vorher eine Kopie der alten Fassung im Papierkorb (Dateiname mit Zeitstempel); gelingt das nicht, gilt der Aufruf als `delete` und braucht eine eigene Freigabe |
| `edit_file` | Eine gezielte Ersetzung in einer bestehenden Datei (`old_string` → `new_string`), ohne die ganze Datei neu zu schreiben |
| `apply_patch` | Mehrere zusammenhängende Änderungen in einem Aufruf — als Liste von Ersetzungen in einer Datei oder als unified diff über mehrere Dateien. Alles oder nichts: schlägt ein Schritt bzw. ein Hunk fehl, bleibt jede betroffene Datei unverändert. Dateien anlegen, löschen oder umbenennen kann das Tool nicht |

Der Zugriff bleibt wie bei den Lese-Tools strikt auf den Projektordner beschränkt. Im Chat erscheint die Tool-Zeile (z. B. „Datei docs/neu.md wird geschrieben …“) bereits, während das Modell den Inhalt noch erzeugt — nicht erst nach dem eigentlichen Schreibvorgang.

**Freigabe-Karte:** Braucht ein Aufruf eine Freigabe, erscheint im Chat eine Karte („Änderung bestätigen“ bzw. „Dateizugriff bestätigen“) mit Tool, Wirkung, allen Zielpfaden, Grund und – bei Schreib-Tools – einer maskierten Vorschau des neuen Inhalts bzw. der Ersetzung; beim Überschreiben steht dabei, ob eine Kopie in den Papierkorb wandert. Bei sensiblen Dateien nennt die Karte den Provider, an den der Inhalt ginge. Drei Aktionen: **Einmal erlauben**, **Für diese Sitzung erlauben** (nur für Lesen, sensibles Lesen und gewöhnliches Ändern; genau dieses Tool auf genau diese Ziele, nicht im Modus „Immer fragen“) und **Ablehnen**; Esc lehnt ab, kein Button ist vorbelegt, es gibt kein Zeitlimit. Wechseln Chat, Workspace, Modus oder Regeln, während eine Karte offen ist, verfällt die Anfrage und der Lauf endet sichtbar („Anfrage verfallen“). Lehnst du ab, erhält das Modell ein `permission_denied`-Ergebnis; die Tool-Zeile zeigt die Entscheidung („· abgelehnt“, „· blockiert“) mit Grund, Klasse und Status als Tooltip – auch in gespeicherten Verläufen.

**Regelverwaltung (Einstellungen › Tools):** Sperren und Erlaubnisse je Tool oder Risikoklasse mit Pfadmuster (`*` innerhalb eines Ordners, `**` über Unterordner), getrennt für alle Workspaces und den geöffneten Workspace; Sperren gewinnen immer, dauerhafte Erlaubnisse gibt es nur für Lesen und gewöhnliches Ändern und sie werden – wie das Löschen einer Sperre – im Systemdialog bestätigt. Dazu eigene sensible Pfadmuster und drei Reset-Aktionen mit ausgewiesenem Umfang: Sitzungsfreigaben löschen, Workspace-Regeln zurücksetzen, alle Berechtigungen zurücksetzen (setzt auch den Modus auf „Intelligent“). Diese Einstellungen wirken sofort, unabhängig von „Übernehmen“.

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

### Dateien neben der `SKILL.md`

Viele Skills legen ihr eigentliches Wissen daneben ab (`references/`,
`assets/`, `scripts/`) und verweisen aus der `SKILL.md` darauf. Das
Verzeichnis jedes **eingeschalteten** Skills ist deshalb eine zweite
**Lesewurzel**: Die Lese-Tools erreichen es über das Präfix
`skill:<name>/<pfad>`, zum Beispiel `skill:meeting-protocol/references/vorlage.md`.
Der Systemprompt nennt die Adressierung und die eingeschalteten Namen, sobald
ein Ordner offen ist.

Die Grenzen bleiben eng gezogen:

- **Nur lesend.** `write_file_text`, `edit_file` und `apply_patch` bekommen die
  Skill-Verzeichnisse gar nicht erst zu sehen und weisen `skill:`-Pfade ab.
- **Nur eingeschaltete Skills.** Ein nicht ausgewählter Skill ist kein Pfad;
  die Fehlermeldung nennt die tatsächlich eingeschalteten Namen.
- **Kein Ausbruch.** `..` und Symlinks werden gegen den echten Pfad geprüft,
  genau wie beim Arbeitsordner.
- **Erkennbar im Chat.** Lesezugriffe auf Skill-Dateien bekommen im Tool-Log
  ein eigenes Symbol samt „(Skill ‹name›)“ im Text, damit sie nicht wie ein
  Zugriff auf das Projekt aussehen; in der zugeklappten Zusammenfassung
  stehen Skill-Zugriffe an erster Stelle.

Ohne geöffneten Ordner gibt es überhaupt keine Tools, also auch keine
Skill-Pfade.

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
├── docs/                Architektur (`architecture.md`, SVG-Diagramme), Release, Sicherheitskonzept
├── assets/icon/         SVG-Quellen des App-Icons (macOS- und Windows-Layout)
├── icon.icns / icon.ico App-Icons für macOS / Windows, erzeugt per `node scripts/build-icons.js`
└── package.json
```

Details zur Schichtenarchitektur: [`docs/architecture.md`](./docs/architecture.md).

## Sicherheitshinweise

- API-Keys werden **lokal** gespeichert und nicht an Dritte weitergegeben.
- Der Workspace-Zugriff der Tools ist auf den jeweils geöffneten Projektordner beschränkt. Einzige Ausnahme: die **Lese**-Tools erreichen zusätzlich die Verzeichnisse der eingeschalteten Skills über `skill:<name>/…` (siehe [Skills](#skills)); geschrieben wird dort nie.
- Jeder Tool-Aufruf durchläuft im Main-Prozess eine Policy (Risikoklasse × Modus, Sperr-Regeln, harte Grenzen); Dateiänderungen und der Zugriff auf sensible Dateien brauchen im Standardmodus eine Freigabe (siehe [Tool-Berechtigungen](#konfiguration)). Ein Tool-Text, eine Datei oder ein Skill kann keine Berechtigung erteilen.
- Trotzdem gilt: lass das Modell nichts in Ordnern arbeiten, in denen sensible Daten liegen, denen du nicht traust.

## Lizenz

Apache License 2.0 – siehe [`LICENSE`](./LICENSE).

Copyright © 2026 Konrad Krafft.
