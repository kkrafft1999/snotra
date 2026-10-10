---
title: Einen Ordner öffnen
description: Wähle den Ordner, in dem Snotra Agent arbeitet, wechsle zwischen Ordnern und starte den ersten Chat darüber.
sidebar:
  order: 4
---

Snotra arbeitet immer in einem Ordner: einem Code-Projekt, einer Sammlung von Dokumenten, deinen Notizen. Es liest und schreibt in diesem Ordner, und der Dateibaum links zeigt ihn die ganze Zeit.

## Was du brauchst

Einen Ordner auf deinem Rechner, an dem du arbeiten willst. Jeder Ordner geht; einer mit einer `README.md` gibt ein gutes erstes Gespräch.

## Schritte

1. Klick auf der Willkommensseite auf *Ordner öffnen*.
2. Wähl den Ordner im Dialog aus und bestätige.

Einen Ordner, den du schon einmal geöffnet hast, findest du auf der Willkommensseite unter *zuletzt geöffnet*; ein Klick öffnet ihn wieder.

Später wechselst du, indem du oben in der Seitenleiste auf den Namen des Ordners klickst. Das Menü zeigt die Ordner, die du zuletzt geöffnet hast; wähl einen davon oder *Ordner öffnen …* für einen neuen.

![Die linke obere Ecke des Fensters mit geöffnetem Ordner-Menü: unter „Zuletzt geöffnete Ordner“ der Ordner gartenplaner mit seinem Pfad, darunter „Ordner öffnen …“.](screenshots/switch-folder.webp)

## Was dann passiert

- Links erscheint der **Dateibaum** des Ordners — eine ausgeblendete Seitenleiste kommt dafür zurück. Versteckte Dateien wie `.gitignore` bleiben ausgeblendet, bis du sie mit `Cmd+Shift+.` / `Strg+Shift+.` einblendest.
- Hat der Ordner eine `README.md`, öffnet sie sich in der **mittleren Spalte**. Sonst bleibt die mittlere Spalte zu, und der Chat bekommt den Platz — siehe [Dich im Fenster zurechtfinden](../../workspace/the-window/).
- Der **Chat** rechts begrüßt dich mit dem Namen des Ordners. Ab jetzt arbeitet er in diesem Ordner.
- Snotra merkt sich den Ordner und öffnet ihn beim nächsten Start wieder.

![Das Snotra-Fenster mit geöffnetem Ordner: links der Dateibaum eines Projekts, in der Mitte seine README, rechts ein Chat, in dem Snotra die README gelesen und das Projekt zusammengefasst hat.](screenshots/overview.webp)

## Den ersten Chat beginnen

Tipp eine Frage ins Eingabefeld und drück `Enter`; mit `Shift+Enter` beginnst du eine neue Zeile. *Was liegt in diesem Ordner?* ist eine gute erste Frage.

Solange die Willkommensseite in der Mitte steht, sind ihre Schnellstart-Vorschläge ein weiterer Einstieg: *Repo-Struktur erklären*, *Code-Review starten*, *Tests vorschlagen* und *Doku zusammenfassen* schreiben je eine Anfrage in den Chat und schicken sie ab, sobald ein Ordner offen und ein Modell angebunden ist.

Um zu antworten, liest Snotra Dateien im Ordner von selbst. Bevor es dort etwas ändert, anlegt oder löscht, fragt es dich. So arbeitet der Standardmodus *Intelligent*, den die Pille unter dem Eingabefeld anzeigt; die anderen erklärt [Einen Modus wählen](../../safety/choose-a-mode/).

## Wenn es nicht klappt

- **Der Dateibaum bleibt leer.** Der Ordner ist leer oder enthält nur versteckte Dateien. Blende sie mit `Cmd+Shift+.` / `Strg+Shift+.` ein.
- **Der Senden-Knopf bleibt gesperrt.** Es ist noch kein Modell angebunden: siehe [Ein Modell anbinden](../connect-a-model/).
- **Das Menü zeigt einen Ordner, den du nicht mehr brauchst.** Geh mit den Pfeiltasten zu ihm und drück `Entf` oder die Rücktaste, um ihn aus der Liste zu nehmen. Der Ordner selbst bleibt unangetastet.
