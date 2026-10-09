---
title: Auf eine Freigabe-Anfrage antworten
description: Was die Freigabekarte im Chat zeigt und was jeder ihrer Knöpfe erlaubt.
sidebar:
  order: 2
---

Braucht ein Tool-Aufruf deine Freigabe, hält Snotra an und zeigt eine Karte im Chat. Der Lauf wartet, bis du entscheidest; es gibt kein Zeitlimit, und kein Knopf ist vorausgewählt.

## Was du brauchst

Einen Chat in *Intelligent* oder *Immer fragen* und eine Anfrage des Modells, die eine Freigabe braucht, zum Beispiel eine Änderung an einer Datei. Welche Aufrufe nachfragen, erklärt [Warum Snotra fragt, bevor es handelt](../why-snotra-asks/).

## Was die Karte zeigt

![Eine Freigabekarte mit dem Titel „Änderung bestätigen“: Snotra möchte notizen/fruehjahr-2026.md mit edit_file ändern. Darunter Wirkung, Zieldatei, Grund, Sitzungsumfang und Modus, eine Vorschau der Ersetzung von alt nach neu und die Knöpfe „Einmal erlauben“, „Für diese Sitzung erlauben“ und „Ablehnen“.](screenshots/approval-card.webp)

- **Der Titel** nennt die Art der Anfrage: *Änderung bestätigen*, *Ausführung bestätigen*, *Dateizugriff bestätigen* oder *Externen Zugriff bestätigen*.
- **Die Überschrift** sagt, was Snotra tun möchte, an welchem Ziel und mit welchem Tool.
- **Die Angaben** nennen die Wirkung, jedes Ziel, den Grund der Rückfrage und den Modus. Bei einer sensiblen Datei nennt die Karte den Anbieter, an den der Inhalt ginge. Bei einem Befehl kommen Shell, Arbeitsordner, Netzwerkzugriff und die Angabe dazu, ob der Lauf isoliert ist — siehe [Befehle in der Sandbox ausführen](../sandbox/).
- **Die Vorschau** zeigt genau, was passieren würde: den neuen Inhalt, die Ersetzung von alt nach neu, den Patch, den Python-Quelltext oder den vollständigen Befehl. Zeichen, die man nicht sieht, etwa Richtungsmarken, erscheinen als `⟨U+202E⟩` an ihrer Stelle, mit einer Warnung.

## Schritte

Lies die Karte und wähle dann einen ihrer Knöpfe:

- ***Einmal erlauben*** führt diesen einen Aufruf aus.
- ***Für diese Sitzung erlauben*** führt ihn aus und lässt dasselbe Tool auf genau denselben Zielen für den Rest dieses Chats ohne Rückfrage laufen. Die Zeile *Sitzungsumfang* auf der Karte sagt, was das umfasst. Es endet, wenn du den Chat verlässt, seinen Modus oder eine Regel änderst oder Snotra neu startest.
- ***Diesen Befehl immer erlauben*** erscheint stattdessen auf einer Karte für einen Shell-Befehl. Es merkt sich genau diese Befehlszeile, in diesem Arbeitsordner und mit diesem Netzwerkzugriff, für den geöffneten Ordner. Das Betriebssystem lässt dich das einmal bestätigen. Jede andere Schreibweise des Befehls fragt wieder nach.
- ***Ablehnen*** — oder `Esc` — weist den Aufruf zurück. Das Modell erfährt, dass du Nein gesagt hast, und kann ohne ihn antworten.

## Was dann passiert

Die Tool-Zeile im Chat zeigt, wie es ausgegangen ist, zum Beispiel *abgelehnt* oder *blockiert*, auch später im Verlauf. Eine Freigabe für die Sitzung erscheint unten auf der Seite *Einstellungen › Tools & Sicherheit*, wo du sie widerrufen kannst; ein gemerkter Befehl steht in der Zeile *Ausführen*. Siehe [Sehen und ändern, was Snotra darf](../tools-and-security/).

## Eine Datei außerhalb des geöffneten Ordners

[seit 1.18] Will ein Datei-Tool eine Datei oder einen Ordner außerhalb des geöffneten Ordners lesen oder schreiben — eine Notiz in `~/notizen`, einen Datensatz in `/opt/daten` —, erscheint vor dem Aufruf eine Karte *Außerhalb des Projekts · Freigabe nötig*, in jedem Modus, auch in *Auto*. Sie steht für die Karte oben: eine Karte, mit der Vorschau, wenn etwas geschrieben würde.

1. Sieh nach, welches Tool es ist, welches Ziel und bei einer Änderung die Vorschau.
2. Wähle unter *Freigeben für* genau diese Datei oder diesen Ordner oder den Ordner darum. Ein Ordner, den sich viele Programme teilen, etwa `~/Documents`, wird nur als genau diese Datei angeboten.
3. Wähle unter *Wie lange* *Nur dieser Aufruf* oder *Für diese Sitzung*.
4. Klick auf *Freigeben* — bei einer Änderung *Freigeben und schreiben* — oder auf *Ablehnen*. *Esc* lehnt ebenfalls ab.

Freigegeben läuft der Aufruf mit genau dieser Freigabe; alles andere außerhalb bleibt zu. Für *diese Sitzung* freigegeben erreichen spätere Aufrufe im selben Chat das Ziel ohne diese Karte, und der Modus entscheidet über sie wie im geöffneten Ordner; die Freigabe steht unter *Einstellungen › Tools & Sicherheit* bei den Sitzungsfreigaben. Abgelehnt läuft der Aufruf nicht, und das Modell hat die Ansage, nicht auszuweichen; derselbe Aufruf noch einmal beendet den Lauf. Der Kasten unter den Tool-Schritten hält fest, wie du entschieden hast.

Nie angeboten: dein Home-Ordner als Ganzes, das Wurzelverzeichnis eines Laufwerks, Snotras eigener Speicher, die globalen Skill-Ordner und zum Schreiben Orte mit Zugangsdaten wie `~/.ssh` und Startdateien der Shell wie `.zshrc`. Eine Datei an einem Ort mit Zugangsdaten lässt sich lesen; die Karte markiert sie als *sensibel* und nennt den Anbieter, an den ihr Inhalt ginge.

## Wenn es nicht klappt

- ***Für diese Sitzung erlauben* fehlt.** Das gibt es nur für Lesen, das Lesen sensibler Daten und gewöhnliche Änderungen, und nicht in *Immer fragen*. Überschreiben ohne Rückweg, Befehle und externe Dienste lassen sich nur Aufruf für Aufruf erlauben.
- ***Diesen Befehl immer erlauben* geht nicht.** Die Zeile unter den Knöpfen sagt, warum: Merken lässt sich nur ein einfacher Befehl — ein Programm mit schlichten Argumenten, ohne Verkettung, Pipes, Umleitungen, Variablen oder Anführungszeichen. Außerdem braucht es einen geöffneten Ordner und den verschlüsselten Speicher des Systems.
- **Die Karte sagt *Anfrage verfallen*.** Chat, Ordner, Modus oder eine Regel haben sich geändert, während die Karte offen war. Der Lauf endet; frag noch einmal, wenn du es weiterhin willst.
- **Ein Pfad außerhalb des geöffneten Ordners wird ohne Karte abgelehnt.** Er gehört zu dem, was nie angeboten wird — der Home-Ordner als Ganzes, das Wurzelverzeichnis, Snotras Speicher oder zum Schreiben ein Ort mit Zugangsdaten. Nenne einen Ordner darin, oder öffne diesen Ordner in Snotra.
