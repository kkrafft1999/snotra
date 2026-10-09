---
title: Logs finden und ein Problem melden
description: Wo Snotra festhält, was es über einen Lauf, ein Update und seine eigenen Fehler weiß, und wie du das in einen Fehlerbericht bringst, ohne deine Keys preiszugeben.
sidebar:
  order: 4
---

Snotra schreibt keine laufende Log-Datei. Was es über ein Problem weiß, steht stattdessen an ein paar Stellen: im Tool-Protokoll im Chat, in einer Diagnose-Kopie, die du einfügen kannst, in den Entwicklertools des Fensters und — für ein Update unter Windows — in einem Log im Profilordner. Diese Seite zeigt, wo was liegt und was du mitschickst, wenn du ein Problem meldest.

## Was du brauchst

Den Chat oder den Dialog, in dem das Problem auftrat, und für eine Meldung ein GitHub-Konto.

## Wo du nachsiehst

| Was schiefging | Wo du nachsiehst |
| --- | --- |
| Eine Antwort im Chat: Ein Tool-Schritt scheiterte, ein Befehl tat nichts, eine Datei wurde nicht geändert | Das Tool-Protokoll über der Antwort und der Kasten *Die Sandbox hat … blockiert* darunter: [Verfolgen, was Snotra tut](../../chatting/follow-the-work/). |
| Das Tool-Protokoll selbst zeigt etwas Seltsames — eine Zeile bleibt leer, ein Schritt fehlt | Drück `Cmd+Shift+D` / `Ctrl+Shift+D`. Snotra kopiert die Tool-Log-Diagnose als JSON in die Zwischenablage und sagt *Tool-Log-Diagnose kopiert*. |
| Ein Fehler vom Anbieter | Der rote Kasten unter deiner Nachricht: [Wenn das Modell einen Fehler meldet](../provider-errors/). |
| Das Fenster zeigt etwas Falsches oder reagiert nicht mehr | *Ansicht › Entwicklertools*, der Reiter *Console*. Fehler stehen dort in Rot. |
| Ein Update unter Windows ging nicht durch | `update-install.log` im Profilordner; der Update-Dialog nennt den Pfad. |
| Snotra startet gar nicht | Starte es aus einem Terminal, siehe unten; was es dort ausgibt, sagt warum. |

## Der Profilordner

Einstellungen, Chats und Berechtigungen liegen außerhalb der App, in einem Ordner, der den Namen der Plattform trägt:

| System | Profilordner |
| --- | --- |
| macOS | `~/Library/Application Support/Snotra AI` |
| Windows | `%APPDATA%\Snotra AI` |
| Linux | `~/.config/Snotra AI` |

Unter macOS drückst du im Finder `Cmd+Shift+G` und fügst den Pfad ein; unter Windows fügst du ihn in die Adressleiste des Explorers ein.

Der Ordner enthält auch deine verschlüsselten Keys und Chats. Schick nicht den Ordner oder alle seine Dateien: Such das eine Log heraus, das du brauchst.

## Snotra aus einem Terminal starten

Öffnet sich Snotra nicht oder schließt es sich sofort, starte es aus einem Terminal. Es gibt dann aus, was schiefgeht.

- **macOS:**

  ```bash
  "/Applications/Snotra Agent.app/Contents/MacOS/Snotra Agent"
  ```

- **Linux, AppImage oder Tarball:** Starte die Datei in ihrem Ordner, zum Beispiel `./"Snotra Agent"` im entpackten Tarball.

Beende Snotra vorher, falls es noch läuft; ein zweiter Start holt nur das erste Fenster nach vorn.

## Schritte: ein Problem melden

1. Öffne das [Formular für Fehler](https://github.com/kkrafft1999/snotra/issues/new?template=bug_report.yml). *Hilfe › Projekt auf GitHub* führt ebenfalls zum Projekt.
2. Beschreib, was passiert ist, was du vorher getan hast und was du erwartet hattest.
3. Gib die Version an — unten in den Einstellungen, neben *Nach Updates suchen* — und dein System.
4. Bei einem Problem mit einer Antwort im Chat drückst du gleich danach `Cmd+Shift+D` / `Ctrl+Shift+D` und fügst das Ergebnis unter *Logs / screenshots* ein.
5. Häng einen Screenshot an, wo er hilft.

## Was passiert

Die Meldung ist öffentlich. Die Diagnose enthält keine Dateiinhalte und keine Argumente der Tool-Aufrufe, wohl aber die Namen von Dateien und Tools und den Anfang jeder Tool-Zeile. Lies durch, was du einfügst, und nimm heraus, was du nicht öffentlich posten würdest.

## Wenn es nicht klappt

- ***Tool-Log-Diagnose in der Konsole*** statt *kopiert*. Die Zwischenablage ließ sich nicht nutzen. Öffne *Ansicht › Entwicklertools*, Reiter *Console*: Dort liegt die Diagnose zum Kopieren.
- **Füg nie einen Key ein.** Taucht in etwas, das du schicken willst, ein API-Key oder ein Token auf, entfern ihn vorher. Ist doch einer hinausgegangen, widerruf ihn beim Anbieter und leg einen neuen an.
