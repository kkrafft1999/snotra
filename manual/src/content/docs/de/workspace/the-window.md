---
title: Dich im Fenster zurechtfinden
description: Die vier Spalten des Snotra-Fensters, die Schalter, die sie ein- und ausblenden, und was die mittlere Spalte zeigt, wenn du einen Ordner öffnest.
sidebar:
  order: 1
---

Das Snotra-Fenster hat bis zu vier Spalten nebeneinander: den Dateibaum, die Vorschau, den Chat und den Chat-Verlauf. Welche davon du siehst, entscheidest du.

![Das Snotra-Fenster: links der Dateibaum eines Projekts, in der Mitte seine README, rechts ein Chat, in dem Snotra die README gelesen und das Projekt zusammengefasst hat.](screenshots/overview.webp)

## Die vier Spalten

| Spalte | Was darin steht |
| --- | --- |
| **Seitenleiste** | Name und Pfad des geöffneten Ordners und sein Dateibaum. Siehe [Im Dateibaum arbeiten](../file-tree/). |
| **Mittlere Spalte** | Die Vorschau der Datei, die du gewählt hast, oder die Willkommensseite. Siehe [Eine Datei ansehen](../preview/). |
| **Chat** | Das Gespräch, unten mit dem Eingabefeld. Siehe [Eine Nachricht schreiben](../../chatting/write-a-message/). |
| **Verlauf** | Deine früheren Chats. Siehe [Einen früheren Chat fortsetzen](../../chatting/chat-history/). |

Die Titelleiste nennt in jedem Layout zuerst den geöffneten Ordner, und auch der Fenstertitel trägt ihn — so zeigen Dock, Fenstermenü und App-Umschalter, welcher Ordner das ist.

## Eine Spalte ein- und ausblenden

Jede Spalte hat ihren eigenen Schalter in der Titelleiste, alle vier mit demselben Bild eines Fensters, in dem der Teil ausgefüllt ist, den sie steuern:

- Links *Seitenleiste einblenden* / *ausblenden* und *Mittlere Vorschau einblenden* / *ausblenden*.
- Rechts, gespiegelt, *Chat einblenden* / *ausblenden* und *Chat-Verlauf einblenden* / *ausblenden*.

`Cmd+B` / `Strg+B` oder *Ansicht › Seitenleiste ein-/ausblenden* blenden die Seitenleiste ebenfalls ein und aus. Eine Spalte kommt von selbst zurück, wenn du sie brauchst: Ein Klick auf eine Datei im Baum öffnet die mittlere Spalte, ein Klick auf einen Chat im Verlauf öffnet den Chat.

Die Breite einer Spalte änderst du, indem du die Linie zwischen zwei Spalten ziehst. Mit der Tastatur fokussierst du die Linie und nimmst `←` und `→`, mit `Shift` für größere Schritte, und `Pos1` / `Ende` für ihre Endstellungen.

## Was die mittlere Spalte zeigt, wenn du einen Ordner öffnest

- **Der Ordner hat eine `README.md`:** Die mittlere Spalte geht auf und zeigt sie, formatiert — worum es im Projekt geht, bevor du fragst. Das passiert jedes Mal, wenn du einen Ordner öffnest oder zu ihm wechselst.
- **Er hat keine:** Die mittlere Spalte bleibt zu, und der Chat bekommt den Platz.
- **Du landest in einem Chat, den du verlassen hast:** Nach einem Neustart holt Snotra den jüngsten Chat des Ordners zurück, und die mittlere Spalte bleibt zu, damit das Gespräch den Platz hat.
- **Du hast den Schalter benutzt:** Sobald du die mittlere Spalte mit ihrem Schalter ein- oder ausgeblendet hast, gilt diese Wahl, auch beim nächsten Start.

Die README wird angezeigt, nicht ausgewählt; der Baum bleibt, wie er war. Ist gar kein Ordner geöffnet, steht in der mittleren Spalte die Willkommensseite.

## Was dann passiert

Der Zustand jeder Spalte, ihre Breite und das Fenster selbst — Größe, Position, ob es maximiert oder im Vollbild war — kommen beim nächsten Start zurück. Stand das Fenster zuletzt auf einem Bildschirm, der nicht mehr angeschlossen ist, kommt es mittig auf dem Hauptbildschirm zurück.

## Wenn es nicht klappt

- **Die Verlaufsspalte verschwindet.** Das Fenster ist zu schmal für alle vier Spalten; der Verlauf weicht und kommt zurück, sobald Platz ist.
- **Die README geht nicht auf.** Nur eine Datei namens `README.md` direkt im Ordner zählt — keine `README.txt`, keine in einem Unterordner —, und nur, wenn du die mittlere Spalte nicht ausgeschaltet hast.
