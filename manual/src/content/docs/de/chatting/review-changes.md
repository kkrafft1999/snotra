---
title: Sehen, was Snotra geändert hat
description: Prüf jede Änderung, die Snotra an deinen Dateien gemacht hat, Zeile für Zeile, aus der Antwort oder aus dem Dateibaum.
sidebar:
  order: 5
---

Bevor Snotra eine Datei ändert, fragt es dich, und die Karte zeigt die Änderung. Danach kannst du dir jede Änderung noch einmal ansehen — im Chat, im Dateibaum und neben der Datei.

## Was du brauchst

Einen Chat, in dem Snotra Dateien geändert hat.

## Schritte

1. Unter der Antwort listet die Zeile *Geändert:* jede Datei, die Snotra darin geändert hat, jeweils mit der Zahl hinzugefügter und entfernter Zeilen.

   ![Eine Antwort mit der Zeile „Geändert:“ und den Dateien kalender.js +2 −1 und fruehjahr-2026.md +2 −1, gefolgt vom Antworttext.](screenshots/changed-files.webp)

2. Klick auf eine Datei. Die Änderung öffnet sich in der mittleren Spalte: entfernte Zeilen mit `−`, hinzugefügte mit `+`, drei unveränderte Zeilen um jede Änderung. *… unveränderte Zeilen anzeigen* klappt den Rest auf.

   ![Die mittlere Spalte mit kalender.js: der Umschalter Inhalt | Änderungen auf Änderungen, die Zahl +2 −1 und die Änderung — die alte Zeile entfernt, ein Kommentar und die neue Zeile hinzugefügt — mit den unveränderten Zeilen drumherum.](screenshots/changes-view.webp)

3. *Inhalt | Änderungen* im Kopf wechselt zwischen der Datei, wie sie ist, und ihrer Änderung. Hat der Chat die Datei mehrmals geändert, lässt dich der Kopf auch eine einzelne Änderung wählen.

## Aus dem Dateibaum

Während Snotra arbeitet, markiert der Baum die Dateien, die es angefasst hat, am rechten Rand der Zeile:

- Ein gefülltes **M** markiert eine Datei, die Snotra geändert und die du noch nicht angesehen hast. Sobald du sie öffnest, bleibt nur der Umriss des M — bis Snotra die Datei wieder ändert.
- Ein graues **R** markiert eine Datei, die Snotra nur gelesen hat.
- Ein geschlossener Ordner trägt die Markierung dessen, was in ihm liegt, damit eine Änderung tief unten nicht verborgen bleibt.

Klick mit der rechten Maustaste auf eine markierte Datei und wähle *Änderungen anzeigen*, um alles zu sehen, was dieser Chat darin geändert hat. Die Markierungen gehören zum Chat: Ein anderer Chat zeigt seine eigenen, ein neuer Chat startet ohne. *Markierung entfernen* im selben Menü entfernt eine; der Radierer oben im Baum entfernt alle.

## Was dann passiert

Die Änderungsansicht zeigt immer, was Snotra geschrieben hat. Hat sich die Datei seitdem wieder geändert — weil du sie bearbeitet hast oder ein anderes Programm —, sagt die Ansicht das über der Änderung.

## Wenn es nicht klappt

- ***Änderungen nicht mehr verfügbar (App neu gestartet).*** Snotra hält die Änderungen nur im Speicher, nie auf der Platte. Nach einem Neustart bleibt die Zeile unter der Antwort, aber die Änderungen selbst sind weg.
- **Die Änderungsansicht zeigt einen Satz statt Zeilen.** Das ist so bei einer neuen Datei, einer Datei, in der sich jede Zeile geändert hat, einer, bei der sich nur die Zeilenenden geändert haben, einer Binärdatei wie einem Bild und einer sehr großen Datei. Der Satz sagt, was davon zutrifft.
