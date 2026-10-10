---
title: Snotra Agent Handbuch
description: So arbeitest du mit Snotra Agent, dem Open-Source-Desktop-Agenten rund um deinen Ordner.
---

Snotra Agent ist ein Open-Source-Desktop-Agent rund um deinen Ordner. Du öffnest einen Ordner, der Dateibaum bleibt im Blick, und der Chat arbeitet darin. Nichts in diesem Ordner ändert sich, ohne dass Snotra dich vorher fragt. Snotra arbeitet mit Cloud- und lokalen Modellen, braucht kein Konto und sendet keine Telemetrie.

Snotra Agent ist die Desktop-App der Plattform Snotra AI. [seit 1.17] Bis Version 1.16 hieß die App selbst Snotra AI; Einstellungen und Chats wurden unverändert übernommen.

![Das Snotra-Fenster: links der Dateibaum eines Projekts, in der Mitte seine README, rechts ein Chat, in dem Snotra die README gelesen und das Projekt zusammengefasst hat.](screenshots/overview.webp)

Dieses Handbuch erklärt, wie du damit arbeitest: wie du anfängst, wie du mit Dateien und Chats umgehst, wie Snotra entscheidet, was es selbstständig tun darf, und wie du es an deine Bedürfnisse anpasst. Welche Version es beschreibt, steht oben auf jeder Seite neben dem Titel.

## Wo du anfängst

- **Neu bei Snotra:** [Installier es](getting-started/install/), [bind ein Modell an](getting-started/connect-a-model/) und [öffne einen Ordner](getting-started/open-a-folder/). Das Kapitel *Erste Schritte* führt dich vom Download bis zum ersten Chat.
- **Chatten:** [Eine Nachricht schreiben](chatting/write-a-message/), [sehen, was Snotra geändert hat](chatting/review-changes/) und [einen früheren Chat fortsetzen](chatting/chat-history/).
- **Der Arbeitsbereich:** [Dich im Fenster zurechtfinden](workspace/the-window/), [eine Datei finden](workspace/find-a-file/) und [sie ansehen](workspace/preview/).
- **Sicherheit:** [Warum Snotra fragt, bevor es handelt](safety/why-snotra-asks/) und wie du für einen Chat oder Ordner [einen Modus wählst](safety/choose-a-mode/).
- **Anpassen:** [Deine Modelle verwalten](customising/models/), einem Projekt [seine Anweisungen geben](customising/project-instructions/) und [Skills](customising/skills/) oder [MCP-Server](customising/mcp-servers/) dazunehmen.
- **Wenn etwas schiefgeht:** was du bei [einem Fehler des Modells](troubleshooting/provider-errors/) oder [einer Schlüsselbund-Frage](troubleshooting/keychain-and-storage/) tust, und [wie du ein Problem meldest](troubleshooting/logs-and-reports/).
- **Referenz:** jedes [Tastenkürzel](reference/keyboard-shortcuts/), [wo Snotra seine Dateien ablegt](reference/files-and-folders/) und ein [Glossar](reference/glossary/).
- **Download:** Die aktuelle Version für macOS, Windows und Linux findest du auf der [Release-Seite](https://github.com/kkrafft1999/snotra/releases/latest).
- **Probleme und Ideen:** Melde sie als [Issue auf GitHub](https://github.com/kkrafft1999/snotra/issues/new/choose).

## Das Handbuch in Snotra

[seit 1.19] *Hilfe › Snotra-Handbuch* — oder `F1` — öffnet dieses Handbuch in einem eigenen Fenster in Snotra. Es ist die Fassung, die mit deiner Version der App gekommen ist: Sie beschreibt genau das, was du installiert hast, und funktioniert ohne Internetverbindung. Sie folgt der Sprache und dem hellen oder dunklen Erscheinungsbild, das du für Snotra gewählt hast.

- Links stehen die Kapitel; in einem schmalen Fenster liegen sie hinter *Inhalt*. *Auf dieser Seite* rechts springt zu einem Abschnitt.
- **Die Suche** steht über den Kapiteln — oder drück `Cmd+F` / `Strg+F`. Gib ein paar Wörter ein: Die Seiten, auf denen alle vorkommen, treten an die Stelle der Kapitel, jede mit dem Abschnitt und einer Zeile Text um die Fundstelle. Groß- und Kleinschreibung und Akzente spielen keine Rolle. `↑` `↓` wählen einen Treffer, `Enter` öffnet die Seite an diesem Abschnitt, `Esc` bringt die Kapitel zurück. In einem schmalen Fenster öffnet die Lupe neben *Inhalt* die Suche.
- `‹` und `›` gehen in den gelesenen Seiten zurück und vor, mit denselben Tasten wie in der Vorschau: `Cmd+[` und `Cmd+]` auf macOS, `Alt+←` und `Alt+→` unter Windows und Linux.
- `−` und `+` — oder `Cmd` / `Strg` mit `+`, `−` und `0` — machen den Text größer oder kleiner.
- *Im Web öffnen* zeigt dieselbe Seite auf docs.snotra-ai.dev, die immer das neueste Release beschreibt.

## Hilf mit, dieses Handbuch zu verbessern

Auf docs.snotra-ai.dev gibt es unten auf jeder Seite den Link *Seite bearbeiten*. Das Handbuch liegt im selben Repository wie die App, auf Englisch und Deutsch, und Änderungen laufen wie jede andere Änderung über einen Pull Request.
