---
title: Logs finden und ein Problem melden
description: Wo Snotra festhält, was es über einen Lauf, ein Update und seine eigenen Fehler weiß, und wie du das in einen Fehlerbericht bringst, ohne deine Keys preiszugeben.
sidebar:
  order: 4
---

[seit 1.25] Snotra schreibt seine eigenen Warnungen und Fehler in eine Logdatei auf deinem Rechner. Zusammen mit ein paar anderen Stellen — dem Tool-Protokoll im Chat, den Entwicklertools des Fensters und dem Update-Log unter Windows — enthält sie, was ein Fehlerbericht braucht. Diese Seite zeigt, wo was liegt und was du mitschickst, wenn du ein Problem meldest.

## Was du brauchst

Den Chat oder den Dialog, in dem das Problem auftrat, und für eine Meldung ein GitHub-Konto.

## Wo du nachsiehst

| Was schiefging | Wo du nachsiehst |
| --- | --- |
| Ein Hinweis oben im Fenster sagt *Im Hintergrund ist etwas schiefgegangen.* | Snotra hat einen unerwarteten Fehler abgefangen und läuft weiter. Die Einzelheiten stehen in der [Logdatei](#die-logdatei); *Diagnose kopieren* im Hinweis legt in die Zwischenablage, was eine Meldung braucht. |
| Das Fenster ist leer, oder ein Kasten sagt *Das Fenster funktioniert nicht mehr* | Wähl *Fenster neu laden*. Eine Antwort, die gerade noch entstand, ist verloren; gespeicherte Chats bleiben erhalten. Die Logdatei sagt, warum das Fenster aufgehört hat. |
| Eine Antwort im Chat: Ein Tool-Schritt scheiterte, ein Befehl tat nichts, eine Datei wurde nicht geändert | Das Tool-Protokoll über der Antwort und der Kasten *Die Sandbox hat … blockiert* darunter: [Verfolgen, was Snotra tut](../../chatting/follow-the-work/). |
| Das Tool-Protokoll selbst zeigt etwas Seltsames — eine Zeile bleibt leer, ein Schritt fehlt | Drück `Cmd+Shift+D` / `Ctrl+Shift+D`. Snotra kopiert die Tool-Log-Diagnose als JSON in die Zwischenablage und sagt *Tool-Log-Diagnose kopiert*. |
| Ein Fehler vom Anbieter | Der rote Kasten unter deiner Nachricht: [Wenn das Modell einen Fehler meldet](../provider-errors/). |
| Das Fenster zeigt etwas Falsches oder reagiert nicht mehr | Zuerst die Logdatei. Für mehr *Ansicht › Entwicklertools*, der Reiter *Console*: Fehler stehen dort in Rot. |
| Ein Update unter Windows ging nicht durch | `update-install.log` im Profilordner; der Update-Dialog nennt den Pfad. |
| Snotra startet gar nicht | Der Kasten, der das meldet, nennt die Logdatei. Erscheint kein Kasten, starte Snotra aus einem Terminal, siehe unten. |

## Die Logdatei

*Hilfe › Logdatei zeigen* öffnet den Ordner mit dem Log im Finder oder im Explorer, die Datei ist ausgewählt. Der Knopf *Logdatei zeigen* im Hinweis tut dasselbe.

Das Log heißt `main.log` und liegt im Ordner `logs` im [Profilordner](#der-profilordner). Erreicht es 1 MB, wird es zu `main.old.log`, und eine frische `main.log` beginnt. Beide zusammen belegen also nie mehr als etwa 2 MB.

| Das Log enthält | Das Log enthält nie |
| --- | --- |
| Eine Zeile pro Start, mit Version und System | Deine Chats, deine Nachrichten oder die Antworten des Modells |
| Warnungen und Fehler von Snotra selbst | Die Argumente von Tool-Aufrufen oder den Inhalt deiner Dateien |
| Fehler im Fenster, die nichts abgefangen hat, mit ihrem Stacktrace | API-Keys, Tokens oder andere Geheimnisse |
| Pfade von Dateien und Ordnern auf deinem Rechner | — |

Das Log bleibt auf deinem Rechner. Snotra schickt es nirgendwohin; hinaus geht es nur, wenn du es selbst in eine Meldung kopierst.

## Die Diagnose kopieren

*Hilfe › Diagnose kopieren* — oder *Diagnose kopieren* im Hinweis — legt einen kurzen Bericht in die Zwischenablage: die Snotra-Version, dein System, wie viele Fehler seit dem Start abgefangen wurden, und die letzten 200 Zeilen des Logs. Dein Benutzerordner steht darin als `~`, der Bericht nennt also dein Benutzerkonto nicht.

Aus dem Menü bestätigt ein Kasten das Kopieren und bietet *Logdatei zeigen* an. Im Hinweis zeigt der Knopf kurz *Kopiert*.

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

Öffnet sich Snotra nicht oder schließt es sich sofort, ohne einen Kasten, der sagt warum, starte es aus einem Terminal. Es gibt dann aus, was schiefgeht.

- **macOS:**

  ```bash
  "/Applications/Snotra Agent.app/Contents/MacOS/Snotra Agent"
  ```

- **Linux, AppImage oder Tarball:** Starte die Datei in ihrem Ordner, zum Beispiel `./"Snotra Agent"` im entpackten Tarball.

Beende Snotra vorher, falls es noch läuft; ein zweiter Start holt nur das erste Fenster nach vorn.

## Schritte: ein Problem melden

1. Öffne das [Formular für Fehler](https://github.com/kkrafft1999/snotra/issues/new?template=bug_report.yml). *Hilfe › Projekt auf GitHub* führt ebenfalls zum Projekt.
2. Beschreib, was passiert ist, was du vorher getan hast und was du erwartet hattest.
3. Wähl *Hilfe › Diagnose kopieren* und füg das Ergebnis unter *Logs / screenshots* ein. Es nennt auch die Version und dein System.
4. Bei einem Problem mit einer Antwort im Chat drückst du gleich danach `Cmd+Shift+D` / `Ctrl+Shift+D` und fügst auch dieses Ergebnis ein.
5. Häng einen Screenshot an, wo er hilft.

## Was passiert

Die Meldung ist öffentlich. Weder die Diagnose noch die Tool-Log-Diagnose enthalten deine Chats, Dateiinhalte oder die Argumente von Tool-Aufrufen. Wohl aber die Namen von Dateien, Ordnern und Tools, Fehlermeldungen und den Anfang jeder Tool-Zeile. Lies durch, was du einfügst, und nimm heraus, was du nicht öffentlich posten würdest.

## Wenn es nicht klappt

- ***Die Diagnose konnte nicht kopiert werden.*** Die Zwischenablage ließ sich nicht nutzen. Wähl im selben Kasten *Logdatei zeigen*, öffne `main.log` und kopier die letzten Zeilen von dort.
- ***Tool-Log-Diagnose in der Konsole*** statt *kopiert*. Die Zwischenablage ließ sich nicht nutzen. Öffne *Ansicht › Entwicklertools*, Reiter *Console*: Dort liegt die Diagnose zum Kopieren.
- **Der Hinweis kommt immer wieder.** Jeder neue Fehler bringt ihn zurück, nachdem du ihn geschlossen hast; kommen die Fehler laufend, höchstens einmal pro Minute. Etwas funktioniert nicht, wie es soll — kopier die Diagnose und melde es.
- **Das Fenster funktioniert nach dem Neuladen wieder nicht.** Beende Snotra und starte es neu. Passiert es wieder, melde es mit der Diagnose.
- **Füg nie einen Key ein.** Taucht in etwas, das du schicken willst, ein API-Key oder ein Token auf, entfern ihn vorher. Ist doch einer hinausgegangen, widerruf ihn beim Anbieter und leg einen neuen an.
