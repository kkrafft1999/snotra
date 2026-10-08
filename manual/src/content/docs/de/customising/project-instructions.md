---
title: Einem Projekt seine Anweisungen geben
description: Schreib in eine AGENTS.md, wie in einem Projekt gearbeitet wird, und Snotra hält sich in jedem Chat dort daran.
sidebar:
  order: 3
---

Jedes Projekt hat seine eigene Arbeitsweise: welcher Paketmanager, welcher Befehl die Tests startet, welche Ordner tabu sind, wie Commit-Messages aussehen. Schreib das in eine Datei namens `AGENTS.md`, und Snotra hält sich in jedem Chat in diesem Ordner daran — ohne dass du es wieder sagen musst.

## Was du brauchst

Eine Textdatei namens `AGENTS.md`. Viele Repositorys haben schon eine; Snotra nutzt sie, wie sie ist.

## Schritte

1. Leg `AGENTS.md` direkt im Projektordner an — ganz oben, nicht in einem Unterordner. Das geht im Baum mit *Neue Datei…*, oder du bittest Snotra, sie zu schreiben.
2. Schreib in klaren Worten oder als Liste auf, was das Modell wissen und einhalten soll. Zum Beispiel:

   ```md
   # Gartenplaner

   - Pflanzen und Beete stehen in pflanzen.csv und beete.json; ihre Spalten nie umbenennen.
   - Den Kalender startest du mit `node src/kalender.js`.
   - Datumsangaben im Format JJJJ-MM-TT.
   ```

3. Speichere sie. Schon die nächste Nachricht nutzt sie.

Für Anweisungen, die in **jedem** Ordner gelten, leg eine `AGENTS.md` in `~/.snotra/` in deinem Benutzerordner ab. Snotra liest außerdem noch `~/.agents/AGENTS.md`, den älteren Ort.

## Was dann passiert

- Snotra liest mit jeder Nachricht bis zu drei Dateien: die `AGENTS.md` des Projekts, dann `~/.snotra/AGENTS.md`, dann `~/.agents/AGENTS.md`. Alle vorhandenen gelten zusammen; keine ersetzt eine andere.
- Änderungen wirken mit der nächsten Nachricht, ohne Neustart.
- Jede Datei trägt bis zu 20.000 Zeichen bei; eine längere wird sichtbar gekürzt, nicht verworfen. Die Aufschlüsselung hinter der Token-Anzeige im Eingabefeld nennt, was jede Datei kostet — siehe [Eine Nachricht schreiben](../../chatting/write-a-message/#sehen-was-eine-anfrage-kostet).
- Bevor eine Datei an den Anbieter geht, lässt Snotra sie weg, wenn sie einen deiner eigenen Schlüssel enthält, und maskiert Zugangsdaten wie Tokens oder `password = …`.

## Anweisungen aus einem Ordner, den du nicht geschrieben hast

Eine `AGENTS.md` soll das Verhalten des Modells ändern — wer einen fremden Ordner öffnet, übernimmt also auch dessen Anweisungen. Um in einem Ordner ohne sie zu arbeiten, schalte *AGENTS.md mitschicken* unter *Einstellungen › Allgemein* aus. Der Schalter gilt für alle drei Orte.

## Wenn es nicht klappt

- **Snotra beachtet die Datei nicht.** Sie muss genau `AGENTS.md` heißen und ganz oben im Ordner liegen. Snotra liest weder `CLAUDE.md` noch `.cursorrules` noch eine `AGENTS.md` unter `.agents/`; schieb eine solche Datei nach oben in den Ordner.
- **Es wird gar nichts mitgeschickt.** *AGENTS.md mitschicken* unter *Einstellungen › Allgemein* ist aus.
