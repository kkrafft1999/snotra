---
title: Eine Nachricht schreiben
description: Schick eine Nachricht ab, brich eine Antwort ab, häng einen Screenshot an, diktiere und sieh nach, was eine Anfrage kostet.
sidebar:
  order: 1
---

Alles, worum du Snotra bittest, geht über das Eingabefeld unten im Chat. Es zeigt außerdem Modell, Modus und die Größe der letzten Anfrage.

## Was du brauchst

Einen geöffneten Ordner und ein angebundenes Modell — siehe [Einen Ordner öffnen](../../getting-started/open-a-folder/) und [Ein Modell anbinden](../../getting-started/connect-a-model/).

## Eine Nachricht abschicken

1. Klick ins Eingabefeld und tipp deine Frage oder Aufgabe.
2. Drück `Enter`, um sie abzuschicken. Mit `Shift+Enter` beginnst du stattdessen eine neue Zeile.

Während Snotra antwortet, wird der Senden-Knopf zum Stopp-Knopf. Ein Klick darauf bricht die Antwort ab; was sie bis dahin getan hat, bleibt getan.

Auf eine bestimmte Datei verweist du mit `@`: [Auf eine Datei verweisen](../refer-to-a-file/).

## Einen Screenshot anhängen

1. Kopier ein Bild in die Zwischenablage — einen Screenshot zum Beispiel (`Cmd+Ctrl+Shift+4` unter macOS, das Snipping Tool unter Windows).
2. Klick ins Eingabefeld und füg es mit `Cmd+V` / `Strg+V` ein.

Das Bild erscheint über der Eingabezeile, mit Vorschau, Größe und einem Knopf zum Entfernen. Du kannst es mit einer Frage oder für sich allein abschicken. PNG, JPEG, GIF und WebP gehen, bis zu vier Bilder pro Nachricht und je 5 MB; größere Bilder werden vor dem Senden verkleinert.

Nicht jedes Modell versteht Bilder. Die Modelle von OpenAI tun es; ein OpenAI-kompatibler Server nur, wenn für ihn unter *Einstellungen › Modelle* *Bild-Anhänge erlauben* eingeschaltet ist. Bei jedem anderen Modell sagt Snotra das, statt das Bild einzufügen. Das Bild gehört zum Chat und ist wieder da, wenn du ihn aus dem Verlauf öffnest.

## Diktieren

1. Klick auf das Mikrofon im Eingabefeld und sprich.
2. Klick noch einmal darauf, um aufzuhören. Snotra schreibt auf, was du gesagt hast, und fügt es ins Eingabefeld ein, wo du es vor dem Abschicken noch ändern kannst.

Das Diktat nutzt die Spracherkennung von OpenAI und braucht einen OpenAI-Schlüssel unter *Einstellungen › Modelle*. Eine Aufnahme hört nach fünf Minuten von selbst auf; eine halbe Minute vorher sagt es die Zeile unter dem Eingabefeld.

## Sehen, was eine Anfrage kostet

Neben dem Senden-Knopf zeigt das Eingabefeld die Größe der letzten Anfrage in Tokens: alles, was das Modell bekommen hat — das Gespräch, die Anweisungen, die Beschreibungen der Tools. Ein Klick darauf zeigt, woraus sie besteht: jeden Skill, die Tools, den Rest der Anweisungen und das Gespräch. Die Summe ist die Zahl des Anbieters; die Teile sind geschätzt.

## Wenn es nicht klappt

- **Der Senden-Knopf bleibt gesperrt.** Es ist kein Modell angebunden, oder dem angebundenen fehlt sein Schlüssel: siehe [Ein Modell anbinden](../../getting-started/connect-a-model/).
- **Ein Bild einzufügen, zeigt nur einen Hinweis.** Das Modell dieses Chats nimmt keine Bilder. Wechsle zu einem, das es tut — [Das Modell wechseln](../model-and-reasoning/) —, oder schalte *Bild-Anhänge erlauben* für einen OpenAI-kompatiblen Server ein, dessen Modell Bilder versteht.
- ***Kein OpenAI-Key hinterlegt (Whisper braucht einen).*** Das Diktat braucht einen OpenAI-Schlüssel, auch wenn der Chat bei einem anderen Anbieter läuft.
