---
title: Ein Tastenkürzel finden
description: Alle Tastenkürzel, die Snotra zu den üblichen des Systems dazugibt — im Fenster, im Chat-Eingabefeld, im Dateibaum, in der Vorschau, in Menüs und Dialogen.
sidebar:
  order: 1
---

Kopieren, Einfügen, Rückgängig, Alles auswählen, Vollbild und Minimieren funktionieren wie in jeder anderen App deines Systems und stehen in den Menüs *Bearbeiten*, *Ansicht* und *Fenster*. Diese Seite listet, was Snotra dazugibt. `Cmd` ist die Befehlstaste unter macOS; unter Windows und Linux lies `Strg`.

## Überall im Fenster

Diese Kürzel wirken auch, wenn der Fokus im Chat-Eingabefeld liegt.

| Was es tut | macOS | Windows / Linux | Menü |
| --- | --- | --- | --- |
| Einen neuen Chat beginnen | `Cmd+N` | `Strg+N` | *Ablage › Neuer Chat* (macOS), *Datei › Neuer Chat* |
| Die Einstellungen öffnen | `Cmd+,` | `Strg+,` | *Snotra Agent › Einstellungen…* unter macOS, sonst *Ansicht › Einstellungen…* |
| Die Seitenleiste ein- oder ausblenden | `Cmd+B` | `Strg+B` | *Ansicht › Seitenleiste ein-/ausblenden* |
| Versteckte Dateien im Baum zeigen oder verbergen | `Cmd+Shift+.` | `Strg+Shift+.` | *Ansicht › Versteckte Dateien anzeigen* |
| Den Dateibaum filtern | `Cmd+P` | `Strg+P` | *Ansicht › Dateien filtern…* |
| Zu der Datei zurück, die die Vorschau davor gezeigt hat [seit 1.18] | `Cmd+[` | `Alt+←` | *Ansicht › Zurück* |
| Wieder vor [seit 1.18] | `Cmd+]` | `Alt+→` | *Ansicht › Vor* |
| Eine Markdown- oder SVG-Datei zwischen Vorschau und Quelltext umschalten | `Cmd+Shift+M` | `Strg+Shift+M` | *Ansicht › Preview oder Quelltext* |
| Dieses Handbuch öffnen [seit 1.19] | `F1` | `F1` | *Hilfe › Snotra-Handbuch* |

Versteckte Dateien, *Zurück* und *Vor* folgen der **Taste**, nicht dem Zeichen darauf: `Cmd+Shift+.` funktioniert auch auf einer deutschen Tastatur, auf der `Shift+.` einen Doppelpunkt tippt, und `Cmd+[` und `Cmd+]` wirken auf den Tasten an ihrer Stelle. Die Einstellungen haben bewusst keinen Knopf im Fenster — siehe [Dich in den Einstellungen zurechtfinden](../../customising/settings/).

![Die linke obere Ecke des Fensters mit dem geöffneten ⋯-Menü des Baums: Dateien filtern (⌘P), Neue Datei, Neuer Ordner und Versteckte Dateien anzeigen (⇧⌘.).](screenshots/tree-actions.webp)

Die Menüs zeigen das Kürzel neben jedem Eintrag, wie hier im ⋯-Menü des Baums.

## Im Chat-Eingabefeld

| Was es tut | Tasten |
| --- | --- |
| Die Nachricht senden | `Enter` |
| Eine neue Zeile beginnen | `Shift+Enter` |
| Ein Bild als Anhang einfügen | `Cmd+V` / `Strg+V` |
| In der Liste nach `@` oder `/`: auswählen · übernehmen · schließen | `↑` `↓` · `Enter` oder `Tab` · `Esc` |
| Die Freigabekarte ablehnen, die gerade auf dem Bildschirm steht | `Esc` |
| Die Diagnose des Tool-Protokolls als JSON kopieren, für einen Fehlerbericht | `Cmd+Shift+D` / `Strg+Shift+D` |

`Esc` lehnt eine Freigabekarte nur ab, wenn kein Menü und kein anderes Feld auf die Taste wartet. Keine Schaltfläche einer Karte ist vorausgewählt: siehe [Auf eine Freigabe-Anfrage antworten](../../safety/approve-a-request/). Die Listen sind in [Auf eine Datei verweisen](../../chatting/refer-to-a-file/) und [Skills nutzen](../../customising/skills/) erklärt.

Das Modellmenü und das Modusmenü über dem Eingabefeld nehmen `↑` `↓` zum Bewegen und `Esc` zum Schließen.

## Im Dateibaum

Klick in den Baum oder geh mit `Tab` dorthin. Die ganze Tabelle mit dem, was jede Taste tut, steht in [Im Dateibaum arbeiten](../../workspace/file-tree/#die-tastatur-nutzen).

| Was es tut | Tasten |
| --- | --- |
| Von Zeile zu Zeile · zur ersten oder letzten Zeile | `↑` `↓` · `Pos1` `Ende` |
| Einen Ordner aufklappen · zuklappen | `→` · `←` |
| Die Datei öffnen oder den Ordner auf- oder zuklappen | `Enter` |
| Die Zeile umbenennen | `F2` |
| Die Zeile als `@pfad` ins Chat-Eingabefeld einfügen | `Shift+Enter` |
| Das Kontextmenü öffnen | `Shift+F10` oder `Cmd`-Klick / `Strg`-Klick |
| Den Filter mit einem Buchstaben starten | den Buchstaben tippen |
| Im Filter: auswählen · seitenweise · öffnen · schließen | `↑` `↓` · `Bild↑` `Bild↓` · `Enter` · `Esc` |
| Beim Umbenennen: den Namen übernehmen · alles lassen, wie es war | `Enter` · `Esc` |
| In der Liste der letzten Ordner: öffnen · aus der Liste entfernen | `Enter` oder `Leertaste` · `Entf` oder `Rücktaste` |

## In der Vorschau

| Was es tut | Tasten |
| --- | --- |
| Ein PDF, ein Bild oder eine Markdown-Datei vergrößern · verkleinern · zurück auf die angepasste Größe | `Cmd` und `+` · `Cmd` und `−` · `Cmd` und `0` (`Strg` unter Windows und Linux) |
| In einem PDF: erste Seite · letzte Seite | `Pos1` · `Ende` |

Die Zoom-Tasten wirken auf das Dokument nur, solange die Vorschau den Fokus hat — klick zuerst hinein. Sonst zoomen sie das ganze Fenster, wie *Ansicht › Vergrößern*. Eine Markdown-Datei kehrt mit `Cmd+0` auf 100 % zurück, ein PDF oder ein Bild auf seine angepasste Größe. Der Markdown-Zoom gilt [seit 1.19]. Einzelheiten in [Eine Datei ansehen](../../workspace/preview/).

## Spalten, Menüs und Dialoge

| Was es tut | Tasten |
| --- | --- |
| Einen Spaltentrenner mit Fokus verschieben · in größeren Schritten · ans Ende | `←` `→` · `Shift+←` `Shift+→` · `Pos1` `Ende` |
| In den Einstellungen: voriger oder nächster Bereich · erster oder letzter | `↑` `↓` oder `←` `→` · `Pos1` `Ende` |
| Einen Dialog, ein Menü oder ein vergrößertes Bild schließen | `Esc` |

## Wenn es nicht klappt

- **Ein Kürzel tut nichts.** Schau in der Menüleiste unter *Ansicht*, *Ablage* oder *Bearbeiten*: Das Menü zeigt das Kürzel neben jedem Eintrag. Die, die der physischen Taste folgen — versteckte Dateien, *Zurück*, *Vor* —, stehen dort nur zur Anzeige und werden vom Fenster selbst behandelt.
- **`Cmd` und `+` macht das ganze Fenster größer.** Die Vorschau hatte nicht den Fokus. Klick ins Dokument und drück es noch einmal; *Ansicht › Zoom zurücksetzen* stellt das Fenster zurück.
