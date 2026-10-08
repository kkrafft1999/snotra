---
title: Eine Datei finden
description: Filtere den Dateibaum mit Cmd+P / Strg+P nach Namen und öffne, was du findest, ohne die Tastatur zu verlassen.
sidebar:
  order: 3
---

In einem großen Ordner kommst du am schnellsten zu einer Datei, indem du einen Teil ihres Namens tippst. Der Filter über dem Baum durchsucht jede Datei und jeden Ordner des geöffneten Ordners.

## Was du brauchst

Einen geöffneten Ordner.

## Schritte

1. Drück `Cmd+P` / `Strg+P` — von überall im Fenster, auch aus dem Chat-Eingabefeld. Oder wähle *Dateien filtern* im `⋯`-Menü oben am Baum oder *Ansicht › Dateien filtern…*. Eine geschlossene Seitenleiste geht dabei auf.
2. Tipp einen Teil des Namens. Die Suche ist unscharf: `rlse` findet `docs/release.md`, und `kal` findet `src/kalender.js`.
3. Wähl einen Treffer mit `↑` und `↓` und öffne ihn mit `Enter`, oder klick ihn an.

![Die linke obere Ecke des Fensters mit geöffnetem Filter: „kal“ im Feld, darunter der Treffer kalender.js aus dem Ordner src, die passenden Buchstaben unterstrichen.](screenshots/tree-filter.webp)

Hat der Baum den Fokus, startet schon ein getippter Buchstabe den Filter.

## Was dann passiert

- Sobald im Feld etwas steht, nimmt eine flache Liste der passenden Dateien und Ordner den Platz des Baums ein. Jeder Treffer zeigt den Ordner, in dem er liegt, mit den passenden Buchstaben unterstrichen.
- Eine Datei zu öffnen, zeigt sie in der Vorschau und lässt die Liste für die nächste stehen.
- Einen Ordner zu wählen, schließt den Filter und zeigt den Ordner im Baum, aufgeklappt.
- `Esc` schließt den Filter und bringt den Baum zurück, wie er war, aufgeklappt bis zu dem, was du geöffnet hast.

Der Filter findet dieselben Einträge in derselben Reihenfolge wie `@` im Chat: [Auf eine Datei verweisen](../../chatting/refer-to-a-file/).

## Wenn es nicht klappt

- ***Keine Datei und kein Ordner passt zu …*** Der Filter durchsucht Namen und Pfade, nicht den Inhalt der Dateien. Bitte Snotra im Chat, im Inhalt zu suchen.
- **Eine Datei, die es gibt, taucht nicht auf.** Versteckte Dateien passen nur, solange sie im Baum eingeblendet sind, und der Filter lässt aus, was die `.gitignore` des Ordners ausschließt.
- **Die Liste endet mit *Die ersten … von … Treffern*.** Tipp weitere Buchstaben, um sie einzugrenzen.
