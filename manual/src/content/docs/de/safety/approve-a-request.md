---
title: Auf eine Freigabe-Anfrage antworten
description: Was die Freigabekarte im Chat zeigt und was jeder ihrer Knöpfe erlaubt.
sidebar:
  order: 2
---

Braucht ein Tool-Aufruf deine Freigabe, hält Snotra an und zeigt eine Karte im Chat. Der Lauf wartet, bis du entscheidest; es gibt kein Zeitlimit, und kein Knopf ist vorausgewählt. [seit 1.18] Bist du in einer anderen App oder einem anderen Chat, wenn die Karte erscheint, sagt es dir eine Systembenachrichtigung, und ein Klick darauf öffnet den Chat — der Schalter steht unter [*Einstellungen › Allgemein*](../../customising/settings/#der-bereich-allgemein).

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

[seit 1.20] Sobald entschieden ist, klappt die Karte zu einer Zeile zusammen: deine Entscheidung und die Frage, auf die sie antwortet, zum Beispiel *Einmal erlaubt · Snotra möchte `notizen/fruehjahr-2026.md` ändern*. Ein Klick auf die Zeile öffnet die ganze Karte wieder — die Angaben, die Vorschau und was deine Entscheidung bedeutet —, ein zweiter klappt sie wieder zu. [seit 1.21] Die Zeile bleibt bei ihrer Antwort, wenn du die nächste Frage stellst, bis du einen anderen Chat öffnest.

Die Tool-Zeile im Chat zeigt, wie es ausgegangen ist, zum Beispiel *abgelehnt* oder *blockiert*, auch später im Verlauf. Eine Freigabe für die Sitzung erscheint unten auf der Seite *Einstellungen › Tools › Autonomie*, wo du sie widerrufen kannst; ein gemerkter Befehl steht in der Zeile *Ausführen*. Siehe [Sehen und ändern, was Snotra darf](../tools-and-security/).

## Eine Datei außerhalb des geöffneten Ordners

[seit 1.18] Will ein Datei-Tool eine Datei oder einen Ordner außerhalb des geöffneten Ordners lesen oder schreiben — eine Notiz in `~/notizen`, einen Datensatz in `/opt/daten` —, erscheint vor dem Aufruf eine Karte *Außerhalb des Projekts · Freigabe nötig*, in jedem Modus, auch in *Auto*. Sie steht für die Karte oben: eine Karte, mit der Vorschau, wenn etwas geschrieben würde.

1. Sieh nach, welches Tool es ist, welches Ziel und bei einer Änderung die Vorschau.
2. Wähle unter *Freigeben für* genau diese Datei oder diesen Ordner oder den Ordner darum. Ein Ordner, den sich viele Programme teilen, etwa `~/Documents`, wird nur als genau diese Datei angeboten.
3. Wähle unter *Wie lange* *Nur dieser Aufruf* oder *Für diese Sitzung*.
4. Klick auf *Freigeben* — bei einer Änderung *Freigeben und schreiben* — oder auf *Ablehnen*. *Esc* lehnt ebenfalls ab.

Freigegeben läuft der Aufruf mit genau dieser Freigabe; alles andere außerhalb bleibt zu. Für *diese Sitzung* freigegeben erreichen spätere Aufrufe im selben Chat das Ziel ohne diese Karte, und der Modus entscheidet über sie wie im geöffneten Ordner; die Freigabe steht unter *Einstellungen › Tools › Autonomie* bei den Sitzungsfreigaben. Abgelehnt läuft der Aufruf nicht, und das Modell hat die Ansage, nicht auszuweichen; derselbe Aufruf noch einmal beendet den Lauf.

[seit 1.21] Ist der Aufruf durch, weicht die Karte einer einzigen Zeile unter den Tool-Schritten, zum Beispiel *Bei 1 Pfad außerhalb des Projektordners nachgefragt · freigegeben · Datei ~/notizen/todo.md gelesen*. Ein Klick darauf zeigt alles, was die Karte gesagt hat: welches Tool was wollte, den Pfad und was du freigegeben hast, was deine Entscheidung bedeutet und warum Snotra gefragt hat. Die Zeile bleibt beim Chat, auch wenn du ihn später wieder öffnest.

Nie angeboten: dein Home-Ordner als Ganzes, das Wurzelverzeichnis eines Laufwerks, Snotras eigener Speicher, die globalen Skill-Ordner und zum Schreiben Orte mit Zugangsdaten wie `~/.ssh` und Startdateien der Shell wie `.zshrc`. Eine Datei an einem Ort mit Zugangsdaten lässt sich lesen; die Karte markiert sie als *sensibel* und nennt den Anbieter, an den ihr Inhalt ginge.

## Eine Datei, die Snotra in jedem Chat liest

[seit 1.30] Manche Dateien prägen jeden späteren Chat: `AGENTS.md`, das Projektgedächtnis `.agents/memory.md`, die [Regeldateien](../../customising/rules/) in `.agents/rules/` und die Skills in `.agents/skills/`. Eine Änderung daran überdauert den Chat, in dem sie entstand. Deshalb fragt Snotra vor jeder Änderung an ihnen — in jedem Modus, auch in *Auto*, und jede Änderung einzeln: *Für diese Sitzung* wird nicht angeboten, und keine gespeicherte Freigabe deckt sie ab.

- **Ein Datei-Tool will eine schreiben.** Die Karte nennt die Datei und was sie ist — *Regeldatei — Snotra liest sie in jedem Chat in diesem Ordner* — und bei einer Regel mit `always`, dass sie mit jeder Nachricht mitgeht.
- **Ein Befehl hat eine geändert.** `git pull` oder `git checkout` ändern `AGENTS.md` absichtlich, deshalb werden Befehle nicht blockiert. Hat einer eine Wissensdatei geändert, hält Snotra danach an und zeigt *Ein Befehl hat eine Wissensdatei geändert*, mit der Änderung. *Behalten* lässt sie stehen; *Zurücksetzen* stellt wieder her, was vor dem Befehl in den Dateien stand; auch `Esc` setzt zurück. Der Chat wartet auf deine Antwort.
- **Eine Warnung auf der Karte.** Klang früher im Chat ein Tool-Ergebnis wie Anweisungen an den Agenten, oder sah der eigene Text des Ordners so aus, als verschweige er dir etwas, sagt die Karte das. Snotra blockiert die Änderung nicht — prüf, ob du sie willst.

Dein globales Gedächtnis, `AGENTS.md` und die Regeldateien unter `~/.snotra` und `~/.agents` lassen sich mit den Datei-Tools gar nicht schreiben, und ein Befehl in der Sandbox erreicht sie auch nicht; wo ein Befehl ohne Sandbox läuft, deckt die Prüfung nach dem Befehl sie mit ab. Ändern lassen sie sich aus einem Chat heraus, indem du Snotra bittest, sich etwas zu merken.

## Wenn es nicht klappt

- ***Für diese Sitzung erlauben* fehlt.** Das gibt es nur für Lesen, das Lesen sensibler Daten und gewöhnliche Änderungen, und nicht in *Immer fragen*. Überschreiben ohne Rückweg, Befehle und externe Dienste lassen sich nur Aufruf für Aufruf erlauben.
- ***Diesen Befehl immer erlauben* geht nicht.** Die Zeile unter den Knöpfen sagt, warum: Merken lässt sich nur ein einfacher Befehl — ein Programm mit schlichten Argumenten, ohne Verkettung, Pipes, Umleitungen, Variablen oder Anführungszeichen. Außerdem braucht es einen geöffneten Ordner und den verschlüsselten Speicher des Systems.
- **Die Karte sagt *Anfrage verfallen*.** Chat, Ordner, Modus oder eine Regel haben sich geändert, während die Karte offen war. Der Lauf endet; frag noch einmal, wenn du es weiterhin willst.
- **Ein Pfad außerhalb des geöffneten Ordners wird ohne Karte abgelehnt.** Er gehört zu dem, was nie angeboten wird — der Home-Ordner als Ganzes, das Wurzelverzeichnis, Snotras Speicher oder zum Schreiben ein Ort mit Zugangsdaten. Nenne einen Ordner darin, oder öffne diesen Ordner in Snotra.
