---
title: Auf eine Datei verweisen
description: Nenn eine Datei oder einen Ordner des geöffneten Ordners in deiner Nachricht mit @, getippt, gezogen oder geklickt.
sidebar:
  order: 2
---

Geht es in deiner Frage um eine bestimmte Datei, nenn sie mit `@`: `@notizen/fruehjahr-2026.md`. Dann weiß Snotra genau, welche du meinst, und liest sie, wenn es sie braucht.

## Was du brauchst

Einen geöffneten Ordner. Ohne einen bleibt `@` gewöhnlicher Text.

## Schritte

**Getippt**

1. Tipp `@` ins Eingabefeld. Darüber öffnet sich eine Liste der Dateien und Ordner des geöffneten Ordners.
2. Tipp weiter, um sie einzugrenzen. Die Suche ist unscharf: `@rlse` findet `docs/release.md`.
3. Wähl einen Eintrag mit `↑` und `↓` und übernimm ihn mit `Enter` oder `Tab`. `Esc` schließt die Liste.

![Das Chat-Eingabefeld mit dem Text „Welche Pflanzen aus @pf“, darüber die Liste mit pflanzen.csv und pflanzen.js aus dem Ordner src.](screenshots/mention-list.webp)

Bei einem Ordner bleibt die Liste offen (`@src/`), damit du gleich hineingehen kannst.

**Aus dem Dateibaum**

- Zieh eine Datei oder einen Ordner aus dem Baum ins Eingabefeld. Sie wird dort eingefügt, wo der Cursor steht.
- Oder fahr mit der Maus über eine Zeile im Baum und klick auf den `@`-Knopf an ihrem rechten Rand. Mit der Tastatur tut `Shift+Enter` auf der fokussierten Zeile dasselbe.

Auf beiden Wegen wird der Pfad relativ zum geöffneten Ordner eingefügt, genau wie beim Tippen.

## Was dann passiert

Das Modell bekommt den Pfad in deiner Nachricht, nicht den Inhalt der Datei. Es liest die Datei mit seinen Tools, wenn es sie braucht — so bleibt eine lange Datei aus dem Gespräch, bis sie wichtig wird. Lesen im geöffneten Ordner läuft in *Intelligent* ohne Rückfrage; siehe [Warum Snotra fragt, bevor es handelt](../../safety/why-snotra-asks/).

## Wenn es nicht klappt

- **Die Liste geht nicht auf.** Es ist kein Ordner geöffnet, oder der Cursor steht nicht direkt hinter dem `@`.
- **Eine Datei fehlt in der Liste.** Die Liste lässt aus, was auch die Dateisuche des Modells auslässt: versteckte Dateien, `.git` und alles, was die `.gitignore` des Ordners ausschließt. Versteckte Dateien erscheinen, sobald du sie im Baum mit `Cmd+Shift+.` / `Strg+Shift+.` einblendest.
