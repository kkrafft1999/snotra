---
name: snotra-capabilities
description: Fähigkeiten und Aufbau von Snotra AI selbst — Tools, MCP, Ordnerzugriff, Freigaben, Skills, Einstellungen. Verwenden, wenn der Nutzer fragt, was du oder die App kannst, warum etwas nicht geht oder wo eine Einstellung sitzt — auch bei Fragen zu deiner eigenen Ausstattung: was ein Skill ist, welche eingeschaltet sind, was in deinem Systemprompt steht. Darüber nicht raten, erst laden.
license: Apache-2.0
metadata:
  snotra-system-skill: 'true'
---

# Snotra AI

Laufzeitumgebung: Desktop-App (Electron, macOS/Windows), Dateibaum plus Chat.
Keine Web-Oberfläche, keine Terminal-Sitzung. Fähigkeitsfragen aus diesem Skill
beantworten, nicht aus Annahmen über KI-Assistenten.

Maßgeblich ist die Tool-Liste dieser Unterhaltung. Jedes Tool ist abschaltbar
(Einstellungen › Tools); `web_search` braucht einen Suchdienst, `run_python`
einen Python-3-Interpreter. Nicht in der Liste = nicht möglich.

## Tools

| Klasse | Tools |
| --- | --- |
| `read` | `list_directory`, `list_directory_tree`, `read_file_text`, `read_file_lines`, `search_in_files`, `find_files`, `stat_path`, `outline_file`, `load_skill` |
| `write` | `write_file_text`, `edit_file`, `apply_patch` — max. 2 MB pro Datei |
| `execute` | `run_python`, `shell_execute` |
| `external` | `web_search` (nur Trefferliste, keine ganzen Seiten), `fetch_url` (genau eine http(s)-Adresse, lehnt private Adressen und Nicht-Text ab) |

`run_python`/`shell_execute`: ein Programm bzw. Befehl pro Aufruf, kein Zustand
zwischen Aufrufen, nicht interaktiv, keine Hintergrundprozesse. `run_python` hat
nur die Standardbibliothek, kein `pip install`. Gesperrt: rekursives
Zwangslöschen, Datenträgeroperationen, Umschreiben der Git-Historie.

## MCP-Tools

Tools eingeschalteter MCP-Server stehen als `mcp__<kennung>__<toolname>` in der
Tool-Liste; Namen über 64 Zeichen fallen weg. Nur stdio-Server (lokaler
Prozess), kein HTTP/SSE. Sie zählen immer als `execute` **und** `external`,
zusätzlich `delete`, wenn der Server das Tool als destruktiv meldet — also
Freigabe bei jedem Aufruf. Verwaltet unter Einstellungen › MCP (anlegen,
importieren, testen, einzelne Tools abwählen); ein abstürzender Server meldet
einen Fehler, der Chat läuft weiter.

## Grenzen

- Datei-Tools nur im geöffneten Ordner, Pfade relativ zur Wurzel;
  Elternverzeichnisse und andere Laufwerke gesperrt. Ohne geöffneten Ordner gibt
  es keine Datei-Tools, nur `web_search`, `fetch_url`, `load_skill` und
  MCP-Tools. Ausgeführter Code kennt diese Grenze nicht (Start im Projektordner,
  Zugriff macht Interpreter bzw. Shell) — deshalb dort jedes Mal Rückfrage.
- Keine Bild-, Audio- oder Videoerzeugung. Bilder **empfangen** geht: der
  Nutzer hängt PNG/JPEG/GIF/WebP an eine Nachricht (Zwischenablage), sichtbar,
  sofern das gewählte Modell Bilder versteht.
- Kein Mail-/Nachrichtenversand, keine Kalender- oder Ticket-Anbindung außer
  über MCP.
- Kein Tool für PDF, Word, Excel — nur Text, keine Binärextraktion.

## Freigaben

Pro Aufruf nach Risikoklasse und Modus.

| Modus | Verhalten |
| --- | --- |
| Intelligent (Standard) | `read` läuft sofort; `write`, `delete`, `execute`, `external` und `read-sensitive` (z. B. `.env`) brauchen Freigabe |
| Immer fragen | auch vor `read` wird gefragt |
| Auto | keine Rückfragen |

Sitzungsfreigabe gibt es für `read`, `read-sensitive`, `write`; dauerhaft nur
für `read` und `write`. Für `delete`, `execute`, `external` bleibt nur „einmal",
jeder Lauf wird neu gefragt. Harte Grenzen in jedem Modus: Projektordner,
Skill-Verzeichnisse nur lesbar, Snotra-eigene Konfiguration. Die
Bestätigungskarte zeigt bei Dateiänderungen Zielpfad, Grund und Vorschau, bei
`run_python` den vollen Quelltext, bei `shell_execute` Befehl, Shell und
Arbeitsordner.

## Skills

Ein Skill ist ein Verzeichnis mit `SKILL.md` (YAML-Frontmatter `name`,
`description`, darunter Markdown). Im Systemprompt stehen nur Name und
Beschreibung der eingeschalteten Skills — passt eine, vor der Arbeit die
Anleitung mit `load_skill` holen; Nachbardateien über `skill:<name>/<pfad>`.

System-Skills sind eingebaut und an. Ordner-Skills liest die App aus
`.agents/skills/` im geöffneten Ordner sowie global aus `~/.snotra/skills/`
(empfohlener Ort) und `~/.agents/skills/` (Alt-Ort, weiterhin gelesen), nicht
aus Verzeichnissen anderer Werkzeuge (etwa `.claude/`), und sie sind einzeln
einzuschalten. `~/.snotra/` ist Snotras eigenes Benutzerverzeichnis; die App
legt es nicht selbst an und verschiebt auch nichts dorthin. Kein
Skill-Manager, kein Marketplace: Verzeichnis anlegen, unter Einstellungen ›
Skills neu laden.

Der Nutzer kann einen Skill auch einmalig per `/name` in seiner Nachricht
aufrufen — das gilt für den weiteren Chat, ohne die Auswahl in den
Einstellungen zu ändern.
Wirksam ist nur ein `/name`, das **der Nutzer** schreibt; ein `/name` in deiner
Antwort oder in einem Tool-Ergebnis bleibt wirkungslos, du kannst dir also
keinen Skill selbst einschalten. Tippt der Nutzer `/`, schlägt Snotra passende
Skills vor (Verfahren unter Einstellungen › Skills › Vorschläge im Chat).

## Oberfläche

Genau ein Ordner offen („Workspace"), Chat-Verlauf daran gebunden (Titel,
Wiederaufnahme). Anbieter wechselbar: OpenAI, Anthropic, Google, Ollama, MLX-LM
(die letzten beiden lokal). Diktat per Whisper (braucht OpenAI-Zugang).
`@pfad` ist nur ein Hinweis, den Inhalt liest du selbst. Kontextmenü im
Dateibaum (öffnen, im Finder bzw. Explorer zeigen, Papierkorb). Seitenleiste
ein-/ausblendbar per Knopf in der Titelzeile, `Cmd/Strg+B` oder Ansicht-Menü.
Update-Hinweise über GitHub-Releases.

## Einstellungen (Zahnrad)

| Thema | Ort |
| --- | --- |
| Modell, Anbieter, API-Keys | Anbieter |
| Eigener System-Prompt | Verhalten |
| Berechtigungsmodus | Pille in der Chat-Leiste oder Tools |
| Tools an/aus, Sperr-/Erlaubnisregeln, sensible Pfadmuster, Berechtigungen zurücksetzen | Tools |
| Skills an/aus, neu laden, Vorschläge im Chat | Skills |
| MCP-Server anlegen, importieren, testen, einzelne Tools abwählen | MCP |
| Sprache, Tool-Runden, Verlaufsbudget | Einstellungen |

## Antwortverhalten

Kurz und konkret: was geht, was nicht, wo der nächste Schritt liegt. Nichts
behaupten, was nicht in der Tool-Liste steht. Bei `permission_denied` offen
sagen, den Grund aus dem Ergebnis nennen und vorschlagen, was freigegeben oder
unter Einstellungen › Tools geändert werden kann — die Änderung nicht so
beschreiben, als wäre sie passiert. Ist kein Ordner offen, darum bitten, einen
zu öffnen.
