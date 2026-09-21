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
- `environment-port` — Umgebungsangaben für den Environment-Block im
  Systemprompt (Issue #138): Arbeitsverzeichnis, Git ja/nein, Plattform,
  Systemversion, Shell und Tagesdatum. Ermittelt werden sie im
  `main/adapters/environment-adapter.js` — der Core selbst sieht weder
  `process.platform` noch das Dateisystem
- `memory-port` — die beiden `memory.md`-Dateien und das Anhängen einzelner
  Einträge (#166). Adapter: `main/adapters/memory-adapter.js`. **Die Pfade
  entstehen ausschließlich dort**: Das Tool `remember` nennt nur die Ebene
  (`workspace` | `user`), nie einen Pfad — deshalb weicht das Schreiben nach
  `~/.snotra` die Workspace-Grenze der Datei-Tools nicht auf. Der Adapter
  schreibt seriell je Datei, damit zwei Fenster im selben Ordner sich nicht
  gegenseitig überschreiben.
- `project-instructions-port` — die gefundenen `AGENTS.md`-Dateien für den
  Block mit den Projektanweisungen (Issue #212). Wo sie liegen, weiß allein
  `main/adapters/project-instructions-adapter.js`; der Core sieht weder
  `os.homedir()` noch das Dateisystem. Bewusst **ohne Cache und ohne
  Watcher**: Es sind drei Dateien, die je Anfrage frisch gelesen werden —
  anders als der Skill-Katalog, der ganze Verzeichnisse scannt und Frontmatter
  parst und deshalb beides braucht
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
- `mcp-port` — Tools externer MCP-Server auflisten und aufrufen (Issue #106,
  Teil von #62). Der Core sieht weder Prozesse noch JSON-RPC: die
  Verbindungsverwaltung (Handshake, `tools/list`, `tools/call`, Zeitlimits,
  Abbruch, sauberes Beenden) liegt im `main/services/mcp-service.js`, das
  Zeilen-Framing über stdin/stdout im `main/services/mcp-stdio-transport.js`.
  Die Trennung ist Absicht: bewusst kein `@modelcontextprotocol/sdk`, solange
  nur stdio und nur `tools` im Spiel sind — der Transport ist die Stelle, an
  der ein SDK später andocken könnte, ohne dass Port oder Core sich ändern.
  Validierung der Serverkonfiguration in `shared/contracts/mcp.js`.

  Zum Modell kommen diese Tools über den `main/adapters/mcp-adapter.js`, der
  sie in Registry-Definitionen übersetzt (Issue #107). Vier Regeln gelten
  dabei:

  * **Namensraum** `mcp__<serverId>__<toolName>` — ein fremdes `read_file`
    kann das eingebaute nie verdecken. Der doppelte Unterstrich ist als
    Trenner reserviert, Serverkennungen dürfen ihn deshalb nicht enthalten.
  * **Risikoklassen**: immer `execute` **und** `external`. Ein MCP-Tool ist
    fremder Code mit unbekannter Wirkung — die Planung kennt seine Zielpfade
    nicht, `targets` bleibt leer. Die Annotations des Servers dürfen nur
    verschärfen (`destructiveHint` ergänzt `delete`); `readOnlyHint` wird
    bewusst ignoriert, sonst entschiede der fremde Server darüber, wie streng
    wir ihn behandeln. Folge der Klassenwahl: MCP-Aufrufe sind weder
    sitzungsweise noch dauerhaft freigebbar — jeder einzelne wird gefragt.
  * **Fehler sind Ergebnisse**: ein toter oder nicht startbarer Server liefert
    eine Fehlermeldung als Tool-Ergebnis, keinen Wurf. Der Chat läuft weiter.
  * **`title` fliegt aus dem Schema** (Issue #185): Pydantic-Server hängen an
    jede Eigenschaft eine Beschriftung, die nur den Feldnamen wiederholt
    (`session_id` → `"title": "Session Id"`). Sie sagt dem Modell nichts und
    kostet in jeder Runde — beim heimat-Server 72 von 204 Schema-Token, also
    gut ein Drittel. `stripSchemaTitles` in `shared/contracts/mcp.js` räumt
    sie beim Übernehmen des Katalogs weg. Der Walk ist **schemabewusst**, und
    das ist der ganze Punkt: In `properties`, `$defs` & Co. ist der Schlüssel
    ein *Name*, kein Schlüsselwort — ein Parameter, der `title` heißt (bei
    Atlassian vier, darunter `confluence_get_page`), bleibt unangetastet. Ein
    naiver Walk über alle Objekte würde ihn löschen und das Tool brechen.
    `description` bleibt in jedem Fall stehen; dort steht, was das Modell
    wissen muss.

  Weil MCP-Tools erst zur Laufzeit feststehen, hat der `tool-port` das
  optionale `prepare()`: die Engine ruft es einmal je Lauf auf, bevor
  Systemprompt und Tool-Liste gebaut werden. Danach ist die Liste für diesen
  Lauf fest.

  Die Serverliste liegt in `mcp-servers.json` im userData-Verzeichnis (Issue
  #108), eigene Datei wie beim Suchdienst. Umgebungsvariablen stehen dort je
  Schlüssel entweder als `{ enc }` (über `safeStorage` verschlüsselt) oder als
  `{ value }` (Klartext) — **verschlüsselt ist die Vorgabe**, Klartext die
  bewusste Ausnahme je Schlüssel. Wer das Häkchen nicht anfasst, hat sein
  Token geschützt; Vergessen darf nicht der teure Fall sein. Lässt sich nicht
  verschlüsseln (Linux ohne Keyring), wird der Server **nicht** gespeichert
  statt ein Token im Klartext abzulegen; die Klartextwerte allein ließen sich
  weiterhin sichern.

  Bedient wird das im Einstellungs-Dialog unter „MCP" (Issue #109). Der
  Bereich liegt als eigene Renderer-Komponente in
  `renderer/components/McpPanel.js`: das Panel trägt nur die Liste mit Status
  und Schalter, angelegt und bearbeitet wird in einem Unterdialog nach dem
  Muster von „Modell hinzufügen". Wie die Berechtigungen und anders als der
  Rest des Dialogs wirken Änderungen dort **sofort** — die Liste gehört dem
  Main, dort liegen die Geheimnisse, und ein Verbindungstest braucht ohnehin
  den gespeicherten Stand. Die Fußleiste sagt das je Bereich.

  Ein gespeichertes Geheimnis erscheint im Formular nur als Platzhalter; wer
  es nicht anfasst, schickt `{ keep: true }` statt eines Wertes, den der
  Renderer gar nicht kennt.

  Zwei Lesewege, absichtlich getrennt und in
  `test/infrastructure-boundaries.test.js` festgenagelt:
  `createMcpConfigStorePort` liefert die Anzeigeform ohne Geheimnisse und ist
  das, was Handler und Renderer erreichen; `createMcpSecretsPort`
  entschlüsselt und ist nur für den Dienst da, der die Prozesse startet.
  MCP-Geheimnisse gehen zusätzlich in `readOwnSecrets` ein — ein MCP-Server
  könnte sein eigenes Token sonst über ein Tool-Ergebnis zurückgeben — und
  werden aus Fehlermeldung und stderr-Auszug maskiert
  (`redactOwnSecrets`), bevor ein Status den Main-Prozess verlässt.
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

### Selbst-Update: drei Schritte, drei Module

Der `update-port` ist bewusst kein einzelnes „aktualisiere dich", sondern
`checkForUpdate` / `downloadUpdate` / `installUpdate` plus Abbruch. Grund ist
die Anforderung selbst (Issue #232): Der Nutzer bestätigt Laden und
Installieren einzeln und kann dazwischen aussteigen — ein zusammengefasster
Aufruf könnte das nicht abbilden.

Dahinter liegen drei Module in `services/`, getrennt nach dem, was jeweils
schiefgehen kann:

- `update-targets.js` — **rein**, ohne Dateisystem und Prozesse. Beantwortet
  „welche Art von Installation läuft hier" (macOS-Bundle, Windows-Verzeichnis,
  AppImage, entpacktes Linux-Verzeichnis, Systempaket, Entwicklungs-Build) und
  „welches Release-Asset passt dazu". Diese Entscheidung fällt auf jeder
  Plattform anders und lässt sich auf keiner gefahrlos ausprobieren, deshalb
  steht sie als reine Funktion für sich.
- `update-download.js` — Strom auf die Platte, mit Fortschritt und echtem
  Abbruch. Lädt nur von `github.com` bzw. `*.githubusercontent.com` über HTTPS
  und verwirft eine Datei, deren Länge nicht zur angekündigten passt; ein
  Torso darf beim nächsten Versuch nicht als fertiger Download durchgehen.
- `update-installer.js` — der Austausch. Überall dasselbe Muster: die neue
  Version wird **neben** der alten fertig ausgepackt und geprüft, erst danach
  übernimmt ein losgelöstes Helferskript, das auf das Ende dieses Prozesses
  wartet, umbenennt und neu startet. Im laufenden Prozess ginge es nicht — unter
  Windows ist die `.exe` gesperrt, unter Linux hängt das AppImage als
  Dateisystem im eigenen Prozess. Die Skripte selbst werden als reine
  Zeichenketten gebaut und sind damit ohne Installation prüfbar.

Die Adresse des Pakets verlässt den Main-Prozess nie: Der Renderer erfährt aus
`checkForUpdate` nur Name und Größe und stößt den Download ohne Parameter an.

Der **Skill-Service** (`services/skills-service.js`) scannt die drei
Skill-Quellen — die eingebauten System-Skills aus `system-skills/` im
App-Bundle sowie `.agents/skills/` in Workspace und Home; Verzeichnisse
anderer Werkzeuge wie `.claude/` bleiben ungelesen — und wird über
`adapters/skills-adapter.js` als schmaler `skill-port`
in die Chat-Engine gereicht. Das Parsen des Frontmatters liegt als reine
Funktion in `shared/runtime/skill-frontmatter.js`, die Enums und DTOs in
`shared/contracts/skills.js`.

### Ein Watcher, zwei Anwender

Dass die App mitbekommt, was **neben** ihr im Dateisystem passiert, leistet ein
einziger Dienst: `services/directory-watcher.js`. Er kapselt die teuer
bezahlten Eigenheiten von `fs.watch` — fehlende Zielverzeichnisse, ein
verschwindender Watch-Root (macOS verstummt, Windows feuert endlos), die
Linux-Attrappe bei `recursive: true`, Ereignis-Lawinen (Entprellung mit
Höchstfenster), `error`-Ereignisse ohne Listener und die Wiedervorlage nach
einem verlorenen Ereignis (Issues
[#126](https://github.com/kkrafft1999/snotra/issues/126),
[#155](https://github.com/kkrafft1999/snotra/issues/155)).

Darauf sitzen zwei dünne Hüllen, die nur noch sagen, *was* beobachtet wird:

- `services/skills-watcher.js` — `.agents/skills` in Workspace und Home, mit
  Vorfahren-Kette (die Verzeichnisse fehlen meistens). Meldet ohne Nutzlast;
  der Skill-Katalog wird ohnehin komplett neu gelesen.
- `services/workspace-watcher.js` — der Projektordner, rekursiv und ohne Kette
  nach oben. Er meldet die betroffenen **Ordner**, damit der Dateibaum nicht
  bei jedem Ereignis alles neu laden muss (Issue
  [#158](https://github.com/kkrafft1999/snotra/issues/158)). Eine Ignorierliste
  hält den Inhalt von `node_modules/` und `.git/` sowie Editor-Temporärdateien
  draußen; `.git/HEAD` und `.git/index` kommen bewusst durch — sie sind das
  Zeichen für einen Zweigwechsel und melden sich als `complete: false`, worauf
  der Renderer einmal gröber neu lädt statt hundertfach einzeln.

Der Weg zum Baum: `fs:tree-changed`
(`shared/contracts/workspace-tree.js`) → `FileTree.js` lädt die gemeldeten
Ordner neu, aber nur die gerade sichtbaren, und nur wenn sich ihr Inhalt
wirklich geändert hat. Auswahl, Tastaturfokus und Scrollposition werden vor dem
Neuzeichnen gesichert und danach wiederhergestellt.

## Bilder aus dem Workspace im Chat

Ein vom Modell erzeugtes Bild (`![Diagramm](diagramm.png)`) liegt im
Projektordner und damit außerhalb des App-Origins. Die CSP des Renderers
erlaubt `img-src 'self' data:` — geladen wird deshalb **nicht** über ein
eigenes Protokoll, sondern per IPC als `data:`-URI (Issue
[#244](https://github.com/kkrafft1999/snotra/issues/244)). Das spart sowohl
eine CSP-Lockerung als auch eine `protocol.handle`-Registrierung; der Preis ist
Base64 im Speicher und kein Browser-Caching, wogegen ein Größenlimit von 10 MB
und ein kleiner Cache im Renderer stehen.

Der Weg: `ChatStream.js` ruft nach dem Sanitizing `applyWorkspaceImages`
(`renderer/chat/workspaceImages.js`) auf den fertigen `<img>`-Knoten im DOM —
nie per String-Ersetzung im HTML, DOMPurify läuft unverändert zuerst. Das `src`
dort ist eine **URL, kein Dateipfad**: `marked` prozent-kodiert, was in einer
URL nicht roh stehen darf, aus `C:\ws\plot.png` wird `C:%5Cws%5Cplot.png` und
aus `bilder/grün.png` wird `bilder/gr%C3%BCn.png`. Ohne die Rücknahme in
`decodeWorkspaceImageSource` fände der Main-Prozess keine Datei mit Leerzeichen,
Umlaut oder Windows-Trenner. Von dort
geht `fs:readWorkspaceImage` an `fs-service.readWorkspaceImage`, das den Pfad
(relativ oder absolut) gegen den aktiven Workspace auflöst, ihn lexikalisch
**und** über `realpath` prüft, den Typ am Dateikopf bestimmt (PNG, JPEG, GIF,
WebP — kein SVG) und die Größe begrenzt. Zurück kommt `{ mime, base64 }` oder
ein Grund aus `shared/contracts/workspace-image.js`, zu dem der Renderer einen
gestalteten Platzhalter baut.

**Eine Ausnahme im Sanitizer**, die einzige an dieser Stelle: DOMPurify erlaubt
nur bekannte URL-Schemata und wirft alles andere weg. Ein Windows-Pfad
`D:\ws\plot.png` sieht für die Prüfung aus wie ein Schema `d:` — das `src`
verschwindet, während `/Users/…` auf macOS und Linux anstandslos durchgeht. Ein
`uponSanitizeAttribute`-Hook in `renderer/utils/helpers.js` hält deshalb genau
diesen einen Fall fest: nur `<img src>`, nur ein echter Laufwerkspfad
(`isWindowsDrivePath`). Sie öffnet nichts — der Wert wird nie geladen, sondern
durch einen `data:`-URI oder einen Platzhalter ersetzt; selbst wenn das
ausbliebe, lässt `img-src 'self' data:` kein `d:` zu, und geprüft wird der Pfad
ohnehin erst im Main-Prozess. Ohne sie gäbe es auf Windows nie ein Bild über
einen absoluten Pfad.

Zwei Eigenheiten hängen am Streaming: Während die Antwort läuft, setzt
`scheduleStreamRender` je Animation-Frame das komplette `innerHTML` neu —
Bilder bekommen deshalb bis zum Ende nur einen ruhigen Platzhalter. Und der
Abschluss bestellt den noch ausstehenden Frame ab (`cancelStreamRender`), sonst
schriebe er den Zwischenstand über das gerade geladene Bild zurück.

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

### Bild-Anhänge im Verlauf (Issue #94)

Bilder liegen **neben** der Verlaufsdatei, nicht darin:
`services/chat-attachment-store.js` schreibt sie nach
`chat-attachments/<Chat-ID>/<SHA-256>.<ext>` im userData-Ordner, die Session
trägt nur `{ kind, mediaType, file }`. Vier Screenshots in einer Nachricht
kosten die Session-JSON damit ein paar Dutzend Zeichen statt Megabytes an
Base64. Der Dateiname ist der Inhalts-Hash — derselbe Screenshot landet bei
jedem Sichern unter demselben Namen, das Schreiben ist also wiederholbar.

Die Normalisierung (`chat-history-normalization.js`) nimmt über
`normalizeStoredAttachments()` **nur** Referenzen an. Base64 kann damit auch
dann nicht in die Verlaufsdatei geraten, wenn die Ablage fehlt oder ein
Schreibversuch scheitert. Dateinamen aus der Verlaufsdatei werden vor jedem
Pfad-Zusammenbau gegen `ATTACHMENT_FILE_RE` geprüft, Chat-IDs, die als
Ordnername nicht taugen, laufen über ihren Hash — aus dem Anhang-Ordner führt
nichts heraus.

Der Renderer bekommt beim Laden nur die Referenz und holt die Bilddaten erst
beim Anzeigen über `CHAT_ATTACHMENT_READ` nach; ein Ordner mit vielen Sessions
schickt so nicht seinen gesamten Bildbestand über IPC. Eine fehlende Datei ist
`{ ok: false }` und wird als Platzhalter gezeigt, nicht als Fehler. Aufgeräumt
wird unter dem Verlaufs-Lock: `CHAT_HISTORY_DELETE` entfernt den Ordner des
Chats, jedes `CHAT_HISTORY_UPSERT` zusätzlich alles, wozu es keine Session mehr
gibt (aus `MAX_CHAT_SESSIONS` gefallen, Reste einer quarantänisierten
Verlaufsdatei).

### Modell und Freigabemodus gehören zum Chat (Issue #211)

Beides lag früher nur app-weit: `activePresetId` in der LLM-Konfiguration, der
Berechtigungsmodus in der signierten `tool-policy.json`. Ein Eintrag aus dem
Verlauf kam deshalb mit seinen Nachrichten zurück, lief aber mit dem gerade
eingestellten Modell und Modus weiter.

`services/chat-session-settings.js` ist der Gegenpart dazu. Er merkt sich je
Chat `modelPresetId` und `toolPermissionMode`, schreibt beides in die Zeile des
Chats im Verlauf und wendet es beim Wechsel wieder an. Die Werte kommen
ausschließlich aus dem Main: `CHAT_HISTORY_ACTIVATE` nennt nur die Chat-Kennung
und ob der Wechsel ausdrücklich war, und `CHAT_HISTORY_UPSERT` verwirft, was der
Renderer zu diesen beiden Feldern mitschickt (Konzept §5).

Zwei bewusst verschiedene Regeln für einen neuen Chat:

- **Modell**: Der zuletzt ausdrücklich gewählte Eintrag gilt weiter. Er steht
  als `defaultPresetId` in der LLM-Konfiguration und wird nur von einer echten
  Wahl fortgeschrieben (Pille, Einstellungen) — das Herstellen eines alten Chats
  setzt nur `activePresetId`. Fehlt das Feld in einer älteren Konfiguration,
  ergänzt `readLLMConfig` es einmalig aus `activePresetId`; ohne diesen Schritt
  wanderte der Standard beim ersten Chatwechsel mit.
- **Freigabemodus**: immer wieder `smart`. `auto` kommt nur beim ausdrücklichen
  Wechsel im Verlauf zurück, beim automatischen Herstellen (App-Start,
  Ordnerwechsel) fällt es auf `smart` — Details in
  [`sicherheitskonzept.md`](./sicherheitskonzept.md) §8.

Ein Eintrag, den es nicht mehr gibt oder dessen Zugang unvollständig ist, fällt
auf den Standard zurück (`isPresetUsable`), statt den Chat mit einem toten
Modell zu öffnen.

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

## Provider-Adapter

`src/main/providers/` hält je Anbieter ein Modul, das den Vertrag aus
`providers/index.js` erfüllt (`listModels`, `streamChatRound`, dazu `fields`,
`presentation`, `capabilities`). Registriert sind sechs: `openai`, `anthropic`,
`google`, `ollama`, `mlx-lm` und `openai-compatible`.

Die beiden OpenAI-Protokolle liegen **einmal** da und werden geteilt, statt je
Anbieter kopiert zu werden:

| Modul | Protokoll | Benutzt von |
| ----- | --------- | ----------- |
| `openai-chat-transport.js` | Chat Completions (`POST {base}/chat/completions`), SSE | `mlx-lm`, `openai-compatible` |
| `openai-responses-transport.js` | Responses (`POST {base}/responses`), SSE | `openai`, `openai-compatible` |

Die Transporte kennen weder Anbieter-IDs noch gespeicherte Konfiguration: Sie
bekommen fertige Header, eine Base-URL und die Nachrichten. Alles
Anbieter-Eigene — welche Header, ob Bilder, ob Tools, welcher Stil — entscheidet
das Provider-Modul. `ollama` bleibt außen vor: Es spricht die native API
(`/api/tags`, `/api/chat` mit NDJSON) und nicht den OpenAI-Layer unter `/v1`.

### Was ein Anbieter über seine Felder sagt

`fields` steuert Formular, Persistenz und Validierung gemeinsam — der Renderer
zeigt genau die Felder, die ein Anbieter deklariert
(`buildProviderFormView` in `shared/contracts/settings.js`), der
Storage-Service liest genau sie (`getEffectiveProviderConfig`), und der
Settings-Handler schreibt genau sie (`mergeProviderPatchIntoConfigImpl`).
Neben `apiKey`, `baseUrl` und `insecureTls` gibt es seit Issue #193
`displayName`, `apiStyle`, `extraHeaders`, `supportsImages` und `sendTools`.

Drei Sonderfälle deklariert ein Anbieter zusätzlich am Modul:

- `optionalApiKey: true` — ein leerer Schlüssel ist ein **gültiger** Zustand.
  Sonst gilt ein Anbieter mit `fields.apiKey` ohne Key als unvollständig
  konfiguriert und lehnt Modellabruf wie Versand ab.
- `capabilitiesFor(config)` — Fähigkeiten, die an der gespeicherten
  Konfiguration hängen statt am Adapter. `capabilities` bleibt die
  Voreinstellung für Anbieter ohne diese Funktion.
- `connectionPerPreset: true` — die Verbindung gehört zum **Eintrag**, nicht
  zum Anbieter (Issue #202). Siehe unten.

Geheimnisse verlassen den Main-Prozess nicht: Der API-Schlüssel und die
Zusatz-Header liegen `safeStorage`-verschlüsselt (`apiKeyEnc`,
`extraHeadersEnc`), und die View meldet dem Renderer nur `hasKey`
bzw. `hasExtraHeaders` — nie den Inhalt.

### Verbindung je Eintrag

Bei `connectionPerPreset` liegt die Verbindung nicht unter
`providers[id]`, sondern als `connection` am Preset:

```jsonc
{
  "version": 4,
  "providers": { /* die übrigen fünf Anbieter */ },
  "presets": [
    { "id": "…", "providerId": "openai-compatible", "model": "qwen2.5",
      "connection": { "baseUrl": "…", "apiKeyEnc": "…", "displayName": "LM Studio", … } }
  ]
}
```

Der Grund ist ein Anwendungsfall, der vorher unmöglich war: ein lokaler Server
**und** ein Firmen-Gateway nebeneinander. Der Preis ist, dass ein Schlüssel so
oft in der Datei steht, wie es Einträge auf denselben Server gibt; deshalb gilt
die Regel nur für den generischen Anbieter und nicht für die fünf festen.

Daraus folgen vier Dinge, die leicht übersehen werden:

- **Das Chat-Ziel trägt `presetId`.** Ohne die Kennung lässt sich die
  Verbindung nicht mehr auflösen; `getEffectiveProviderConfig(providerId,
  { presetId })` braucht sie. Bewusst nur die Kennung — das Ziel geht als DTO
  bis in den Renderer.
- **`configured` ist eine Eigenschaft des Eintrags**, nicht des Anbieters:
  `buildPresetView` entscheidet es, nicht `buildProviderView`.
- **Die Schwärzung eigener Schlüssel** (`readOwnSecrets` in
  `create-application.js`) läuft über `providers` *und* über die Einträge —
  sonst fiele genau der Gateway-Token durch.
- **Der Anbieter-Eintrag darf nicht zurückkehren.** Renderer und
  `mergeProviderPatchIntoConfigImpl` lassen `providers[id]` für solche
  Anbieter aus; sonst stünde neben der Verbindung am Eintrag eine zweite,
  konkurrierende Wahrheit.

Die Schema-Version steht als `LLM_CONFIG_VERSION` in
`shared/contracts/settings.js` — Main-Prozess und Settings-Handler lesen
dieselbe Zahl. Die Migration v3 → v4 kopiert `providers['openai-compatible']`
in jeden Eintrag dieses Anbieters und entfernt den Anbieter-Eintrag; sie ist
idempotent und lässt eine bereits vorhandene Verbindung stehen.

### Lokal oder entfernt: am Host, nicht an der ID

Drei Stellen behandeln lokale Anbieter anders als Cloud-Anbieter: das Zeitlimit
des Modellabrufs (`services/request-timeout.js`), das Zeichenbudget des
Verlaufs (`application/chat/chat-history-trim.js`) und der Teiler Zeichen→Token
der Kontext-Aufschlüsselung (`shared/contracts/context-breakdown.js`).

Bis Issue #193 hing das an einer festen Liste von Provider-IDs. Der generische
Anbieter passt in keine solche Liste — dieselbe ID bedient LM Studio auf
`localhost` und ein Gateway im Netz. Die Frage beantwortet deshalb
`shared/contracts/provider-endpoint.js` am **Host der Base-URL**; die
bestehenden ID-Einträge für `ollama` und `mlx-lm` bleiben unangetastet, die
Host-Regel greift zusätzlich.

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

### Aufteilung im Renderer ([#81](https://github.com/kkrafft1999/snotra/issues/81))

Die Komponenten unter `renderer/components/` sind die Verdrahtung: Sie hängen
Handler an Elemente und zeichnen. Alles, was sich *entscheiden* lässt, ohne
einen Knoten anzufassen, liegt daneben — und ist damit einzeln prüfbar, statt
nur über die ganze Komponente erreichbar zu sein:

| Modul | Was dort liegt | Test |
| ----- | -------------- | ---- |
| `renderer/tree/treePaths.js` | Pfad- und Baumlogik des Dateibaums: Ordner von oben nach unten sortieren, Einrückung → Baumtiefe, externer Drop und sein Zielordner, Ordnerinhalte vergleichen, was nach einem Neuzeichnen wieder aufzuklappen ist | `test/tree-paths.test.js` |
| `renderer/chat/toolLogView.js` | Tool-Log im Chat als DOM-Schicht: Zeilen samt Zustand und Berechtigungs-Audit, der aufklappbare `<details>`-Block, der Einzeiler in der `<summary>`, das Abschließen eines abgebrochenen Laufs | `test/tool-log-view-dom.test.js` |
| `renderer/chat/toolLogDebug.js` | Der Diagnose-Puffer des Tool-Logs ([#87](https://github.com/kkrafft1999/snotra/issues/87)) als eine Instanz je Renderer — Ansicht und `ChatStream` teilen ihn, statt ihn durch jede Signatur zu reichen | `test/tool-log-debug.test.js` |
| `renderer/utils/tool-log-summary.js` | Was im Einzeiler *steht* — DOM-frei, älter als die Aufteilung | `test/tool-log-summary.test.js` |

`FileTree.js` und `ChatStream.js` bleiben groß, weil Verdrahtung nun einmal
Platz braucht — die Pfad- und Tool-Log-Logik steckt aber nicht mehr darin. Die
verbleibenden Brocken (`styles.css`, `fs-service.js`, `SettingsModal.js`)
werden mit den Issues geteilt, die sie ohnehin anfassen; eine Umsortierung ohne
Anlass bringt nur Konfliktfläche.

**Modulgrenze:** `src/renderer/package.json` deklariert `{ "type": "module" }`.
Der Main-Prozess ist CommonJS, der Renderer lädt native ES-Module ohne Bundler;
ohne diese eine Datei müsste Node jede Renderer-Datei im Testlauf zweimal
parsen und warnte bei jedem Lauf (`MODULE_TYPELESS_PACKAGE_JSON`). Das
Root-Paket bleibt bewusst ohne `type`. Auf das Packaging wirkt sich die Datei
nicht aus: Die Allowlist in `config.forge.packagerConfig.ignore` lässt alles
unter `src/` durch, und `scripts/check-asar-contents.js` prüft das nach jedem
Build.

### Zwei Hälften: Arbeitsbereich und Chat ([#223](https://github.com/kkrafft1999/snotra/issues/223))

Verzeichnisbaum und Anzeige gehören zusammen — man klickt links eine Datei an
und sieht sie daneben. Der Chat ist die andere Hälfte. Das Markup bildete das
bis 1.7.0 genau andersherum ab: `#workspace` klammerte Anzeige und Chat, der
Baum stand allein daneben. Seit Phase A gilt:

```
#app
├── #workspace        Arbeitsbereich: #sidebar · #divider · #content
├── #chat-divider
└── #chat-panel       Chat (in Phase B: Chat + Verlauf)
```

Zwei Regeln hängen daran:

- **Alle Wegschalt-Zustände sitzen auf `#app`** — `app--no-sidebar`,
  `app--no-preview`, `app--no-chat` und `app--no-history`. Vorher trug jede
  Hälfte ihren eigenen Mechanismus auf
  einem anderen Container; dieselbe Geste war zweimal beschrieben. Ohne
  Anzeige fällt `#workspace` auf `flex: 0 0 auto` zurück, sonst teilte es sich
  die Breite mit dem Chat, statt auf die Seitenleiste zu schrumpfen.
- **Wird das Fenster breiter, teilen sich beide Hälften den Zuwachs je zur
  Hälfte.** Das steht in `SidebarResizer.js` (ein `ResizeObserver` auf `#app`)
  und nicht im CSS: Flexbox kann „zusätzliche Breite gleichmäßig verteilen"
  nicht ausdrücken, weil ihm der Bezugspunkt fehlt — `flex-grow` verteilt den
  Rest gegen die Basis, nicht gegen den vorherigen Stand. Geschrieben wird nur
  die neue Chat-Breite; der Arbeitsbereich füllt als `flex: 1` den Rest von
  selbst. Die Rechnung läuft rückwärts genauso, deshalb landet Maximieren und
  Zurücksetzen wieder dort, wo man war.

Seit Phase B ist auch die rechte Hälfte ein Paar: `#chat-area` klammert Chat und
Verlauf, die Struktur ist damit symmetrisch.

```
#app
├── #workspace        #sidebar · #divider · #content
├── #chat-divider
└── #chat-area        #chat-panel · #history-divider · #chat-history
```

Der Verlauf war bis 1.7.0 ein Ausklapper über den Nachrichten: Er schob den
Chat nach unten, ging beim Klick daneben und bei Escape wieder zu und
verschwand nach jeder Auswahl. Als Spalte bleibt er stehen — deshalb schließt
`ChatHistoryPanel.js` nichts mehr von selbst, `FileTree.js` hat seinen
Escape-Haken dafür verloren und `ToolApprovalCard.js` zählt ihn nicht mehr zu
den Overlays, die Escape für sich beanspruchen.

Seitdem ist die Symmetrie auch bedienbar: **Jede der vier Spalten hat genau
einen Schalter, und alle vier stehen in der Titelzeile** — links die des
Arbeitsbereichs, rechts spiegelverkehrt die der Chat-Seite, jeweils in der
Reihenfolge ihrer Spalten und mit demselben, gespiegelten Bild. Damit gilt für
Chat und Verlauf dasselbe Muster wie für Baum und Anzeige:

- Der Chat ist wegschaltbar (`app--no-chat`, `chatPanelVisible` in den
  UI-Prefs); übrig bleibt dann der Verlauf. `SidebarResizer.js` rechnet seine
  Breite in diesem Zustand als 0 und lässt die gemerkte Breite in Ruhe, damit
  er so breit zurückkommt, wie er weggegangen ist.
- **Ein Klick im Verlauf holt die Chat-Spalte zurück** (`revealChatPanel`) —
  Spiegelbild zu `revealContentPane` beim Klick auf eine Datei im Baum. Ohne
  das liefe der Klick in eine weggeschaltete Fläche.
- Der Knopf für einen neuen Chat steht in der Kopfzeile des Verlaufs, so wie
  „Ordner öffnen“ in der Kopfzeile des Baums steht: Die Aktion, die einer
  Spalte Einträge verschafft, gehört in diese Spalte.
- Der Einstellungsdialog hat keinen Knopf mehr. Das Zahnrad saß in der
  Kopfzeile des Chats und war mit dessen Spalte weg; seitdem führt nur noch
  *Ansicht → Einstellungen…* (`CmdOrCtrl+,`) hinein — ein Push auf
  `UI_OPEN_SETTINGS`, genau wie `UI_TOGGLE_SIDEBAR` beim Kürzel `Cmd/Ctrl+B`.
  Das Kürzel hängt am Menüeintrag und nicht an einer Tastenabfrage im
  Renderer, damit es auch in einem Eingabefeld gilt. Ein zweiter Aufruf bei
  offenem Dialog ist ein No-op: `openSettingsModal()` merkt sich den Fokus von
  **vor** dem Öffnen, und den überschriebe er sonst mit einem Element aus dem
  Dialog selbst.
- Die drei Spaltenköpfe (`#tree-header`, `#chat-header`,
  `#chat-history-header`) bilden eine Linie. Ihre Höhe kam bisher von den
  Icon-Knöpfen darin; der Chat-Kopf hat seit dem Entfallen des Zahnrads keine
  mehr und trägt dieselbe Rechnung deshalb als `min-height`.

Drei Regeln halten die vier Spalten zusammen, alle in `SidebarResizer.js`:

- **Der Arbeitsbereich behält sein Mindestmaß** (`workspaceMin()`): die
  eingestellte Breite der Seitenleiste plus `CONTENT_MIN`, und zwar nur für
  das, was gerade sichtbar ist. Die Seitenleiste geht mit ihrer eingestellten
  Breite ein, nicht mit ihrem Minimum — wer sie breit gezogen hat, will sie
  breit sehen; dann weicht lieber der Verlauf.
- **Wird es zu eng, gibt zuerst der Chat nach, dann der Verlauf, dann klappt
  der Verlauf weg** (`ensureRoomForWorkspace()`). Das geschieht mit
  `persist: false`: Der gemerkte Wunsch des Nutzers bleibt stehen, damit die
  Spalte im breiteren Fenster wiederkommt — in der Breite von vor dem
  Zusammendrücken. Wer sie selbst zuklappt, findet sie nicht von allein wieder.
- **Die Obergrenze des Chats** rechnet gegen `#app` und zieht die
  Verlaufsbreite ab. Sie steht nur noch im JS, nicht mehr als `max-width` im
  CSS: „was nach Chat und Verlauf für Baum und Anzeige übrig bleiben muss" ist
  keine Prozentzahl.

Die Liste hängt an `onChatPersisted` aus `ChatStream.js` — eine Spalte, die
dauerhaft danebensteht, darf nicht den Titel von vorhin zeigen.

### Startzustand der mittleren Spalte ([#208](https://github.com/kkrafft1999/snotra/issues/208))

Wer die App in einer Konversation verlässt, soll dort wieder landen — nicht
neben dem Startschirm, der für den kalten Start gedacht ist. Die Entscheidung
darüber ist auf drei Stellen verteilt, und die Reihenfolge ist der Punkt:

1. **`index.html` startet mit `app--no-preview`.** Der erste Bildaufbau
   passiert, bevor `app.js` etwas weiß; stünde dort die offene Spalte, blitzte
   der Startschirm auf und spränge gleich wieder weg. `test/startup-layout.test.js`
   hält Markup und Umschalter-Zustand (`aria-pressed`) zusammen.
2. **`loadChatForWorkspace()` meldet das Ergebnis** (`{ restored, wasActive }`)
   statt es nur anzuwenden — der Start braucht die Auskunft, der Ordnerwechsel
   ignoriert sie.
3. **`contentPaneVisibleOnStart()`** (`renderer/utils/startupLayout.js`) fügt
   beides mit der gespeicherten Einstellung zusammen; `app.js` wendet das
   Ergebnis im `finally` der Startsequenz an, damit ein Fehler beim Laden die
   Spalte nicht zugeklappt hängen lässt.

Die Vorschau lebt in dieser Spalte, deshalb holt ein Klick auf eine Datei sie
über `revealContentPane` zurück — sonst bliebe der Klick folgenlos.

### Fensterzustand ([#209](https://github.com/kkrafft1999/snotra/issues/209))

Größe, Position, maximiert und Vollbild liegen in `window-state.json` im
`userData`-Ordner — bewusst neben der Ablage aus `storage-service`: der Zustand
gehört dem Fenster allein, niemand sonst liest ihn, und er muss stehen, bevor
irgendein Service existiert. Geschrieben wird synchron (die letzte Änderung ist
beim Schließen fällig, danach wartet der Prozess auf nichts mehr) und während
des Betriebs entprellt, weil Ziehen am Fensterrand sonst dutzendfach pro
Sekunde auf die Platte ginge. Gesichert wird immer `getNormalBounds()`, also
das Maß *unter* Maximierung und Vollbild.

Die Entscheidung beim Start liegt als reine Funktion `resolveWindowBounds()` in
`src/main/window-state.js`, weil zwischen zwei Starts Bildschirme dazukommen,
wegfallen und ihre Auflösung ändern: Größe auf die Arbeitsfläche begrenzen,
Position in sie einrasten, und wenn vom gespeicherten Rechteck weniger als
100 px sichtbar wären, die Position fallen lassen — dann zentriert Electron.
Ohne gespeicherten Zustand gilt die Startgröße aus #208 (1536 × 960).

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
| `test/chat-restore-report-dom.test.js` | Was `loadChatForWorkspace()` dem Start meldet ([#208](https://github.com/kkrafft1999/snotra/issues/208)): wiederhergestellte Konversation, leerer Ordner, bloße Begrüßung |

Außerhalb des DOM-Stacks, aber zur selben Strecke: `test/window-state.test.js`
prüft die Fensterentscheidung beim Start (Standardgröße, gemerkter Zustand,
abgezogener Bildschirm) und das Schreiben und Lesen der Zustandsdatei.

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

Seit [#237](https://github.com/kkrafft1999/snotra/issues/237) läuft der
Smoke-Test auch in `ci.yml`, im selben Job wie `npm test`, auf allen drei
Plattformen. Unter Linux fehlt dem Runner eine Anzeige — der Schritt läuft
dort über `xvfb-run --auto-servernum`, macOS und Windows brauchen keinen
Zusatz. Damit prüft die CI beide Testebenen, nicht nur die DOM-Nachbildung,
und das Pflicht-Gate im Ruleset auf `main` deckt tatsächlich ab, was die
Projektregel [`git-workflow.md`](../.claude/rules/git-workflow.md) vor dem
Push verlangt.

## Coverage: ehrlicher Nenner, getrennte Schwellen

`npm run coverage` fährt die Suite mit `--experimental-test-coverage` und
prüft zwei Bereiche gegen eigene Schwellen. Exit-Code 1, wenn einer darunter
liegt.

Stand 2026-09-14 (Node 24):

| Bereich | Dateien im Bericht | Zeilen | Zweige | Funktionen |
| --- | --- | --- | --- | --- |
| Kern (`main`, `application`, `shared`, `preload`) | 119/122 | 95,7 % | 86,0 % | 89,6 % |
| Renderer | 30/31 | 42,1 % | 74,3 % | 58,4 % |

Schwellen (in `scripts/coverage.js`): Kern 94 / 85 / 88, Renderer 41 / 72 / 56.
Sie sind eine **Sperrklinke** — knapp unter dem gemessenen Stand, damit ein
Rückschritt auffällt, ohne dass jede Änderung die Zahl nachzieht. Wer sie senkt,
sagt im Commit warum.

Zwei Dinge daran sind Absicht:

**Der Nenner enthält alle Quelldateien.** Node misst nur, was der Lauf lädt —
eine Datei, die kein Test anfasst, fehlt im Bericht und drückt die Zahl nicht.
Genau daher kam die frühere Angabe von ~94 % Zeilen: Sie beschrieb eine
Auswahl. `test/source-files-load.test.js` lädt deshalb **jede** Datei unter
`src/` (und findet nebenbei kaputte Importpfade in Dateien, die sonst niemand
importiert). Was sich außerhalb von Electron nicht laden lässt, steht mit
Begründung in `scripts/source-files.js` — vier Einstiegspunkte —, und
`npm run coverage` listet sie im Bericht auf, statt sie zu verschweigen. Fehlt
eine Datei ohne Begründung, schlägt der Lauf fehl.

**Die Schwellen sind getrennt.** Der Renderer ist rund ein Drittel des Codes
und aus einem Testlauf heraus schwerer zu erreichen als der Kern; eine
gemeinsame Schwelle müsste sich am schwächeren Teil orientieren und ließe den
Kern verwahrlosen. Die 42 % Zeilen im Renderer sind kein Ziel, sondern der
ehrliche Stand — was dort fehlt, fängt teilweise der Smoke-Test auf einer
anderen Ebene ab.

Coverage ist **kein** CI-Gate: dort läuft `npm test`. Die Schwellen sind eine
lokale Sperrklinke, keine Merge-Bedingung.

## Systemprompt

Der Systemprompt wird pro Anfrage aus fünf Bausteinen zusammengesetzt
(`application/chat/chat-engine.js`), in dieser Reihenfolge:

1. **Basisprompt** aus den Einstellungen — steht vorn und behält den Vorrang.
2. **Gedächtnis-Block** (`application/chat/memory-prompt.js`,
   [#166](https://github.com/kkrafft1999/snotra/issues/166)) — die beiden
   `memory.md`-Dateien aus `<workspace>/.agents` und `~/.snotra`. Er steht
   direkt hinter dem Basisprompt, weil er dasselbe ist: was der Nutzer selbst
   gesagt hat, nur über mehrere Unterhaltungen hinweg — dazwischen soll sich
   nichts Fremdes schieben. Je Ebene höchstens 8.000 Zeichen
   (`MAX_MEMORY_CHARS`), Übergroßes wird sichtbar gekürzt, und jede Ebene
   bekommt eine eigene Zeile in der Kontext-Aufschlüsselung (#174). Je Ebene
   abschaltbar unter Einstellungen › Gedächtnis (Voreinstellung an).
   Geschrieben wird er nur über das Tool `remember`; die Anleitung dazu steht
   im System-Skill `snotra-memory` und wird erst bei Bedarf geladen — Inhalt
   immer, Regelwerk auf Abruf.
3. **Skill-Block** (`buildSkillsSystemPrompt`) — die eingeschalteten Skills;
   sie beschreiben das *Wie*. Im Prompt steht je Skill nur Name und
   Kurzbeschreibung, die Anleitung holt das Modell bei Bedarf mit `load_skill`
   ([#173](https://github.com/kkrafft1999/snotra/issues/173)). Nur zwei Fälle
   stehen sofort voll im Prompt: per `/name` gerufene Skills und der Rückfall,
   wenn es kein `load_skill` gibt.
4. **Environment-Block** (`application/chat/environment-prompt.js`, Issue #138)
   — Arbeitsverzeichnis (absoluter Pfad), Git ja/nein, Plattform,
   Systemversion, die Shell von `shell_execute` und das heutige Datum. Die
   Shell steht nur dort, wenn das Tool eingeschaltet *und* eine Shell gefunden
   ist; ohne offenen Ordner fallen Pfad- und Git-Zeile weg. Bewusst ohne
   Uhrzeit, damit der Block einen Tag lang stabil bleibt und das Prompt-Caching
   der Anbieter nicht bei jeder Nachricht bricht. Abschaltbar über
   „Umgebungsinformationen mitschicken" in den Einstellungen (Voreinstellung
   an) — der absolute Pfad enthält den Benutzernamen und geht an den Anbieter.
5. **Projektanweisungen** (`application/chat/project-instructions-prompt.js`,
   Issue #212, nachgeschärft in #253) — die `AGENTS.md`-Dateien aus
   `<workspace>/.agents`, `~/.snotra` und `~/.agents`, alle vorhandenen
   aneinandergehängt. Sie **ergänzen einander und gelten gemeinsam**; keine
   schlägt eine andere, die Reihenfolge ist deshalb Lese- und keine Rangfolge.
   Es ist dieselbe Quellenliste wie für Skills (#251) — zwei Ordnungen, die
   man getrennt lernen müsste, wären teurer als der eine Gleichlauf. Im
   Projekt zählt allein `.agents/`: Eine `AGENTS.md` in der Ordnerwurzel wird
   nicht gelesen, obwohl sie außerhalb dieses Projekts die verbreitetere Form
   ist. Je Datei höchstens 20.000 Zeichen
   (`MAX_PROJECT_INSTRUCTION_CHARS`, gleich der Grenze für Skill-Bodies),
   Übergroßes wird sichtbar gekürzt statt verworfen, und jede Datei bekommt
   eine eigene Zeile in der Kontext-Aufschlüsselung (#174). Abschaltbar über
   „`AGENTS.md` mitschicken" in den Einstellungen (Voreinstellung an).
6. **Ordner-/Tool-Block** (`buildWorkspaceSystemPrompt`, sonst
   `buildNoWorkspaceSystemPrompt`) — offener Ordner, Tool-Beschreibungen,
   Baumauswahl und die Regel, dass Tool-Ergebnisse Daten sind.

Die Reihenfolge der letzten beiden ist Absicht: Der Inhalt einer `AGENTS.md`
ist **Anweisung, keine Daten** — anders als Tool-Ergebnisse, für die
`TOOL_RESULTS_ARE_DATA_RULE` gilt. Sie soll das Verhalten des Modells ändern,
sonst wäre sie sinnlos; vertretbar ist das, weil der Nutzer den Ordner selbst
geöffnet hat. Genau deshalb steht sie **vor** dem Ordner-/Tool-Block und nicht
dahinter: Die Regel, dass Tool-Ergebnisse Daten sind, soll nicht das Letzte
sein, was eine fremde Anweisungsdatei überschreiben könnte. Die Notbremse ist
der Schalter, nicht die Platzierung.

### Grundausstattung der Tools

Grundsatz seit [#180](https://github.com/kkrafft1999/snotra/issues/180): Was
in Einstellungen › Tools steht, geht an das Modell — und umgekehrt. Sonst
kostet ein Schema in jeder Runde Tokens, das niemand abwählen kann, weil es in
der Liste nicht auftaucht.

`essential: true` ist die eine ausdrückliche Ausnahme
([#195](https://github.com/kkrafft1999/snotra/issues/195)): nur in den
Einstellungen versteckt, immer an das Modell. Die Häkchen des Nutzers greifen
darauf nicht, `requiresWorkspace` und `requiresSkills` weiterhin schon. Die
Gegenrichtung — `internal: true`, vor Nutzer *und* Modell versteckt und nur
aus Tests auslösbar — ist mit
[#203](https://github.com/kkrafft1999/snotra/issues/203) entfallen, nachdem ihr
einziger Träger `debug_wait` weg war
([#197](https://github.com/kkrafft1999/snotra/issues/197)).

Grundausstattung sind `list_directory` und `load_skill`. Beide sind kein
Zusatz, sondern der Zugang zu etwas, das der Nutzer an anderer Stelle schon
eingeschaltet hat — ein Ordner bzw. ein Skill. Abgewaehlt sparten sie ein
kleines Schema und kosteten ein Vielfaches woanders: ohne `load_skill` fällt
der Skill-Block auf den vollen Body jeder Anleitung zurück, ohne
`list_directory` rät das Modell Pfade. Eine Zeile mit Häkchen wäre dort also
kein Sparschalter, sondern eine Falle — deshalb steht sie nicht in der Liste.

Ein **Scratch-Verzeichnis** nennt der Block bewusst *nicht*: die Schreib-Tools
kennen nur den Arbeitsordner als Wurzel, ein Pfad daneben wäre ein Hinweis auf
etwas, das nicht funktioniert.

## Weitere funktionale Module

Das Skill-System ([#18](https://github.com/kkrafft1999/snotra/issues/18)) ist
auf dieser Struktur aufgesetzt: Discovery und Parsing im Main-Service, Auswahl
und Systemprompt-Zusammenbau im Core, Katalog und Umschalter über die
bestehenden Settings-Kanäle. Erweiterte Tool-Sets und Use-Case-Profile sind
**nicht** Teil der abgeschlossenen Architektur-Etappen — sie bauen ebenfalls
darauf auf und werden als
[GitHub Issues](https://github.com/kkrafft1999/snotra/issues) geführt.
