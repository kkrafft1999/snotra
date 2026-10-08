---
title: Dich in den Einstellungen zurechtfinden
description: Die sechs Bereiche der Einstellungen, was sofort wirkt und was erst mit Übernehmen, und was im Bereich Allgemein steht.
sidebar:
  order: 1
---

Alles, was du in Snotra einrichten kannst, steht an einer Stelle: in den Einstellungen. Sie öffnen sich über dem Fenster und lassen deinen Chat, wo er ist.

## Die Einstellungen öffnen

*Snotra Agent › Einstellungen…* auf macOS, *Ansicht › Einstellungen…* auf Windows und Linux, oder `Cmd+,` / `Strg+,`. Einen Knopf im Fenster gibt es dafür bewusst nicht: Ein Knopf in einer Spalte wäre weg, sobald du diese Spalte ausblendest.

## Die sechs Bereiche

| Bereich | Was darin steht |
| --- | --- |
| *Modelle* | Die Modelle, die Snotra im Chat anbietet, mit ihrem Zugang. Siehe [Deine Modelle verwalten](../models/). |
| *Tools & Sicherheit* | Was Snotra im geöffneten Ordner kann und darf. Siehe [Sehen und ändern, was Snotra darf](../../safety/tools-and-security/). |
| *Tool-Einrichtung* | Der Python-Interpreter, der Schlüssel für die Websuche, das Bildmodell und die MCP-Server. Siehe [Die eingebauten Tools einrichten](../built-in-tools/) und [Einen MCP-Server anbinden](../mcp-servers/). |
| *Skills* | Die Skills, mit denen das Modell arbeitet. Siehe [Skills nutzen](../skills/). |
| *Gedächtnis* | Was Snotra über Chats hinweg behält. Siehe [Snotra etwas merken lassen](../memory/). |
| *Allgemein* | Anweisungen für jeden Chat, das Aussehen, die Sprache — siehe unten. |

## Wann eine Änderung wirkt

Die Zeile unten in jedem Bereich sagt es, weil es sich unterscheidet:

- *Modelle* und *Skills* wirken, wenn du auf *Übernehmen* klickst. *Schließen* ohne *Übernehmen* lässt sie, wie sie waren.
- *Tools & Sicherheit* und *Gedächtnis* wirken sofort.
- In der *Tool-Einrichtung* wird ein Schlüssel mit seinem eigenen Knopf gespeichert und ein MCP-Server sofort; Interpreter und Bildmodell warten auf *Übernehmen*.
- Unter *Allgemein* wirken Schalter, Erscheinungsbild und Sprache sofort; die Textfelder warten auf *Übernehmen*.

## Der Bereich Allgemein

![Einstellungen › Allgemein: ein Textfeld für den System-Prompt, die Schalter „Umgebungsinformationen mitschicken“ und „AGENTS.md mitschicken“ und die Wahl zwischen Hell und Dunkel.](screenshots/settings-general.webp)

- ***System-Prompt*** — deine eigenen Anweisungen für jedes Gespräch: eine Rolle, ein Ton, feste Regeln. Geht unverändert an das Modell. Standardmäßig leer; Snotra setzt hier nichts Eigenes.
- ***Umgebungsinformationen mitschicken*** — nennt dem Modell den vollständigen Pfad des geöffneten Ordners (der deinen Benutzernamen enthält), ob es ein Git-Repository ist, deine Plattform, die Shell und das heutige Datum. Ohne das rät das Modell die Plattform für Befehle und datiert „letzte Woche“ nach seinem Trainingsstand. Standardmäßig an.
- ***AGENTS.md mitschicken*** — die Projektanweisungen; siehe [Einem Projekt seine Anweisungen geben](../project-instructions/). Standardmäßig an.
- ***Erscheinungsbild*** — hell oder dunkel. Diese Wahl bleibt auf diesem Rechner.
- ***Sprache der Oberfläche*** — Englisch oder Deutsch, sofort umgestellt. Sie gilt für Fenster und Menüleiste; was an das Modell geht, bleibt Englisch.
- ***Max. Tool-Runden*** — wie oft das Modell nacheinander Tools aufrufen darf, bevor der Chat anhält. Ein Schutz gegen Endlosschleifen; standardmäßig 14, höchstens 500.

## Wo die Einstellungen liegen

In deinem Profilordner, außerhalb der App und außerhalb deiner Projekte: `~/Library/Application Support/Snotra AI` auf macOS, `%APPDATA%\Snotra AI` auf Windows, `~/.config/Snotra AI` auf Linux. Schlüssel liegen dort verschlüsselt. Die Dateien musst du nicht anfassen; alles wird in der App eingestellt.

## Wenn es nicht klappt

- **Eine Änderung wirkt nicht.** Bei *Modelle*, *Skills* und den Textfeldern unter *Allgemein* auf *Übernehmen* klicken.
- ***Einstellungen konnten nicht geladen werden.*** Schließ die Einstellungen und öffne sie noch einmal. Bleibt es dabei, nennt die Meldung die Datei, die sich nicht lesen ließ.
