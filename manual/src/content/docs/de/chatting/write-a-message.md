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

Das Bild erscheint über der Eingabezeile, mit Vorschau, Größe und einem Knopf zum Entfernen. Du kannst es mit einer Frage oder für sich allein abschicken. PNG, JPEG, GIF und WebP gehen (Gemini nimmt kein GIF, siehe unten), bis zu vier Bilder pro Nachricht und je 5 MB; größere Bilder werden vor dem Senden verkleinert.

Ob ein Bild mitgeht, hängt am Anbieter, nicht nur am Modell:

- *OpenAI* — ja.
- *OpenAI-kompatibel* — nur, wenn für den Eintrag unter *Einstellungen › Modelle* *Bild-Anhänge erlauben* eingeschaltet ist. Sonst sagt Snotra, dass für diese Verbindung Bild-Anhänge ausgeschaltet sind.
- *Anthropic (Claude)* [seit 1.27] — ja.
- *Google (Gemini)* [seit 1.27] — ja, als PNG, JPEG oder WebP. Gemini nimmt kein GIF; Snotra sagt das, statt das Bild einzufügen.
- *Ollama (lokal)* — noch nicht. Manche Ollama-Modelle verstehen Bilder, aber Snotra kann sie an Ollama noch nicht weiterreichen ([#92](https://github.com/kkrafft1999/snotra/issues/92)). Snotra sagt das, statt das Bild einzufügen.

Die Übersicht je Anbieter steht unter [Modelle](../../customising/models/#die-anbieter).

Das Bild gehört zum Chat und ist wieder da, wenn du ihn aus dem Verlauf öffnest.

## Diktieren

1. Klick auf das Mikrofon im Eingabefeld oder drück `Cmd+D` (`Strg+D` unter Windows und Linux) und sprich.
2. Was du sagst, erscheint schon während des Sprechens im Eingabefeld, dort, wo der Cursor stand — grau und schräg, solange die Aufnahme läuft [seit 1.20]. Ein roter Pegel neben dem Mikrofon zeigt, dass es dich hört, eine Uhr, wie lange die Aufnahme schon läuft.
3. Ein Wort falsch verstanden? Korrigier es gleich: Ein Satz ist fertig, sobald du eine Pause machst, und ab dann kannst du ihn ändern, während du weitersprichst. Nur der Satz, in dem du gerade bist, lässt sich noch nicht bearbeiten.
4. Klick noch einmal auf das Mikrofon oder drück `Cmd+D` / `Strg+D`, um aufzuhören. Snotra schließt den letzten Satz ab, und alles wird zu normalem Text, den du ändern oder abschicken kannst.

![Das Eingabefeld während einer Aufnahme: getippt „Notiz für den Aussaatkalender:“ und dahinter, grau und schräg, die diktierten Sätze. Darunter das rote Mikrofon, ein Pegel, „Aufnahme läuft …“ und die Zeit.](screenshots/dictation.webp)

Während du diktierst, machen die Pillen neben dem Mikrofon und die Token-Anzeige der Aufnahme Platz; beim Stoppen kommen sie zurück. Schickst du die Nachricht ab, endet die Aufnahme, und was diktiert ist, geht mit. Das Kürzel steht auch im Menü, *Bearbeiten › Spracheingabe*.

Das Diktat nutzt die Spracherkennung von OpenAI: Die Aufnahme geht an OpenAI, und das sagt auch der Tooltip des Mikrofons. Es braucht einen OpenAI-Schlüssel unter *Einstellungen › Modelle*, auch wenn der Chat bei einem anderen Anbieter läuft; OpenAI rechnet nach Minuten ab. Eine Aufnahme hört nach fünf Minuten von selbst auf; eine halbe Minute vorher sagt es die Zeile neben dem Mikrofon.

Ist der Live-Text nicht zu haben — weil ein Netzwerk die Verbindung sperrt, zum Beispiel —, läuft die Aufnahme ohne ihn weiter, und der Text kommt beim Stoppen. Woran du das erkennst und was du tun kannst: [Wenn das Diktat nicht klappt](../../troubleshooting/voice-input/).

## Sehen, was eine Anfrage kostet

Neben dem Senden-Knopf zeigt das Eingabefeld die Größe der letzten Anfrage in Tokens: alles, was das Modell bekommen hat — das Gespräch, die Anweisungen, die Beschreibungen der Tools. Ein Klick darauf zeigt, woraus sie besteht: jeden Skill, die Tools, den Rest der Anweisungen und das Gespräch. Die Summe ist die Zahl des Anbieters; die Teile sind geschätzt.

## Wenn es nicht klappt

- **Der Senden-Knopf bleibt gesperrt.** Es ist kein Modell angebunden, oder dem angebundenen fehlt sein Schlüssel: siehe [Ein Modell anbinden](../../getting-started/connect-a-model/).
- **Ein Bild einzufügen, zeigt nur einen Hinweis.** Das Modell dieses Chats nimmt keine Bilder. Wechsle zu einem, das es tut — [Das Modell wechseln](../model-and-reasoning/) —, oder schalte *Bild-Anhänge erlauben* für einen OpenAI-kompatiblen Server ein, dessen Modell Bilder versteht.
- **Ein GIF wird abgelehnt, solange Gemini aktiv ist.** Gemini nimmt PNG, JPEG und WebP, aber kein GIF. Speichere das Bild als PNG oder wechsle das Modell. Hing das GIF schon an, bevor du zu Gemini gewechselt hast, sagt Snotra es beim Senden; entferne das Bild und schick die Nachricht noch einmal.
- ***Nicht gesendet*** neben dem Senden-Knopf. In Snotra ist etwas schiefgegangen, bevor die Nachricht losging. Text und Bilder stehen wieder im Eingabefeld; schick sie noch einmal ab. Passiert das wiederholt, drück direkt danach `Cmd+Shift+D` / `Ctrl+Shift+D` und häng das Ergebnis an einen Bericht: [Logs finden und ein Problem melden](../../troubleshooting/logs-and-reports/).
- ***Kein OpenAI-Key hinterlegt (die Spracheingabe braucht einen).*** Das Diktat braucht einen OpenAI-Schlüssel, auch wenn der Chat bei einem anderen Anbieter läuft. Ohne ihn geht das Mikrofon gar nicht erst an.
- **Das Diktat zeigt beim Sprechen keinen Text, oder gar keinen.** Siehe [Wenn das Diktat nicht klappt](../../troubleshooting/voice-input/).
