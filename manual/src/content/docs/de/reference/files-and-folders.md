---
title: Herausfinden, wo Snotra seine Dateien ablegt
description: Der Profilordner mit deinen Einstellungen und Chats, und die Dateien, die Snotra in einem Projekt und in deinem Benutzerordner liest oder schreibt.
sidebar:
  order: 2
---

Snotra legt ab, was dir gehört, an drei Orten: in einem Profilordner für Einstellungen und Chats, im Projektordner, den du geöffnet hast, und in `~/.snotra/` in deinem Benutzerordner. Diese Seite listet, was wo liegt und was du selbst bearbeiten darfst.

## Wo Snotra nachschaut

| Ort | Was dort liegt |
| --- | --- |
| Der Profilordner | Deine Modelle und Schlüssel, deine Einstellungen, deine Chats, deine Berechtigungen. Gehört dir, nicht einem Projekt. |
| `AGENTS.md` und `.agents/` im geöffneten Ordner | Anweisungen, Gedächtnis, Skills und Skill-Daten dieses Projekts. Zieht mit dem Ordner um — und kann in einem Repository landen. |
| `~/.snotra/` in deinem Benutzerordner | Anweisungen, Gedächtnis und Skills für **jeden** Ordner. |
| `~/.agents/` in deinem Benutzerordner | Der ältere Ort für globale Anweisungen und Skills. Wird weiter gelesen. |

## Der Profilordner

| System | Pfad |
| --- | --- |
| macOS | `~/Library/Application Support/Snotra AI` |
| Windows | `%APPDATA%\Snotra AI` |
| Linux | `~/.config/Snotra AI` |

Er trägt noch den Namen der Plattform, Snotra AI, obwohl die App Snotra Agent heißt. Bei der Umbenennung wurde nichts verschoben: siehe [Snotra Agent installieren](../../getting-started/install/).

| Datei | Was sie enthält |
| --- | --- |
| `llm-config.json` | Die Modelle der Liste und wie sie erreichbar sind. Schlüssel liegen verschlüsselt. |
| `ui-preferences.json` | Deine Einstellungen und das Layout: Sprache, der System-Prompt, die Schalter, die Breite der Spalten, der Zoom von Markdown-Dateien, der Python-Interpreter, das Bildmodell. |
| `tool-policy.json` und `tool-policy.key` | Der Modus, deine Sperren und Erlaubnisse, der Standardmodus eines Ordners. Signiert, damit eine veränderte Datei auffällt. |
| `mcp-servers.json` | Die MCP-Server. Geheime Umgebungsvariablen sind verschlüsselt. |
| `web-search-config.json` | Der Schlüssel für die Websuche, verschlüsselt. |
| `chat-history.json` | Deine Chats, verschlüsselt. |
| `chat-attachments/` | Die Bilder, die zu deinen Chats gehören, ein Ordner je Chat. |
| `folder-history.json` und `last-folder.json` | Die zuletzt benutzten Ordner und der, der beim nächsten Start öffnet. |
| `window-state.json` | Größe und Platz des Fensters. |

Alles andere im Ordner — `Cache`, `Local Storage` und Ähnliches — gehört dem Framework und lässt sich in Ruhe.

### Welche du bearbeiten darfst

Fast keine. Alles darin stellst du in der App ein, und die App schreibt die Dateien selbst; eine Änderung hinter ihrem Rücken kann überschrieben werden. Eine Einstellung hat keinen Platz in der App, und eine Datei muss bleiben, wie sie ist:

- **`ui-preferences.json`** nimmt `historyCharLimit` auf, eine Zahl, die die Einstellungen nicht zeigen: das Budget in Zeichen für den Chat-Verlauf, der mit jeder Anfrage geschickt wird (standardmäßig 200.000, 4.000 bis 2.000.000). Ältere Nachrichten darüber hinaus bleiben weg, und große Tool-Ergebnisse früherer Runden werden gekürzt. Beende Snotra, bevor du die Datei bearbeitest.
- **`tool-policy.json`** ist signiert. Bearbeite sie nicht: Snotra fällt dann auf *Intelligent* zurück — oder bleibt bei *Immer fragen* — und verwirft deine Erlaubnisse; deine Sperren bleiben in Kraft. Ändere Berechtigungen stattdessen unter *Einstellungen › Tools & Sicherheit*.

Um bei null anzufangen, beende Snotra und verschiebe den Ordner an eine andere Stelle. Schlüssel und Chats sind dann aus der App verschwunden — leg vorher eine Kopie an.

### Schlüssel und Verschlüsselung

API-Schlüssel, geheime Umgebungsvariablen, der Suchschlüssel und deine Chats sind mit einem Schlüssel des Systems verschlüsselt: unter macOS dem Schlüsselbund-Eintrag *Snotra AI Safe Storage*, unter Windows dem Benutzerkonto, unter Linux dem Schlüsselbund. Eine Kopie des Ordners nützt deshalb auf einem anderen Computer oder in einem anderen Konto nichts, und die Schlüssel müssen dort neu eingegeben werden. Wo das System keinen verschlüsselten Speicher bietet — ein Linux-Desktop ohne Schlüsselbund, zum Beispiel —, sagt Snotra *Verschlüsselter Speicher ist auf diesem System nicht verfügbar*, statt einen Schlüssel zu speichern.

Ändert sich der Schlüssel, wird ein Chat-Verlauf, der sich nicht mehr lesen lässt, nicht gelöscht: Er bleibt als `chat-history.json.undecryptable-<Zeit>` neben dem neuen liegen.

## In einem Projekt

| Was | Wo | Geschrieben von |
| --- | --- | --- |
| Projekt-Anweisungen | `AGENTS.md`, oben im Ordner | dir — siehe [Einem Projekt seine Anweisungen geben](../../customising/project-instructions/) |
| Projektgedächtnis | `.agents/memory.md` | Snotra auf deine Bitte, oder dir — siehe [Snotra etwas merken lassen](../../customising/memory/) |
| Skills des Projekts | `.agents/skills/<name>/SKILL.md` | dir, oder Snotra, wenn du um einen Skill bittest — siehe [Skills nutzen](../../customising/skills/) |
| Was ein Skill aufbewahrt | `.agents/data/` | dem Skill |

Überschreibt Snotra in einem Projekt eine Datei, geht zuvor eine Kopie der alten Fassung in den Papierkorb.

## In deinem Benutzerordner

| Was | Wo |
| --- | --- |
| Anweisungen für jeden Ordner | `~/.snotra/AGENTS.md`, dann `~/.agents/AGENTS.md` |
| Globales Gedächtnis | `~/.snotra/memory.md` |
| Deine eigenen Skills | `~/.snotra/skills/<name>/` und `~/.agents/skills/<name>/` |

Die Skill-Ordner in deinem Benutzerordner sind für jedes Tool schreibgeschützt: Deine eigenen Skills und Anweisungen änderst du selbst, im Dateimanager oder Editor. Das globale Gedächtnis wird geschrieben, wenn du Snotra bittest, sich etwas für jeden Ordner zu merken, und jedes dieser Schreiben fragt vorher.

## Wenn es nicht klappt

- **Nach einer Neuinstallation sind die Einstellungen weg.** Der Profilordner trägt den Namen der Plattform, nicht der App: Such nach `Snotra AI`, nicht nach `Snotra Agent`. Ein Start mit `--user-data-dir` nimmt einen ganz anderen Ordner.
- **Schlüssel werden erneut abgefragt, oder *Key neu eingeben* erscheint.** Der Schlüssel des Systems hat sich geändert — ein neues Benutzerkonto, ein zurückgespieltes Backup, ein neuer Computer. Gib die Schlüssel noch einmal ein.
- **Eine Änderung an `ui-preferences.json` bleibt ohne Wirkung.** Snotra lief vermutlich, als du gespeichert hast, und hat seine eigenen Einstellungen über deine geschrieben. Beende Snotra zuerst.
