# Umfassendes Code-Review – Snotra AI

**Datum:** 4. September 2026

**Aktualisierte Review-Basis:** `main` bei `f7c3323` (`Merge branch 'fix/64-open-external'`)

**Ursprünglicher Review-Snapshot:** `a857f51` (`Merge branch 'feat/61-skill-read-roots'`)

**Projektversion:** `1.2.0`

**Technik:** Electron 41, Node.js 24, Vanilla JavaScript

**Review-Typ:** Statische Analyse, Architektur-, Sicherheits-, Qualitäts-, Test-, UX-/Accessibility- und Release-Review

## Kurzfazit

Snotra AI hat eine überdurchschnittlich saubere technische Basis: Die Electron-Härtung ist weitgehend sinnvoll, die Anwendungslogik ist klar von Electron und den Providern getrennt, Dateizugriffe schützen gegen Traversal und Symlink-Ausbrüche, sensible Provider-Schlüssel werden über `safeStorage` behandelt und 479 automatisierte Tests laufen vollständig grün.

Für eine Release-Freigabe sollten dennoch drei Punkte zuerst behoben werden:

1. Der Renderer kann den angeblich vom Main-Prozess geschützten Workspace-Root selbst festlegen und dadurch die Dateisystemgrenze verschieben.
2. `search_in_files` führt modellgelieferte reguläre Ausdrücke synchron im Electron-Main-Prozess aus und ist damit für Regular-Expression-Denial-of-Service anfällig.
3. Die Release-Pipeline baut und veröffentlicht Artefakte, ohne die vorhandenen Tests auszuführen; eine fortlaufende Pull-Request-/Push-Pipeline fehlt vollständig.

Es wurden **keine kritischen**, **3 hohe**, **8 mittlere** und **5 niedrige** Findings identifiziert. „Keine kritischen Findings“ bedeutet nicht, dass kein Risiko besteht: Die beiden hohen Sicherheitsfindings können bei kompromittiertem Renderer beziehungsweise bösartigem Workspace-Inhalt außerhalb der erwarteten Grenzen wirken.

## Nachtrag: parallel entstandene Quellcodeänderungen

Während der ursprünglichen Analyse entstand parallel der Commit `9177dac` (`fix(shell): Links über den Main-Prozess öffnen statt im sandboxed Preload`), anschließend integriert durch `f7c3323`. Der Nachtrag umfasst den vollständigen Source- und Test-Diff von `a857f51` bis `f7c3323`, ausgenommen die Review-Datei selbst.

**Umfang:** 7 Dateien, 222 Ergänzungen, 15 Löschungen

- `src/main/ipc/shell-handlers.js` wurde neu angelegt.
- `src/main/composition/create-application.js` und `src/main/index.js` verdrahten `shell` und `clipboard` im Main-Prozess.
- `src/preload/index.js` importiert nur noch `contextBridge` und `ipcRenderer` und delegiert Shell-/Clipboard-Aufrufe per IPC.
- `src/shared/ipc-channels.js` definiert die beiden neuen Kanäle zentral.
- `src/renderer/components/UpdateBanner.js` wartet auf das Ergebnis des externen Linkaufrufs und zeigt Fehler an.
- `test/shell-handlers.test.js` ergänzt sieben Tests für Protokollfilter, Fehlerpfade, Clipboard, Sandbox-Imports und Preload-Bundle.

**Bewertung:** Die Änderung ist fachlich richtig und verbessert sowohl Funktion als auch Sicherheitsarchitektur. `shell` und `clipboard` sind im sandboxed Preload nicht verfügbar; die Verlagerung in den Main-Prozess behebt daher einen realen Funktionsfehler. Die Main-seitige Positivliste für ausschließlich HTTP und HTTPS ist sinnvoll, und Fehler werden strukturiert zurückgegeben. Die 479 Tests einschließlich der sieben neuen Fälle laufen vollständig grün.

Die Änderung behebt keines der ursprünglichen P1-/P2-Findings, verschärft sie aber auch nicht. Zwei niedrige Restpunkte bleiben: `mailto:` ist weiterhin inkonsistent behandelt (SNO-15), und Chat-Links ignorieren die neu verfügbaren Fehlerresultate, während gleichzeitig eine aktuell ungenutzte Clipboard-Fähigkeit exponiert wird (SNO-16).

## Priorisierte Übersicht

| ID | Priorität | Bereich | Finding |
|---|---|---|---|
| SNO-01 | Hoch / P1 | Security, IPC | Renderer kann den Workspace-Root und damit die Dateisystem-Vertrauensgrenze bestimmen |
| SNO-02 | Hoch / P1 | Security, Verfügbarkeit | Modellgelieferte Regex kann den Main-Prozess blockieren |
| SNO-03 | Hoch / P1 | CI/CD, Qualität | Releases sind nicht durch Tests abgesichert; PR-/Push-CI fehlt |
| SNO-04 | Mittel / P2 | Supply Chain | Build-Jobs besitzen Schreibrechte und Actions sind nur über veränderliche Tags referenziert |
| SNO-05 | Mittel / P2 | Packaging, Datenschutz | Pakete enthalten lokale, ignorierte Entwicklungsdateien und unnötige Projektinhalte |
| SNO-06 | Mittel / P2 | Windows, Korrektheit | Renderer zerlegt native Pfade ausschließlich an `/` |
| SNO-07 | Mittel / P2 | Accessibility | Zentrale Bedienelemente sind nicht vollständig per Tastatur erreichbar |
| SNO-08 | Mittel / P2 | Datenintegrität | Workspace-Schreibtools überschreiben Dateien nicht atomar |
| SNO-09 | Mittel / P2 | Ressourcen | Audio- und Verzeichnisoperationen haben keine ausreichenden Größenlimits |
| SNO-10 | Mittel / P2 | Netzwerk, UX | Modelllisten und Transkription besitzen keinen Request-Timeout |
| SNO-11 | Mittel / P2 | Tests | Hohe Coverage verdeckt eine weitgehend ungetestete Renderer-Oberfläche |
| SNO-12 | Niedrig / P3 | Electron Hardening | Navigation erlaubt jede lokale `file://`-Adresse statt nur die App-URL |
| SNO-13 | Niedrig / P3 | Konsistenz | Das Speichern der Einstellungen ist über zwei Dateien nicht atomar |
| SNO-14 | Niedrig / P3 | Wartbarkeit | Mehrere zentrale Module sind sehr groß; der Testlauf erzeugt eine Modulformat-Warnung |
| SNO-15 | Niedrig / P3 | UX | `mailto:` wird als sicherer Link erzeugt, aber nicht geöffnet |
| SNO-16 | Niedrig / P3 | IPC, UX | Chat-Linkfehler bleiben unsichtbar; ungenutzte Clipboard-Fähigkeit bleibt exponiert |

## Detaillierte Findings

### SNO-01 – Renderer kann die Workspace-Vertrauensgrenze bestimmen

**Priorität:** Hoch / P1

**Betroffene Stellen:**

- `src/preload/index.js:28-29,36-49`
- `src/main/ipc/settings-handlers.js:185-195`
- `src/main/workspace-state.js:3-11`
- `src/main/adapters/filesystem-ipc-adapter.js:3-7`
- `src/application/chat/chat-engine.js:251-258,320-321,421-429`
- `src/main/adapters/workspace-path-adapter.js:3-8`

Der Renderer darf über `setLastFolder(folderPath)` einen beliebigen Pfad an den Main-Prozess senden. `persistLastFolder` prüft zwar, ob der Pfad ein existierender Ordner ist, gibt bei ungültigen Werten jedoch nur still zurück. Unabhängig vom Ergebnis wird danach `setActiveWorkspaceRoot(folderPath)` aufgerufen. Selbst bei erfolgreicher Existenzprüfung bleibt das Grundproblem bestehen: Jeder beliebige existierende Ordner – beispielsweise das Benutzerverzeichnis oder der Dateisystem-Root – kann als aktive Grenze gesetzt werden.

Die GUI-Dateioperationen verwenden anschließend genau diesen veränderbaren Wert als Vertrauensanker. Der Chat-Pfad ist noch direkter: `workspaceRoot` wird vom Renderer in jedem `CHAT_SEND` mitgeliefert, nur mit `path.resolve` normalisiert und dann an die Lese- und bei aktivierter Schreiboption auch an die Schreibtools weitergereicht.

Damit ist die Main-Prozess-Grenze keine echte Sicherheitsgrenze. Eine XSS-Lücke, manipulierte lokale Renderer-Datei oder ein anderer Renderer-Kompromiss könnte das Preload-API nutzen, um außerhalb des vom Benutzer geöffneten Ordners zu lesen, zu verschieben, in den Papierkorb zu legen oder – sofern Workspace-Schreiben aktiviert ist – zu schreiben.

**Empfehlung:**

- Den aktiven Workspace ausschließlich im Main-Prozess verwalten.
- Die Auswahl und Aktivierung in einem einzigen Main-Prozess-Vorgang koppeln: Der native Ordnerdialog setzt den zurückgegebenen, validierten Root direkt.
- Für Einträge aus der Historie einen separaten Main-Handler anbieten, der nur bereits gespeicherte und erneut validierte Ordner akzeptiert.
- `CHAT_SEND`, Skill-Katalog und Chat-History sollten keinen `workspaceRoot` aus dem Renderer übernehmen, sondern den Main-eigenen aktiven Root injizieren.
- Regressionstests ergänzen, die manipulierte IPC-Payloads mit `/`, Benutzerverzeichnis, Prefix-Sibling und nicht ausgewähltem Ordner ablehnen.

### SNO-02 – Modellgelieferte Regex kann den Main-Prozess blockieren

**Priorität:** Hoch / P1

**Betroffene Stellen:** `src/main/services/fs-service.js:1393-1405,1442-1472`

`search_in_files` erzeugt bei `is_regex=true` direkt ein natives JavaScript-`RegExp` aus `args.query`. Der Ausdruck wird synchron auf jede vollständige Textzeile angewendet. Pro Datei sind bis zu 2 MB Inhalt und pro Suche bis zu 5.000 besuchte Dateien möglich.

Ausdrücke mit katastrophalem Backtracking, etwa verschachtelte Quantifizierer, können auf passend langen Zeilen den Electron-Main-Thread für sehr lange Zeit blockieren. Da die Tool-Argumente vom Modell stammen, kann auch prompt-injizierter Workspace-Inhalt einen solchen Aufruf begünstigen. Währenddessen reagiert die gesamte Anwendung nicht mehr; ein normaler Abort kann synchron laufendes Regex-Matching nicht unterbrechen.

**Empfehlung:**

- Eine Engine mit garantiert linearer Laufzeit verwenden, beispielsweise RE2.
- Zusätzlich Länge und Komplexität des Ausdrucks sowie die maximale geprüfte Zeilenlänge begrenzen.
- Alternativ Regex-Suchen in einen Worker mit hartem Zeitbudget und Abbruchmöglichkeit auslagern.
- Einen sicheren Regressionstest ergänzen, der problematische Muster vor der Ausführung zurückweist, statt einen tatsächlich hängenden Ausdruck auszuführen.

### SNO-03 – Releases sind nicht durch Tests abgesichert

**Priorität:** Hoch / P1

**Betroffene Stellen:** `.github/workflows/release.yml:10-106`, `package.json:6-14`

Es existiert nur ein taggetriggerter Release-Workflow. Beide Build-Jobs führen `npm ci` und anschließend Packaging aus, aber nicht `npm test`. Einen Workflow für Pull Requests oder normale Pushes gibt es nicht. Damit können fehlschlagende Tests oder Architekturregeln unbemerkt bis zum Release-Tag gelangen und trotzdem veröffentlichte Binärdateien erzeugen.

Das ist besonders schade, weil die vorhandenen 479 Tests schnell laufen und bereits wertvolle Architektur-, IPC-, Provider-, Storage- und Dateisystemregeln absichern.

**Empfehlung:**

- Einen verpflichtenden Testjob für `pull_request` und Pushes auf `main` einführen.
- Den Release-Workflow von einem erfolgreichen Testjob abhängig machen.
- Mindestens Node.js 24 verwenden; plattformspezifische Pfad- und Packaging-Tests auf Windows und macOS ausführen.
- Optional Linting, Formatprüfung und Coverage-Schwellen als getrennte, schnelle Checks ergänzen.

### SNO-04 – Build-Jobs besitzen unnötige Schreibrechte

**Priorität:** Mittel / P2

**Betroffene Stellen:** `.github/workflows/release.yml:15-28,62-76,87-104`

`permissions: contents: write` gilt global und damit auch für macOS- und Windows-Build-Jobs. Gleichzeitig führt `npm ci` Installationscode aus. `actions/checkout` behält standardmäßig das Zugriffstoken in der lokalen Git-Konfiguration, sofern `persist-credentials` nicht deaktiviert wird. Ein kompromittiertes Dependency-Skript hätte dadurch in den Build-Jobs mehr Rechte als für das Erzeugen eines Artefakts nötig.

Außerdem werden Actions über Major-Tags wie `@v7`, `@v8` und `@v3` referenziert. Diese Tags können auf andere Commits verschoben werden. GitHub bezeichnet nur die vollständige Commit-SHA als unveränderliche Referenz.

**Empfehlung:**

- Workflow-Default auf `contents: read` setzen.
- `contents: write` ausschließlich dem finalen `release`-Job geben.
- Bei Checkout `persist-credentials: false` setzen, sofern kein nachfolgender Git-Schreibzugriff benötigt wird.
- Drittanbieter-Actions auf vollständige Commit-SHAs pinnen und Renovate/Dependabot für kontrollierte Updates nutzen.

Referenzen: [GitHub – Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use), [GitHub – Use `GITHUB_TOKEN` for authentication](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token), [actions/checkout – Persist credentials](https://github.com/actions/checkout/blob/main/README.md).

### SNO-05 – Paket enthält lokale Entwicklungsdateien

**Priorität:** Mittel / P2

**Betroffene Stellen:** `package.json:16-31`, lokales Artefakt `out/Snotra AI-darwin-arm64/Snotra AI.app/Contents/Resources/app.asar`

Die Packager-Konfiguration schließt nur `.venv` aus. Das vorhandene App-Artefakt enthält dadurch unter anderem:

- `.claude/settings.local.json`
- `.claude/rules/` und `.claude/skills/`
- `.github/`
- den gesamten Ordner `docs/`
- `scripts/`
- den gesamten Ordner `test/`

Besonders problematisch ist `.claude/settings.local.json`: Die Datei ist bewusst von Git ignoriert, wird vom Electron-Packager aber trotzdem aufgenommen. Im geprüften Artefakt stehen darin absolute lokale Entwicklerpfade und Tool-Berechtigungen. Aktuell wurden darin keine Zugangsdaten gefunden; das Packaging-Verhalten kann künftig jedoch auch andere lokale, ignorierte Dateien veröffentlichen. Tests, Dokumentation und Buildskripte vergrößern außerdem unnötig die ausgelieferte Angriffs- und Analyseoberfläche.
**Empfehlung:**

- Bevorzugt eine explizite Packaging-Allowlist für Laufzeitdateien verwenden (`src`, benötigte Assets, `system-skills`, `package.json` und Production-Dependencies).
- Mindestens `.claude`, `.github`, `docs`, `test`, nicht benötigte `scripts`, lokale Umgebungsdateien und Entwicklungsartefakte ausschließen.
- In CI nach dem Packaging die ASAR-Inhaltsliste gegen eine Allowlist prüfen.
- Bereits veröffentlichte Artefakte auf dieselben lokalen Metadaten prüfen.

### SNO-06 – Native Windows-Pfade werden im Renderer falsch zerlegt

**Priorität:** Mittel / P2

**Betroffene Stellen:**

- `src/renderer/components/FileTree.js:13-21,97-103,149-160,187-205`
- `src/renderer/components/FileTree.js:567-601`
- `src/main/services/fs-service.js:1796-1824`

Der Main-Prozess liefert native absolute Pfade über `path.join`; auf Windows enthalten diese Backslashes. Der Renderer verwendet dagegen mehrfach `split('/')`, `join('/')` und String-Konkatenation mit `/`.

Bei einem Pfad wie `C:\\repo\\src\\app.js` liefert die Basename-Logik den vollständigen Pfad statt `app.js`. Kritischer sind Refresh und Drag-and-drop: `parentDirFromItemPath` beziehungsweise `refreshParentOf` ermitteln auf Windows nicht den tatsächlichen Elternordner. Nach Verschieben oder KI-Schreibvorgängen kann der Dateibaum deshalb veraltet bleiben oder den falschen Ordner aktualisieren.

**Empfehlung:**

- Pfadlogik zentralisieren und beide Separatoren behandeln oder – robuster – im Main-Prozess normalisierte relative Pfade, `basename` und `parentPath` als DTO liefern.
- Im Renderer keine absoluten Dateisystempfade durch Stringverkettung konstruieren.
- Unit-Tests mit POSIX- und Windows-Fixtures für Projektname, Elternpfad, Move-Refresh und externe Schreibereignisse ergänzen.

### SNO-07 – Zentrale Bedienelemente sind nicht vollständig tastaturfähig

**Priorität:** Mittel / P2

**Betroffene Stellen:**

- `src/renderer/components/FileTree.js:363-438`
- `src/renderer/components/SidebarResizer.js:24-33,67-108`
- `src/renderer/components/SettingsModal.js:602-613,653-676,960-965`

Dateibaumzeilen sind klick- und dragfähige `div`-Elemente, besitzen aber weder `tabIndex`, Baumrollen noch Keyboard-Handler. Dateien und Ordner lassen sich dadurch nicht zuverlässig per Tastatur öffnen, auf- und zuklappen oder über das Kontextmenü bedienen.

Die beiden Panel-Trenner reagieren ausschließlich auf Mausereignisse. Ihnen fehlen `role="separator"`, Fokusfähigkeit, Wertattribute und Pfeiltastensteuerung.

Die Settings-Navigation implementiert ein Roving-Tabindex-Muster, setzt inaktive Tabs also auf `tabIndex=-1`, behandelt aber keine Pfeil-, Home- oder End-Tasten. Nach Fokus auf dem aktiven Tab kann ein Tastaturnutzer deshalb nicht zu den anderen Tabs wechseln.

**Empfehlung:**

- Dateibaum als zugänglichen Tree oder Treegrid mit Fokusführung, `aria-expanded` und den üblichen Pfeiltastenmustern implementieren.
- Resizer als fokussierbare Separatoren mit Pfeiltasten, Min/Max/Now-Werten und sichtbarem Fokus ausstatten.
- Tabs entsprechend dem WAI-ARIA-Tabs-Pattern mit Links/Rechts/Home/End ergänzen.
- Automatisierte DOM-/Accessibility-Tests und einen manuellen Tastaturdurchlauf in die Release-Checkliste aufnehmen.

### SNO-08 – Workspace-Schreibtools überschreiben nicht atomar

**Priorität:** Mittel / P2

**Betroffene Stellen:** `src/main/services/fs-service.js:1066-1078,1106-1145,1177-1196,1210-1219,1305-1319`; positive Referenz: `src/main/services/storage-service.js:45-55`

`write_file_text`, `edit_file` und beide `apply_patch`-Modi schreiben direkt in die Zieldatei. Ein Prozessabbruch, voller Datenträger oder I/O-Fehler während des Schreibens kann eine bestehende Datei teilweise überschreiben oder leeren.

Der Multi-Datei-Patch versucht bei abgefangenen Fehlern, bereits geschriebene Dateien zurückzusetzen. Diese Rücknahme nutzt jedoch ebenfalls direkte Writes, kann selbst scheitern und hilft nicht bei einem Prozessabsturz zwischen zwei Dateien. Der Storage-Service zeigt bereits ein besseres lokales Muster mit temporärer Datei und Rename.

**Empfehlung:**

- Für einzelne Dateien in demselben Verzeichnis temporär schreiben, optional `fsync` ausführen und anschließend atomar umbenennen.
- Bestehende Dateirechte beim Ersetzen erhalten.
- Für Multi-Datei-Patches klar dokumentieren, dass echte Transaktionsatomarität über mehrere Dateien nicht garantiert werden kann; zumindest jede einzelne Datei atomar ersetzen.
- Fehlerpfade für Temp-Write, Rename, Berechtigungen und vollen Datenträger testen.

### SNO-09 – Audio- und Verzeichnisoperationen sind unzureichend begrenzt

**Priorität:** Mittel / P2

**Betroffene Stellen:**

- `src/renderer/voice/WhisperRecorder.js:41-87`
- `src/main/services/whisper-service.js:13-49`
- `src/main/services/fs-service.js:936-957,1796-1824`

Eine Sprachaufnahme kann unbegrenzt laufen. Alle Chunks bleiben im Renderer-Speicher, werden zu einem Blob und ArrayBuffer zusammengeführt, über IPC kopiert, im Main-Prozess erneut in einen `Buffer` kopiert und schließlich in einen weiteren Multipart-Buffer zusammengeführt. Es gibt weder maximale Dauer noch maximales Datenvolumen und keine zweite Größenprüfung an der Main-Prozess-Grenze. Sehr lange Aufnahmen können hohen Speicherverbrauch und unnötige API-Kosten verursachen.

`list_directory` und die GUI-Funktion `readDirectory` geben außerdem sämtliche Einträge eines Ordners zurück. `readDirectory` startet für jeden Eintrag parallel ein `lstat`. Sehr große Ordner können dadurch UI, IPC und Main-Prozess belasten.

**Empfehlung:**

- Aufnahmezeit und kumulierte Bytes im Renderer begrenzen und den Nutzer vor dem automatischen Stopp informieren.
- Im Main-Prozess unabhängig davon Typ und Bytezahl der IPC-Nutzlast validieren.
- Audio möglichst ohne mehrfache vollständige Pufferkopien übertragen beziehungsweise streamen.
- Directory-APIs paginieren oder mit einem harten Eintragslimit plus `truncated`-Hinweis versehen; parallele Stat-Aufrufe begrenzen.

### SNO-10 – Netzwerkoperationen besitzen keinen Request-Timeout

**Priorität:** Mittel / P2

**Betroffene Stellen:**

- `src/main/providers/openai.js:10-23`
- `src/main/providers/anthropic.js:15-27`
- `src/main/providers/google.js:18-30`
- `src/main/providers/ollama.js:44-56`
- `src/main/providers/mlx-lm.js:10-21`
- `src/main/services/whisper-service.js:41-63`

Die Modelllisten und die Whisper-Transkription verwenden `fetch` ohne Timeout oder Abort-Signal. Bei DNS-, Proxy-, TLS- oder Serverproblemen kann die Benutzeroberfläche dadurch auf unbestimmte Zeit im Lade- beziehungsweise Transkriptionszustand bleiben. Für Chat-Streams existiert immerhin ein nutzergetriebener Abort; für diese Nebenoperationen fehlt eine entsprechende Lebenszyklussteuerung.

**Empfehlung:** Einen gemeinsamen Fetch-Wrapper mit sinnvollen Connect-/Gesamt-Timeouts, `AbortController`, klarer Fehlermeldung und Lifecycle-Abbruch beim Schließen der Ansicht einführen. Lokale Provider dürfen einen konfigurierbaren längeren Timeout erhalten.

### SNO-11 – Coverage verdeckt die Renderer-Testlücke

**Priorität:** Mittel / P2

**Betroffene Stellen:** Testkonfiguration in `package.json:6-14`; Renderer unter `src/renderer/`

Der experimentelle Node-Coverage-Lauf meldet sehr gute **93,99 % Zeilen-, 84,21 % Branch- und 92,64 % Funktionsabdeckung**. Diese Gesamtwerte beziehen sich jedoch nur auf Module, die der Node-Testlauf lädt. Von der Renderer-Oberfläche wird im Wesentlichen nur `mentionAutocomplete.js` importiert und vollständig gemessen.

Für zentrale Komponenten wie `FileTree.js`, `SettingsModal.js`, `ChatStream.js`, `SidebarResizer.js`, `WhisperRecorder.js` und die DOMPurify-/Markdown-Integration existieren keine automatisierten DOM-Tests. Genau dort liegen die erkannten Windows-, Accessibility-, Link- und Ressourcenprobleme. Die hohe Gesamtzahl vermittelt daher mehr End-to-End-Sicherheit, als tatsächlich vorhanden ist.

**Empfehlung:**

- Einen DOM-Test-Stack für Renderer-Komponenten einführen und gezielt Interaktionen, Tastatursteuerung und Sanitizing testen.
- Mindestens einen Electron-Smoke-Test für Start, Ordnerwahl, Datei öffnen, Chat-Abbruch und Settings ergänzen.
- Coverage so konfigurieren, dass alle Quelldateien im Nenner stehen; getrennte Schwellen für Main/Application und Renderer ausweisen.

### SNO-12 – Navigation erlaubt jede lokale `file://`-Adresse

**Priorität:** Niedrig / P3

**Betroffene Stelle:** `src/main/window.js:35-53`; positive Referenz: `src/main/permissions.js:4-34`

`will-navigate` blockiert nur URLs, die nicht mit `file://` beginnen. Damit darf das Hauptfenster grundsätzlich zu jeder lokalen HTML-Datei navigieren. Die Berechtigungslogik ist strenger und akzeptiert nur die exakte Renderer-URL; dieselbe Prüfung sollte auch für die Navigation gelten. Durch CSP und die aktuelle Link-Sanitization ist kein direkter Navigationspfad sichtbar, daher ist dies Defense-in-depth und niedrig priorisiert.

**Empfehlung:** Navigation nur zur exakten App-Renderer-URL inklusive erlaubter Query-/Hash-Varianten zulassen und dieses Verhalten testen.

### SNO-13 – Settings-Speicherung ist nicht als Gesamtheit atomar

**Priorität:** Niedrig / P3

**Betroffene Stelle:** `src/main/ipc/settings-handlers.js:125-177`

`commitSettings` speichert zuerst Provider/Presets in der LLM-Konfiguration und danach UI-Präferenzen in einer separaten Datei. Schlägt der zweite Schritt fehl, erhält der Renderer einen Fehler, obwohl der erste Teil bereits dauerhaft geändert wurde. Beim erneuten Öffnen erscheinen dadurch teilweise gespeicherte Einstellungen.

**Empfehlung:** Entweder die beiden Persistenzvorgänge als bewusst partiell dokumentieren und Teilfehler präzise zurückmelden oder eine koordinierte Transaktion mit vorherigem Snapshot/Rollback beziehungsweise einer gemeinsamen Settings-Datei einführen.

### SNO-14 – Große Module und gemischte Modulformate erschweren Wartung

**Priorität:** Niedrig / P3


Mehrere zentrale Dateien bündeln sehr viele Verantwortlichkeiten:

| Datei | Zeilen |
|---|---:|
| `src/renderer/styles.css` | 2.983 |
| `src/main/services/fs-service.js` | 1.900 |
| `src/renderer/components/SettingsModal.js` | 1.109 |
| `src/renderer/components/ChatStream.js` | 747 |
| `src/renderer/components/FileTree.js` | 718 |
| `src/main/services/storage-service.js` | 630 |

Das erschwert isolierte Tests und erhöht die Wahrscheinlichkeit unbeabsichtigter Seiteneffekte. Beim Testlauf meldet Node zusätzlich `MODULE_TYPELESS_PACKAGE_JSON` für das ESM-Modul `src/renderer/chat/mentionAutocomplete.js`, weil das Projekt im Main-Prozess CommonJS und im Renderer ESM verwendet, ohne die Modulgrenze explizit zu deklarieren.

**Empfehlung:** Entlang vorhandener Fachgrenzen weiter aufteilen – insbesondere Path-/Tree-Logik, Settings-Panels, Chat-Rendering und einzelne Dateitools. Für den Renderer eine explizite ESM-Grenze schaffen, beispielsweise über ein passendes untergeordnetes `package.json` oder eindeutig benannte Module; nicht pauschal das Root-Paket auf ESM umstellen, da der Main-Prozess CommonJS nutzt.

### SNO-15 – `mailto:`-Links werden erzeugt, aber nicht geöffnet

**Priorität:** Niedrig / P3

**Betroffene Stellen:** `src/renderer/utils/helpers.js:35-62`, `src/renderer/components/ChatStream.js:707-715`, `src/main/ipc/shell-handlers.js:14-35`, `src/main/window.js:35-45`

Die Markdown-Sanitization erlaubt `mailto:` und versieht Links mit `target="_blank"`. Der Click-Handler fängt jedoch nur HTTP(S) ab; der Window-Open-Handler und der neue Main-Prozess-Handler öffnen ebenfalls ausschließlich HTTP(S). Ein sichtbarer E-Mail-Link wird daher letztlich abgewiesen und reagiert nicht wie erwartet.

**Empfehlung:** Entweder `mailto:` konsistent bis zum Main-Handler erlauben und dort streng validieren oder es bereits beim Sanitizing entfernen beziehungsweise als nicht klickbaren Text darstellen.

### SNO-16 – Chat-Linkfehler bleiben unsichtbar; Clipboard-Fähigkeit ist ungenutzt

**Priorität:** Niedrig / P3

**Betroffene Stellen:** `src/renderer/components/ChatStream.js:707-715`, `src/renderer/components/UpdateBanner.js:63-77`, `src/preload/index.js:81-84`, `src/main/ipc/shell-handlers.js:25-46`

Der neue Main-Handler liefert bei einem fehlgeschlagenen `shell.openExternal` korrekt `{ ok: false, error }`. Das Update-Banner wartet auf dieses Ergebnis und zeigt die Fehlermeldung an. Der Chat-Click-Handler ruft dieselbe asynchrone API dagegen ohne `await`, `catch` oder Auswertung auf. Schlägt das Öffnen dort fehl, bleibt der Link für den Nutzer weiterhin scheinbar wirkungslos; bei einem abgewiesenen IPC-Promise droht zusätzlich eine unbehandelte Promise-Rejection.

Außerdem wird `writeClipboardText` neu über Preload und Main exponiert, aktuell existiert im Renderer jedoch kein Aufrufer. Die Fähigkeit erweitert somit ohne gegenwärtigen Produktnutzen die IPC-Oberfläche und akzeptiert Text ohne Größenlimit.

**Empfehlung:** Chat-Linkaufrufe abwarten, Fehler sichtbar melden und den Renderer-Pfad testen. Die Clipboard-API bis zu einem tatsächlichen Anwendungsfall entfernen oder dann mit klarer Größenbegrenzung, Aufruftest und dokumentiertem Zweck einführen.

## Positive Beobachtungen

### Architektur

- Die Schichten `application`, `ports`, `adapters`, `services`, `providers` und `renderer` sind nachvollziehbar getrennt.
- Architekturtests verhindern unerwünschte Imports aus dem runtime-neutralen Application-Core.
- Provider-, Storage-, Skill- und Tool-Funktionen werden über schmale Ports beziehungsweise Adapter angebunden.
- Die Architektur- und Release-Dokumentation ist umfangreich und weitgehend aktuell.

### Electron- und Rendering-Sicherheit

- `contextIsolation: true`, `nodeIntegration: false` und `sandbox: true` sind korrekt gesetzt.
- Die Content Security Policy ist restriktiv (`default-src 'none'`, kein Netzwerkzugriff aus dem Renderer).
- Externe Fenster werden abgefangen; nur HTTP(S) wird an den Systembrowser delegiert.
- Mikrofonberechtigungen werden auf die exakte Renderer-URL und die benötigten Permission-Typen beschränkt.
- Modellantworten werden mit DOMPurify gereinigt; dynamische Dateinamen werden überwiegend über `textContent` ausgegeben.

### Dateisystem und Datenhaltung

- Workspace-Pfade werden gegen Traversal, Prefix-Sibling-Tricks und Symlink-Ausbrüche geschützt.
- Skill-Verzeichnisse sind nur für Lesetools erreichbar; Schreibtools bleiben auf den Workspace beschränkt.
- Datei-, Such- und Patchtools besitzen sinnvolle Inhalts-, Ergebnis- und Scan-Grenzen – mit Ausnahme der in SNO-02 und SNO-09 beschriebenen Fälle.
- API-Schlüssel werden nur verschlüsselt gespeichert; nicht entschlüsselbare Chat-Historien werden quarantänisiert statt überschrieben.
- JSON-Persistenz verwendet Locks und atomare Einzeldatei-Writes; Parallelität und Migrationspfade sind gut getestet.

### Tests und Abhängigkeiten

- 479 automatisierte Tests laufen erfolgreich und schnell.
- Die gemessene Abdeckung der tatsächlich geladenen Kernmodule ist hoch.
- Provider-Streaming, Tool-Schleifen, Abbruchpfade, Speicherparallelität, Dateisystemgrenzen und Skill-Wurzeln sind umfangreich getestet.
- `npm ls --depth=0` meldet einen konsistenten Dependency-Baum.
- Der statische Secret-Scan fand keine wahrscheinlichen produktiven Zugangsdaten; Treffer waren ausschließlich Test-Fixtures und symbolische Bezeichner.

## Verifikation

| Prüfung | Ergebnis |
|---|---|
| Git-Status nach Einbezug der Paralleländerungen | Sauber; `main` und `origin/main` bei `f7c3323` |
| `npm test` | **479 bestanden**, 0 fehlgeschlagen, 0 übersprungen |
| Node Test Coverage | **93,99 % Zeilen**, **84,21 % Branches**, **92,64 % Funktionen** für geladene Module |
| Dependency-Baum | `npm ls --depth=0` erfolgreich |
| Secret-Pattern-Scan | Keine wahrscheinlichen produktiven Secrets gefunden |
| Paketinspektion | ASAR vorhanden, 9,9 MB, 971 Einträge; lokale `.claude/settings.local.json` enthalten |
| Dependency-Advisory-Scan | **Nicht abschließend möglich:** `npm audit --omit=dev` scheiterte wiederholt an einem Timeout zum npm-Advisory-Endpunkt |

Beim normalen und beim Coverage-Testlauf trat nur die in SNO-14 dokumentierte Node-Warnung zum gemischten Modulformat auf. Erwartete Fehler-Logs aus Negativtests – etwa verweigerte Workspace-Pfade, absichtlich fehlschlagendes Provider-Dispose und quarantänisierte Test-Historien – waren Teil erfolgreicher Testfälle.

## Nicht durchgeführte Prüfungen und Grenzen

- Kein manueller GUI-Durchlauf mit Screenreader oder ausschließlich Tastatur.
- Kein frischer Packaging-Build für macOS und Windows; die Paketinspektion basiert auf dem vorhandenen lokalen macOS-Artefakt und der aktuellen Packager-Konfiguration.
- Keine Code-Signatur-, Notarisierungs- oder SmartScreen-Prüfung; die Release-Dokumentation kennzeichnet Artefakte bewusst als unsigniert.
- Keine Live-Aufrufe an konfigurierte LLM-Provider und keine Kosten-/Lasttests.
- Keine belastbare Schwachstellenbewertung der npm-Pakete, da der Advisory-Endpunkt während des Reviews nicht erreichbar war. Ein erfolgreicher Audit in CI bleibt erforderlich.
- Kein dynamischer Exploit gegen produktive Daten; Sicherheitsfindings wurden aus Datenfluss und Vertrauensgrenzen abgeleitet.

## Empfohlene Umsetzungsreihenfolge

1. **SNO-01:** Workspace-Root vollständig in den Main-Prozess verlagern und IPC-Manipulationstests ergänzen.
2. **SNO-02:** Regex-Ausführung absichern oder ersetzen.
3. **SNO-03:** Testjob für PR/Push und als Release-Gate einführen.
4. **SNO-04 und SNO-05:** Release-Berechtigungen minimieren, Actions pinnen und Packaging allowlisten.
5. **SNO-06 und SNO-07:** Windows-Pfadmodell und Tastaturbedienung korrigieren; Renderer-Testbasis dabei aufbauen.
6. **SNO-08 bis SNO-11:** Atomare Workspace-Writes, Ressourcen-/Netzwerkgrenzen und realistische Renderer-Coverage ergänzen.
7. **SNO-12 bis SNO-16:** Hardening, Persistenzkonsistenz und Wartbarkeitsarbeiten einplanen.

Nach Abschluss der P1-Punkte sollte ein fokussiertes Security-Re-Review der IPC-Vertrauensgrenzen, Toolausführung und Release-Pipeline erfolgen.
