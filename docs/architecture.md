# Architektur

Kurzüberblick zur Schichten- und Port/Adapter-Struktur von Snotra AI
nach Abschluss der fünf Roadmap-Etappen (Stand 2026-07-12). Diagramme:
[`architecture-layers.svg`](./architecture-layers.svg),
[`architecture-hexagonal.svg`](./architecture-hexagonal.svg),
[`architecture.svg`](./architecture.svg).

## Abhängigkeitsrichtung

Abhängigkeiten zeigen **immer nach innen** — vom äußeren Rand (UI, IPC,
Infrastruktur) zum transport-agnostischen Kern:

```
Renderer / Preload / IPC-Handler
        ↓
Main-Adapter & Composition (src/main/adapters/, composition/)
        ↓
Anwendungs-Core (src/application/)
        ↓
Shared Contracts & Runtime (src/shared/contracts/, runtime/)
```

Der Anwendungs-Core (`src/application/`) importiert nur Module unter
`src/application/` und `src/shared/`. Er kennt weder Electron noch
Provider-Implementierungen noch das Dateisystem.

## Schichten

| Schicht | Pfad | Rolle |
| ------- | ---- | ----- |
| **Contracts** | `src/shared/contracts/` | Versionierte DTOs, Events, Enums, Validatoren für die IPC-Grenze und Persistenz |
| **Presentation (shared)** | `src/shared/presentation/` | Domänennahe Anzeige-Helfer für Main-Adapter und Tests (z. B. Tool-Zeilen); nicht vom Core importiert |
| **Application** | `src/application/chat/`, `src/application/ports/` | Chat-Orchestrierung, Tool-Schleife, Verlaufstrim — nur über injizierte Ports |
| **Main adapters** | `src/main/adapters/` | Konkrete Port-Implementierungen (LLM, Tools, Storage, FS, Speech, Updates, …) |
| **Main ports** | `src/main/ports/` | Schnittstellen-Typen für Infrastruktur (schmale Oberflächen, keine Leaks) |
| **Composition root** | `src/main/composition/` | Verdrahtung: `createApplication()` baut Services, Adapter und Engine, registriert IPC |
| **IPC** | `src/main/ipc/` | Dünne treibende Adapter: IPC ↔ Use-Case-Aufrufe, Event-Push an den Renderer |
| **Renderer** | `src/renderer/` | Reine Präsentation: DOM, CSS, lokale Formatierung; nur `window.electronAPI` + Contracts |

Legacy-Re-Exports unter `src/main/chat-engine.js` und
`src/main/chat-history-trim.js` leiten auf `src/application/chat/` weiter, damit
bestehende Importe stabil bleiben.

## Ports

**Anwendungs-Ports** (`src/application/ports/`) — vom Chat-Core konsumiert:

- `llm-port` — Streaming-Runden gegen einen Provider
- `tool-port` — Tool-Registry und Ausführung
- `chat-preferences-port` — UI-Prefs, System-Prompt, Tool-Runden-Limit
- `workspace-path-port` — Pfad-Helfer (z. B. `basename`)
- `skill-port` — Bodies der eingeschalteten Skills für den Systemprompt
- `web-search-port` — Suche im Internet (Issue #63); Anbieter steckt allein im
  Adapter (`main/adapters/tavily-web-search-adapter.js`), der Tool-Handler
  kennt ihn nicht
- `url-fetch-port` — eine Webseite als Text lesen (Issue #95); Adressregeln,
  Weiterleitungen und Grenzen liegen im Adapter
  (`main/adapters/http-url-fetch-adapter.js`), die Adressprüfung selbst in
  `shared/runtime/url-safety.js`
- `code-execution-port` — ein Python-Programm ausführen (Issue #86);
  Interpreter-Erkennung, Zeitlimit und Prozessbaum-Kill liegen im
  `main/services/python-runner-service.js`. Den PATH, mit dem gesucht und
  ausgeführt wird, bringt der Dienst nicht selbst auf: er kommt als
  `readShellPath` von außen herein (Issue #111)
- `shell-execution-port` — einen Befehl in der Shell des Betriebssystems
  ausführen (Issue #102); Shell-Erkennung (POSIX als Login-Shell, damit der
  PATH aus dem Nutzerprofil gilt), Zeitlimit und Prozessbaum-Kill liegen im
  `main/services/shell-runner-service.js`, die gesperrten Wirkungen als reine
  Prüfung in `shared/runtime/shell-command-guard.js`

Der Shell-Dienst ist zugleich die einzige Stelle, die eine Login-Shell startet
(Issue #111). Seine Erkennung läuft auf POSIX interaktiv (`-ilc`), weil zsh
`.zshrc` nur für interaktive Shells liest und die meisten PATH-Zeilen genau
dort stehen; sie liest den PATH mit und merkt sich das Ergebnis für die
Lebensdauer der App. Beide Ausführungs-Dienste geben diesen PATH an ihre
Kindprozesse weiter — eine aus dem Finder gestartete Electron-App erbt sonst
nur den kargen PATH des Fensterservers. Befehle laufen weiterhin
nicht-interaktiv, damit Prompt-Ausgabe nicht im Ergebnis landet. Unter Windows
entfällt der Profil-Lauf: der PATH kommt dort aus Registry und
Benutzerumgebung. Die Komposition verdrahtet das in
`main/composition/create-application.js` — der Shell-Dienst wird vor dem
Python-Dienst gebaut, weil dieser seinen PATH von dort bezieht.

Beide Ausführungs-Ports sind bewusst gleich eng geschnitten — ein Programm
bzw. ein Befehl rein, Ausgabe und Exit-Code raus, kein Zustand zwischen zwei
Aufrufen — und tragen in der Registry die Klasse `execute`: keine
Workspace-Grenze, keine Sandbox, dafür eine Freigabe vor jedem Lauf und im
Lieferzustand abgeschaltet (siehe `docs/sicherheitskonzept.md`, Abschnitt 9).

Beide Netz-Tools sind in der Registry als `requiresWorkspace: false`
gekennzeichnet (Issue #96): die Engine baut die Tool-Liste nicht mehr pauschal
nur mit geöffnetem Projektordner, sondern filtert je Tool.

**Infrastruktur-Ports** (`src/main/ports/`) — von Adaptern implementiert,
über Composition injiziert:

- Storage: `llm-config-store-port`, `ui-prefs-store-port`,
  `chat-history-store-port`, `workspace-folder-store-port`,
  `provider-secrets-port`, `web-search-store-port`
- Laufzeit: `provider-runtime-port`, `provider-catalog-port`,
  `provider-model-listing-port`, `credential-port`, `filesystem-port`,
  `speech-port`, `update-port`

Der **Skill-Service** (`services/skills-service.js`) scannt die drei
Skill-Quellen — die eingebauten System-Skills aus `system-skills/` im
App-Bundle sowie `.agents/skills/` in Workspace und Home; Verzeichnisse
anderer Werkzeuge wie `.claude/` bleiben ungelesen — und wird über
`adapters/skills-adapter.js` als schmaler `skill-port`
in die Chat-Engine gereicht. Das Parsen des Frontmatters liegt als reine
Funktion in `shared/runtime/skill-frontmatter.js`, die Enums und DTOs in
`shared/contracts/skills.js`.

## Workspace-Verwaltung im Main-Prozess

Der **aktive Workspace** ist die Vertrauensgrenze des Dateisystems: alle
Datei-Tools und die IPC-Dateizugriffe lösen relative Pfade gegen ihn auf. Er
liegt deshalb ausschließlich im Main-Prozess (`main/workspace-state.js`) und
wird nur von `services/workspace-activation.js` gesetzt (Issue
[#68](https://github.com/kkrafft1999/snotra/issues/68)):

- `activateChosenFolder` — nach einer echten Auswahl im nativen Ordnerdialog.
  Nur dieser Weg nimmt einen bisher unbekannten Pfad an; er prüft, dass es ein
  existierender Ordner ist, schreibt `last-folder.json` und den Verlauf und
  aktiviert ihn. Der Dialog-Handler (`ipc/dialog-handlers.js`) liefert dem
  Renderer erst danach den aktivierten Pfad zurück.
- `activateKnownFolder` — für Verlaufsmenü, Welcome-Chips und die
  Wiederherstellung beim Start (`SETTINGS_ACTIVATE_FOLDER`). Der übergebene
  Pfad muss im erneut validierten Verlauf oder als zuletzt geöffneter Ordner
  gespeichert sein, sonst bleibt der bisherige Root stehen.

### Import von außen: die eine bewusst asymmetrische Prüfung

Der Drop aus Finder/Explorer in den Dateibaum (Issue
[#101](https://github.com/kkrafft1999/snotra/issues/101)) ist der erste Weg, auf
dem ein Pfad von **außerhalb** des Workspace Wirkung hat. Er bekommt deshalb
eigene Kanäle statt einer Erweiterung von `fs:moveItem` — dort prüft
`adapters/filesystem-ipc-adapter.js` Quelle *und* Ziel über `boundPath()`, und
das soll so bleiben:

- `fs:inspectImport` — zählt Ordner, Dateien und Bytes, ohne zu schreiben.
- `fs:importItems` — bestätigt nativ und kopiert.

Im Adapter läuft nur das **Ziel** über `boundPath()` (realpath-geprüft). Die
**Quelle** wird absichtlich nicht gegen den Workspace geprüft — genau dafür gibt
es den Kanal —, muss aber absolut sein und darf nicht auf
`shared/runtime/sensitive-paths.js` passen; ein Treffer lehnt den Drop ab. Der
Rest liegt in `services/fs-service.js`: `inspectImportSources` zählt rekursiv
(Symlinks und sensible Namen werden gezählt und übersprungen, nicht verfolgt),
`importExternalItems` kopiert mit `fs.cp` — kopiert, nicht verschoben, denn
`fs.rename` arbeitet nur innerhalb eines Dateisystems, und die Quelle draußen zu
löschen wäre nicht rückholbar. Das Kollisionsschema `name (2).ext` teilen sich
beide Wege über `findFreeTargetPath`. Die Grenzen (`MAX_IMPORT_ENTRIES`,
`MAX_IMPORT_TOTAL_BYTES`) stehen in `shared/limits.js`; eine Überschreitung
lehnt den ganzen Drop ab, statt halb zu kopieren. Bestätigt wird in
`ipc/fs-handlers.js` nativ über `dialog.showMessageBox` — der Renderer stößt nur
an, siehe `docs/sicherheitskonzept.md` §5.

Damit kann der Renderer die Grenze nicht verschieben: Er benennt den Workspace
in keinem Aufruf mehr. `CHAT_SEND`, Skill-Katalog und Chat-Verlauf bekommen den
Root über `getActiveWorkspaceRoot()` im jeweiligen Handler injiziert; ein im
Payload mitgeschickter Pfad wird verworfen. Beim Start setzt auch
`main/index.js` nichts vorab — der Root entsteht erst mit der Aktivierung durch
den Renderer, sodass Oberfläche und Vertrauensgrenze denselben Ordner meinen.

Eine einzige, eng gefasste Ausnahme hat der Chat-Verlauf (Issue #131): Eine
Konversation gehört zu dem Ordner, in dem sie geführt wurde, der Renderer sichert
sie beim Ordnerwechsel aber erst, wenn im Main schon der neue Root aktiv ist.
Deshalb darf eine Session in `CHAT_HISTORY_UPSERT` ihren eigenen Root nennen —
angenommen wird er nur, wenn `workspaceActivation.isKnownFolder()` ihn als
bereits geöffneten Ordner bestätigt, sonst gilt wieder der aktive Root. Der
Pfad landet damit ausschließlich als Schlüssel im Verlaufs-Bucket und öffnet
keinen Dateizugriff; die Vertrauensgrenze bleibt `getActiveWorkspaceRoot()`.
Welchen Bucket `CHAT_HISTORY_SET_ACTIVE` trifft, entscheidet aus demselben Grund
die Session selbst, nicht der gerade aktive Ordner.

## Composition root

`src/main/composition/create-application.js` ist der zentrale Einstieg nach dem
Electron-Bootstrap:

1. Erzeugt Infrastruktur-Services (`storage-service`, `fs-service`, …)
2. Wickelt sie in schmale Port-Adapter (`persistence-store-adapters`, …)
3. Baut die Chat-Anwendung via `create-chat-application.js` (LLM-, Tool-,
   Preferences-Adapter → `createChatEngine`)
4. Registriert IPC-Handler mit injizierten Abhängigkeiten

`src/main/index.js` ruft vor `createApplication()` nur die einmalige
userData-Migration auf (`services/userdata-migration.js`, Übernahme aus dem
Ordner der Vorgänger-Identität „Weyouze Anything“) — keine verstreute
Verdrahtung in den Handlern.

## Renderer: was verschoben wurde, was bleibt

**Aus dem Renderer entfernt** (jetzt Main oder `shared/`):

- Provider-/Preset-Formularsemantik → `settings-presentation-service` +
  `shared/contracts/settings.js`
- Tool-Anzeigezeilen → `shared/presentation/tool-display.js` (über Tool-Port-Adapter)
- Verlaufs-Normalisierung (Titel, Sanitisierung, Usage) →
  `chat-history-normalization.js`

**Legitim im Renderer** (Präsentation, kein Domänenwissen):

- Markdown-Rendering und HTML-Sanitisierung (`marked`, `DOMPurify`)
- DOM-Aufbau für Chat, Tool-Zeilen, Modals
- Lokale Zeit-/Datumsformatierung (`messageUtils.formatHistoryTime`)
- Anzeige vorgefertigter DTO-Felder (`entry.line`, `providers[].presetFields`)

Der Renderer **darf** Provider-IDs und Preset-Felder aus IPC-DTOs *anzeigen*,
solange er keine Provider-Wire-Formate parst und keine Tool-/Provider-Logik
dupliziert.

## Automatisierte Grenzwächter

| Test | Was er prüft |
| ---- | ------------ |
| `test/application-layer-imports.test.js` | `src/application/` importiert nur `application/` + `shared/` |
| `test/infrastructure-boundaries.test.js` | Storage/Credentials ohne Provider-Registry-Leaks |
| `test/adapter-port-shapes.test.js` | Port-Adapter exponieren nur erlaubte Methoden |
| `test/contracts*.test.js` | Wire-Enums und Settings-DTOs an der IPC-Grenze |
| `test/*-presentation.test.js`, `test/chat-history-normalization.test.js` | Normalisierte Anzeige-Daten für Settings, Verlauf |

## Renderer-Tests am DOM

Renderer-Komponenten werden seit [#78](https://github.com/kkrafft1999/snotra/issues/78)
gegen ein echtes DOM getestet — `happy-dom` als einzige Testabhängigkeit,
`node --test` bleibt der Runner, die CI braucht nichts weiter. `test/helpers/dom.js`
baut ein Fenster aus der **echten** `src/renderer/index.html` (ohne deren
Skript-Tags) und legt die Browser-Globals auf `globalThis`; die Komponenten
werden als natives ESM per `await import(...)` geladen und mit gestubbtem
`api`/`appStore` initialisiert.

| Test | Was er prüft |
| ---- | ------------ |
| `test/file-tree-dom.test.js` | Baum zeichnen, Auf-/Zuklappen, Vorschau, Drop von außen ([#101](https://github.com/kkrafft1999/snotra/issues/101)): Zielordner je Trefferfläche, Lesen des `DataTransfer` vor dem ersten `await`, Busy-Sperre, Baum-Refresh |
| `test/settings-modal-dom.test.js` | Tab-Umschaltung: Panel, `aria-selected`, Roving Tabindex, Überschrift, Escape |
| `test/chat-links-dom.test.js` | Klick-Handler für Links aus Modellantworten ([#82](https://github.com/kkrafft1999/snotra/issues/82), [#83](https://github.com/kkrafft1999/snotra/issues/83)) inkl. Fehlermeldung in der Statuszeile |

Grenzen, damit die grüne Zeile nicht mehr verspricht, als sie hält: kein echtes
Chromium, also **kein Layout** (`offsetParent`, `getBoundingClientRect`) und
**kein Sanitizing** — DOMPurify arbeitet unter happy-dom nachweislich falsch
(Details im Kopf von `test/helpers/dom.js`). `DataTransfer`/`DragEvent` baut der
Helfer selbst nach. Ein echter Finder-/Explorer-Drop bleibt manuell.

## Smoke-Test in der echten App

Was eine DOM-Nachbildung nicht leisten kann, prüft ein Durchlauf durch die
laufende Electron-App: `npm run test:e2e` (nicht Teil von `npm test`). Bewusst
**ein** Test — die Electron-Ebene ist die teuerste pro gefundenem Fehler, und
ein Lauf, der beim Start alles einmal anfasst, holt den Großteil davon. Er
dauert rund drei Sekunden.

- **Treiber:** `playwright-core` (`_electron.launch`) als devDependency. Kein
  Browser-Download, kein zweiter Test-Runner: `node --test` bleibt.
- **Isolation:** eigenes `--user-data-dir`, ein per `mkdtemp` angelegter
  Arbeitsordner. Die Einstellungen der installierten App bleiben unberührt.
- **Modell:** `e2e/helpers/fake-model.mjs`, ein kleiner OpenAI-kompatibler
  SSE-Server. Der Provider `mlx-lm` zeigt per `baseUrl` dorthin — kein API-Key,
  kein Netz, und der Stream lässt sich verlangsamen, um ihn abzubrechen.
- **Strecke:** Start mit vorgemerktem Ordner → Baum → Datei öffnen und Vorschau
  → Chat-Runde abbrechen (der Abbruch muss bis zum Server durchschlagen) →
  zweite Runde mit Links und gefährlichem Markup → **Sanitizing in echtem
  Chromium** → Klick auf den Link landet im Main-Prozess → Einstellungen öffnen,
  Tab wechseln, mit Escape schließen.
- `shell.openExternal` wird im Main-Prozess ersetzt, damit der Test keinen
  echten Browser aufmacht.

Fallstricke des Treibers stehen im Kopf von `e2e/helpers/app.mjs` — vor allem:
Playwrights eigenes Warten hängt hier (Timer-Drosselung im Renderer), deshalb
pollt der Treiber selbst.

Nicht in der CI: Electron braucht dort eine Anzeige (unter Linux `xvfb`), und
der Nutzen steht bisher nicht gegen die Laufzeit auf drei Betriebssystemen.
Der Test läuft lokal und vor Releases.

## Weitere funktionale Module

Das Skill-System ([#18](https://github.com/kkrafft1999/snotra/issues/18)) ist
auf dieser Struktur aufgesetzt: Discovery und Parsing im Main-Service, Auswahl
und Systemprompt-Zusammenbau im Core, Katalog und Umschalter über die
bestehenden Settings-Kanäle. Erweiterte Tool-Sets und Use-Case-Profile sind
**nicht** Teil der abgeschlossenen Architektur-Etappen — sie bauen ebenfalls
darauf auf und werden als
[GitHub Issues](https://github.com/kkrafft1999/snotra/issues) geführt.
