---
title: Feedback senden
description: Erzähl uns aus Snotra heraus von einem Fehler, einer Idee oder etwas, das dir gefällt — was gesendet wird, wo es landet und was du tust, wenn das Senden scheitert.
sidebar:
  order: 7
---

[seit 1.25] Einen Fehler gefunden, fehlt dir etwas, oder gefällt dir, wie etwas funktioniert? Das kannst du sagen, ohne Snotra zu verlassen und ohne GitHub-Konto. Deine Nachricht wird zu einem öffentlichen Issue im [Snotra-Projekt auf GitHub](https://github.com/kkrafft1999/snotra/issues), wo sie gelesen und beantwortet wird.

## Was du brauchst

Eine Internetverbindung. Eine E-Mail-Adresse ist freiwillig.

## Schritte

1. Klick auf die Sprechblase unten in der Seitenleiste, unter den Dateien. Oder wähl *Hilfe › Feedback senden…*.
2. Wähl, worum es geht: *Fehler*, *Idee* oder *Lob*.
3. Schreib deine Nachricht, bis zu 5.000 Zeichen. Bei einem Fehler: was passiert ist und was du stattdessen erwartet hast.
4. Wenn wir dich etwas zurückfragen dürfen, gib deine E-Mail-Adresse ein.
5. Lass *Technische Angaben mitsenden* angehakt, wenn die Version, dein Betriebssystem und der Anbieter des angezeigten Chats mitgehen dürfen. Das Formular zeigt genau, welche Werte das sind.
6. Wähl *Senden*. `Cmd+Enter` / `Strg+Enter` in der Nachricht tut dasselbe.

![Das Feedback-Formular: die Wahl zwischen Fehler, Idee und Lob, eine Nachricht, ein leeres E-Mail-Feld, die angehakten technischen Angaben und der Hinweis, dass die Nachricht veröffentlicht wird.](screenshots/feedback-form.webp)

Das Zahnrad neben der Sprechblase öffnet die [Einstellungen](../../customising/settings/).

## Was dann passiert

Snotra sendet nur, was das Formular zeigt, und erst, wenn du *Senden* wählst: die Art, deine Nachricht, die E-Mail-Adresse, falls du eine eingegeben hast, und die technischen Angaben, falls der Haken gesetzt ist. Chat-Inhalte, Dateien, Dateipfade und Schlüssel werden nie gesendet.

Die Nachricht wird als öffentliches Issue angelegt. Jeder kann es lesen, also lass weg, was du nicht öffentlich schreiben würdest. Deine E-Mail-Adresse steht nicht im Issue: Sie wird getrennt gespeichert, nur für Rückfragen verwendet und nach 180 Tagen gelöscht. Die Einzelheiten stehen in der [Datenschutzerklärung](https://snotra-ai.dev/datenschutz.html#feedback).

Ist die Nachricht angekommen, bedankt sich das Formular und nennt das Issue. *Issue öffnen* zeigt es auf GitHub.

Schließt du das Formular vor dem Senden, bleibt dein Text erhalten, bis du es wieder öffnest oder Snotra beendest.

## Wenn es nicht klappt

- ***Snotra hat den Feedback-Server nicht erreicht.*** Es gibt keine Verbindung, oder eine Firewall oder ein Proxy sperrt `snotra-ai.dev`. Dein Text bleibt im Formular: Versuch es später noch einmal oder nimm einen der beiden Knöpfe unter der Nachricht.
- ***Zu viele Nachrichten von dieser Verbindung.*** Jede Verbindung kann pro Stunde und pro Tag nur ein paar Nachrichten senden. Versuch es später noch einmal oder wähl *Stattdessen auf GitHub öffnen*.
- ***Diese Nachricht wurde heute schon gesendet.*** Derselbe Text ist schon einmal angekommen, das Issue gibt es also. Ändere den Text, wenn du etwas ergänzen wolltest.
- **Das Senden scheitert immer wieder.** Wähl *Text kopieren*, um die Nachricht mitzunehmen, oder *Stattdessen auf GitHub öffnen*: Das öffnet das Issue-Formular von GitHub mit deiner Nachricht darin. Dieser Weg braucht ein GitHub-Konto. Eine sehr lange Nachricht wird dort gekürzt; füg den kopierten Text ein, um sie zu vervollständigen.
- **Du willst Logs mitschicken.** Das Formular schickt bewusst keine mit. Nimm dafür [Logs finden und ein Problem melden](../logs-and-reports/).
