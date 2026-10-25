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

![Eine Antwort mit aufgeklapptem Tool-Protokoll: „2 Dateien geschrieben · 2 Dateien gelesen“, darunter die vier Schritte — src/kalender.js und pflanzen.csv gelesen, src/kalender.js und notizen/fruehjahr-2026.md geändert, jede Änderung mit der Zahl hinzugefügter und entfernter Zeilen —, dann die Zeile „Geändert:“ mit kalender.js und fruehjahr-2026.md, der Antworttext und darunter „Antwort in 4,2 Sek.“.](screenshots/tool-log.webp)

- Eine Änderung trägt die Zahl hinzugefügter und entfernter Zeilen, zum Beispiel `+2 −1`.
- Ein Schritt, der nicht lief, sagt warum: *abgelehnt*, wenn du auf der Karte Nein gesagt hast, *blockiert*, wenn eine Regel ihn gestoppt hat, *verfallen*, wenn die Anfrage verfallen ist. Fahr mit der Maus darüber für die Einzelheiten.
- Ein Schritt, der aus einem Skill kommt, nennt den Skill.
- [seit 1.22] Ein Blick in dieses Handbuch heißt *Im Handbuch nach „…“ gesucht* oder *Handbuchseite … gelesen*; zugeklappt zählt er als *1 Blick ins Handbuch*. Die Antwort verlinkt dann die Seite, auf die sie sich stützt; ein Klick auf so einen Link öffnet die Seite im Hilfefenster, in der Fassung für deine installierte Version.

## Wenn die Sandbox etwas gestoppt hat

Wollte ein Befehl oder ein Python-Lauf unter macOS oder Linux an etwas, das die Sandbox verschlossen hält — einen Ordner außerhalb des Projekts, einen Host, der nicht erlaubt war —, erscheint unter dem Tool-Protokoll ein Kasten *Die Sandbox hat … blockiert*. Er listet, was blockiert wurde, wie oft und warum. Meist ist das der Grund, warum ein Befehl auf eine Weise scheiterte, die seine eigene Ausgabe nicht erklärt. [seit 1.18] Bei Schreiben oder Lesen an einem geschützten Ort fragt direkt nach dem Lauf eine Karte, ob du es freigeben und den Befehl wiederholen willst; eine Verbindung zu einem Host, den der Aufruf nicht genannt hat, wartet auf einer Karte auf dich, während der Befehl läuft. Der Kasten sagt danach auch, wie du entschieden hast; [seit 1.21] hast du alles beantwortet, weicht die Karte ihm, und er klappt zu einer Zeile zusammen, die sich per Klick öffnet. Mehr unter [Befehle in der Sandbox ausführen](../../safety/sandbox/).

## Wenn sich ein Ergebnis wie Anweisungen liest

[seit 1.27.1] Mancher Text ist für das Modell geschrieben, nicht für dich: eine Webseite, die sagt *ignoriere alle vorherigen Anweisungen*, eine Datei, die sich als Nachricht von Snotra ausgibt, Zeichen, die du nicht sehen kannst. Enthält ein Tool-Ergebnis so etwas, erscheint unter dem Tool-Protokoll ein Kasten *Ein Tool-Ergebnis liest sich wie Anweisungen an den Agenten*. Er nennt den Schritt, sagt, welche Art Text er gefunden hat, und zitiert ihn.

![Eine Antwort, deren Tool-Protokoll „1 Datei gelesen“ zeigt. Darunter ein Kasten: „Ein Tool-Ergebnis liest sich wie Anweisungen an den Agenten · Datei notizen/saatgut-katalog.md gelesen“, die Art „Fordert den Agenten auf, seine Vorgaben zu ignorieren“ mit dem zitierten Satz aus der Datei, ein Hinweis, dass sich an dem, was der Agent darf, nichts geändert hat, und der Link „Was diese Prüfung macht“. Danach die Antwort, die sagt, dass sie die Bitte in der Datei nicht befolgt hat.](screenshots/injection-flag.webp)

An dem, was Snotra darf, hat sich nichts geändert: Der nächste Tool-Aufruf wird geprüft wie jeder andere, Karten und Sandbox gelten wie bisher. Sieh dir genau an, was es als Nächstes vorschlägt — einen Befehl, mit dem du nicht gerechnet hast, eine Datei, die mit der Aufgabe nichts zu tun hat, eine Adresse, die du nicht kennst. Kommt dir etwas seltsam vor, lehne die Karte ab oder stoppe den Lauf. Warum der Kasten in beide Richtungen danebenliegen kann: [Warum Snotra fragt, bevor es handelt](../../safety/why-snotra-asks/#wenn-ein-tool-ergebnis-nach-anweisungen-aussieht).

## Wie lange eine Antwort gedauert hat

[seit 1.27.5] Unter jeder fertigen Antwort steht in einer kleinen Zeile, wie lange sie gedauert hat: *Antwort in 4,2 Sek.*, *Antwort in 3:05 Min.* Die Zeit läuft ab dem Absenden deiner Nachricht, bis die Antwort fertig ist — Nachdenken, Tool-Schritte und der Text zählen mit, ebenso die Zeit, in der eine Karte auf deine Entscheidung gewartet hat. Ein Lauf, den du gestoppt hast, zeigt *Abgebrochen nach …*; einer, der mit einem Fehler endete, trägt *Fehlgeschlagen nach …* unter dem Fehler. Fährst du mit der Maus über die Zeile, steht dort, was sie misst. Die Dauer bleibt bei der Antwort und ist auch da, wenn du den Chat wieder öffnest.

## Was dann passiert

Das Tool-Protokoll bleibt bei der Antwort, auch im Chat-Verlauf. Dateien, die Snotra gelesen oder geändert hat, sind außerdem im Dateibaum markiert, und die Zeile *Geändert:* unter dem Protokoll führt zu jeder Änderung: [Sehen, was Snotra geändert hat](../review-changes/).

## Wenn es nicht klappt

- **Eine Antwort hat kein Tool-Protokoll.** Das Modell hat aus dem geantwortet, was es schon wusste, ohne ein Tool zu benutzen.
- **Unter einer Antwort steht keine Zeit.** Sie stammt aus einer Version vor 1.28, oder Snotra wurde geschlossen oder neu geladen, bevor sie fertig war — dann sind nur die abgeschlossenen Schritte erhalten, aber keine Zeit.
- **Du willst ein Problem mit einem Lauf melden.** `Cmd+Shift+D` / `Strg+Shift+D` kopiert die Diagnose des Tool-Protokolls in die Zwischenablage, fertig zum Einfügen in einen Fehlerbericht.
