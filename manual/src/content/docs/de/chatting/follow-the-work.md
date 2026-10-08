---
title: Verfolgen, was Snotra tut
description: Das Tool-Protokoll über jeder Antwort zeigt, welche Dateien Snotra gelesen und geändert und was es ausgeführt hat.
sidebar:
  order: 4
---

Snotra antwortet nicht nur; unterwegs liest es Dateien, ändert sie und führt Befehle aus. Jede Antwort führt ein Protokoll dieser Schritte, damit du siehst, worauf sie beruht.

## Was du brauchst

Einen Chat, in dem Snotra seine Tools benutzt hat — bei den meisten Fragen zum Ordner tut es das.

## Das Tool-Protokoll lesen

Während Snotra arbeitet, erscheinen die Schritte nacheinander über der Antwort: *Datei src/kalender.js gelesen*, *Datei notizen/fruehjahr-2026.md geändert*. Eine Zeile, die noch läuft, zeigt das an; *Modell denkt nach …* steht da, während das Modell seinen nächsten Schritt überlegt.

Ist die Antwort fertig, klappen die Schritte zu einer Zeile zusammen, die sie zählt, etwa *2 Dateien geschrieben · 2 Dateien gelesen*. Ein Klick darauf klappt sie wieder auf.

![Eine Antwort mit aufgeklapptem Tool-Protokoll: „2 Dateien geschrieben · 2 Dateien gelesen“, darunter die vier Schritte — src/kalender.js und pflanzen.csv gelesen, src/kalender.js und notizen/fruehjahr-2026.md geändert, jede Änderung mit der Zahl hinzugefügter und entfernter Zeilen —, dann die Zeile „Geändert:“ mit kalender.js und fruehjahr-2026.md und der Antworttext.](screenshots/tool-log.webp)

- Eine Änderung trägt die Zahl hinzugefügter und entfernter Zeilen, zum Beispiel `+2 −1`.
- Ein Schritt, der nicht lief, sagt warum: *abgelehnt*, wenn du auf der Karte Nein gesagt hast, *blockiert*, wenn eine Regel ihn gestoppt hat, *verfallen*, wenn die Anfrage verfallen ist. Fahr mit der Maus darüber für die Einzelheiten.
- Ein Schritt, der aus einem Skill kommt, nennt den Skill.

## Wenn die Sandbox etwas gestoppt hat

Wollte ein Befehl oder ein Python-Lauf unter macOS oder Linux an etwas, das die Sandbox verschlossen hält — einen Ordner außerhalb des Projekts, einen Host, der nicht erlaubt war —, erscheint unter dem Tool-Protokoll ein Kasten *Die Sandbox hat … blockiert*. Er listet, was blockiert wurde, wie oft und warum. Meist ist das der Grund, warum ein Befehl auf eine Weise scheiterte, die seine eigene Ausgabe nicht erklärt. [seit 1.18] Bei Schreiben oder Lesen an einem geschützten Ort fragt direkt nach dem Lauf eine Karte, ob du es freigeben und den Befehl wiederholen willst; eine Verbindung zu einem Host, den der Aufruf nicht genannt hat, wartet auf einer Karte auf dich, während der Befehl läuft. Der Kasten sagt danach auch, wie du entschieden hast. Mehr unter [Befehle in der Sandbox ausführen](../../safety/sandbox/).

## Was dann passiert

Das Tool-Protokoll bleibt bei der Antwort, auch im Chat-Verlauf. Dateien, die Snotra gelesen oder geändert hat, sind außerdem im Dateibaum markiert, und die Zeile *Geändert:* unter dem Protokoll führt zu jeder Änderung: [Sehen, was Snotra geändert hat](../review-changes/).

## Wenn es nicht klappt

- **Eine Antwort hat kein Tool-Protokoll.** Das Modell hat aus dem geantwortet, was es schon wusste, ohne ein Tool zu benutzen.
- **Du willst ein Problem mit einem Lauf melden.** `Cmd+Shift+D` / `Strg+Shift+D` kopiert die Diagnose des Tool-Protokolls in die Zwischenablage, fertig zum Einfügen in einen Fehlerbericht.
