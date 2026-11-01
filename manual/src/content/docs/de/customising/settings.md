---
title: Dich in den Einstellungen zurechtfinden
description: Die sechs Bereiche der Einstellungen, was sofort wirkt und was erst mit Übernehmen, und was im Bereich Allgemein steht.
sidebar:
  order: 1
---

Alles, was du in Snotra einrichten kannst, steht an einer Stelle: in den Einstellungen. Sie öffnen sich über dem Fenster und lassen deinen Chat, wo er ist.

## Die Einstellungen öffnen

*Snotra Agent › Einstellungen…* auf macOS, *Ansicht › Einstellungen…* auf Windows und Linux, oder `Cmd+,` / `Strg+,`. [seit 1.25] Oder klick auf das Zahnrad unten in der Seitenleiste, neben dem Knopf für [Feedback](../../troubleshooting/send-feedback/). Menü und Tastenkürzel bleiben, wenn du die Seitenleiste ausblendest.

## Die Bereiche

| Bereich | Was darin steht |
| --- | --- |
| *Modelle* | Die Modelle, die Snotra im Chat anbietet, mit ihrem Zugang. Siehe [Deine Modelle verwalten](../models/). |
| *Tools › Autonomie* | Wie selbstständig Snotra im geöffneten Ordner handelt, und mit welchen Tools. Siehe [Sehen und ändern, was Snotra darf](../../safety/tools-and-security/). |
| *Tools › Sicherheit* | [seit 1.26] Die Sandbox jedes Workspace und was Befehle und Python-Läufe darüber hinaus erreichen dürfen. Siehe [Befehle in der Sandbox ausführen](../../safety/sandbox/#die-sandbox-einrichten). |
| *Tools › Einrichtung* | Der Python-Interpreter, der Schlüssel für die Websuche, das Bildmodell und die MCP-Server. Siehe [Die eingebauten Tools einrichten](../built-in-tools/) und [Einen MCP-Server anbinden](../mcp-servers/). |
| *Wissen* | [seit 1.30] Was Snotra in jedem Chat liest: *Abläufe* (die Skills), *Regeln*, *Fakten* (das Gedächtnis), *AGENTS.md* und *Letzte Änderungen* — die von Snotra und die aus einem Hinweis — mit ihrem Rückgängig. Siehe [Skills nutzen](../skills/), [Snotra etwas merken lassen](../memory/) und [Einem Projekt seine Anweisungen geben](../project-instructions/). |
| *Allgemein* | Anweisungen für jeden Chat, das Aussehen, die Sprache — siehe unten. |

[seit 1.26] *Autonomie*, *Sicherheit* und *Einrichtung* stehen zusammen unter der Überschrift *Tools*; die Überschrift selbst ist kein Bereich.

[seit 1.19] Das `?` oben neben dem Namen des Bereichs und neben vielen Überschriften darin öffnet dieses Handbuch auf der Seite und an dem Abschnitt, um die es dort geht — in dem Fenster, das [Das Handbuch in Snotra](../../#das-handbuch-in-snotra) beschreibt.

## Wann eine Änderung wirkt

Die Zeile unten in jedem Bereich sagt es, weil es sich unterscheidet:

- *Modelle* und die Häkchen unter *Wissen › Abläufe* wirken, wenn du auf *Übernehmen* klickst. *Schließen* ohne *Übernehmen* lässt sie, wie sie waren.
- *Tools › Autonomie*, *Tools › Sicherheit* und der Rest von *Wissen* wirken sofort.
- Unter *Tools › Einrichtung* wird ein Schlüssel mit seinem eigenen Knopf gespeichert und ein MCP-Server sofort; Interpreter und Bildmodell warten auf *Übernehmen*.
- Unter *Allgemein* wirken Schalter, Erscheinungsbild und Sprache sofort; die Textfelder warten auf *Übernehmen*.

## Der Bereich Allgemein

![Einstellungen › Allgemein: ein Textfeld für den System-Prompt, der Schalter „Umgebungsinformationen mitschicken“ und die Wahl zwischen Hell, Dunkel und System.](screenshots/settings-general.webp)

- ***System-Prompt*** — deine eigenen Anweisungen für jedes Gespräch: eine Rolle, ein Ton, feste Regeln. Geht unverändert an das Modell. Standardmäßig leer; Snotra setzt hier nichts Eigenes.
- ***Umgebungsinformationen mitschicken*** — nennt dem Modell den vollständigen Pfad des geöffneten Ordners (der deinen Benutzernamen enthält), ob es ein Git-Repository ist, deine Plattform, die Shell und das heutige Datum. Ohne das rät das Modell die Plattform für Befehle und datiert „letzte Woche“ nach seinem Trainingsstand. Standardmäßig an.
- ***Erscheinungsbild*** — *Hell*, *Dunkel* oder [seit 1.26] *System*: Snotra folgt dann der hellen oder dunklen Einstellung von macOS, Windows oder Linux und wechselt mit, während es offen ist. Voreingestellt ist *Hell*. Diese Wahl bleibt auf diesem Rechner.
- ***Sprache der Oberfläche*** — Englisch oder Deutsch, sofort umgestellt. Sie gilt für Fenster und Menüleiste; was an das Modell geht, bleibt Englisch.
- ***Benachrichtigen, wenn Snotra auf deine Freigabe wartet*** — [seit 1.18] eine Systembenachrichtigung, wenn eine Freigabekarte wartet, während Snotra im Hintergrund ist oder die Karte in einem anderen Chat steht. Sie nennt den Chat und was wartet; ein Klick holt Snotra mit diesem Chat nach vorn. Standardmäßig an.
- ***Beim Start nach Updates suchen*** — [seit 1.24] fragt ein paar Sekunden nach jedem Start bei GitHub nach einer neueren Version und öffnet den Update-Dialog, wenn es eine gibt. Ausgeschaltet sucht Snotra nur, wenn du selbst nachfragst; siehe [Snotra Agent aktualisieren](../../updating/update-snotra/). Standardmäßig an.
- ***Max. Tool-Runden*** — wie oft das Modell nacheinander Tools aufrufen darf, bevor der Chat anhält. Ein Schutz gegen Endlosschleifen; standardmäßig 14, höchstens 500.

## Wo die Einstellungen liegen

In deinem Profilordner, außerhalb der App und außerhalb deiner Projekte: `~/Library/Application Support/Snotra AI` auf macOS, `%APPDATA%\Snotra AI` auf Windows, `~/.config/Snotra AI` auf Linux. Schlüssel liegen dort verschlüsselt. Die Dateien musst du nicht anfassen; alles wird in der App eingestellt.

## Wenn es nicht klappt

- **Eine Änderung wirkt nicht.** Bei *Modelle*, *Wissen › Abläufe* und den Textfeldern unter *Allgemein* auf *Übernehmen* klicken.
- ***Einstellungen konnten nicht geladen werden.*** Schließ die Einstellungen und öffne sie noch einmal. Bleibt es dabei, nennt die Meldung die Datei, die sich nicht lesen ließ.
- **Es erscheint keine Benachrichtigung.** Prüf den Schalter oben und die Mitteilungseinstellungen des Systems für Snotra Agent (unter macOS *Systemeinstellungen › Mitteilungen*). Die Zeile des Chats im Verlauf zeigt *Wartet auf deine Freigabe* ohnehin.
- ***System* bleibt hell (oder dunkel).** Snotra folgt dem, was das System als Vorliebe meldet: unter macOS *Systemeinstellungen › Erscheinungsbild*, unter Windows *Einstellungen › Personalisierung › Farben › Modus auswählen*, unter Linux dem hellen oder dunklen Stil der Arbeitsumgebung (in GNOME *Einstellungen › Darstellung*). Gibt eine Linux-Arbeitsumgebung den Stil nicht an Programme weiter, bleibt Snotra hell; wähl dort *Hell* oder *Dunkel*.
