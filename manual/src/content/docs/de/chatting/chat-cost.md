---
title: Sehen, was ein Chat kostet
description: Die geschätzten API-Kosten eines Chats ablesen, aufgeteilt nach Modell und Token-Art, und für ein Modell einen eigenen Preis festlegen.
sidebar:
  order: 8
---

[seit 1.23] Snotra schätzt, was ein Chat mit einem Cloud-Modell bisher gekostet hat. Dazu zählt es die Token jeder Anfrage und bepreist sie mit einer öffentlichen Preistabelle. Die Zahl ist eine Schätzung, nicht deine Rechnung.

## Was du brauchst

Einen Chat mit mindestens einer Antwort. Einrichten musst du nichts: Die Preistabelle kommt mit Snotra.

## Schritte

1. Schau in die Leiste unter dem Eingabefeld, links neben den Token-Zähler. Sobald ein Chat Token verbraucht hat, steht dort die Schätzung, zum Beispiel *~0,42 $*.
2. Klick darauf. Es öffnet sich eine Fläche mit der Summe und, für jedes Modell des Chats, seinen Token und Kosten: Eingabe, aus dem Cache gelesen, in den Cache geschrieben und Ausgabe einschließlich Reasoning.
3. Zum Schließen klickst du noch einmal auf die Zahl, klickst daneben oder drückst `Esc`.

Der Verlauf zeigt dieselbe Schätzung neben der Uhrzeit jedes Chats, siehe [Einen früheren Chat fortsetzen](../chat-history/).

## Was passiert

- **Die Summe gilt für den ganzen Chat.** Jede Anfrage zählt, auch die Runden, in denen Snotra Tools nutzt. Wechselst du in einem Chat das Modell, behält jedes Modell seine eigene Zeile zu seinem eigenen Preis. Die Summe wird mit dem Chat gespeichert und ist wieder da, wenn du ihn öffnest.
- **Jede Token-Art hat ihren eigenen Preis.** Aus dem Prompt-Cache zu lesen ist günstiger als normale Eingabe, in ihn zu schreiben kann mehr kosten. Reasoning wird als Ausgabe abgerechnet.
- **Ein Modell auf deinem Rechner kostet nichts.** Ollama, LM Studio und andere Server unter einer lokalen Adresse zeigen *0,00 $*: Es gibt keine API-Rechnung.
- **Ein unbekanntes Modell zeigt einen Strich.** Kennt die Tabelle keinen Preis für ein Modell, steht bei seinen Kosten *–*, nie *0,00 $*. Eine Summe, die solche Anfragen auslässt, endet auf *+*, zum Beispiel *~0,42 $+*.
- **Nicht enthalten** sind Bildgenerierung, Spracheingabe und der erzeugte Chat-Titel. Batch-, Priority- und Long-Context-Aufschläge sowie regionale Preise werden nicht abgebildet; es gilt der Listenpreis der Tabelle.

Die Kosten ersetzen nicht die Rechnung deines Anbieters. Rundung, Rabatte und Preisänderungen können den tatsächlichen Betrag abweichen lassen.

## Eigene Preise

*Einstellungen › Modelle* listet unter *Preise für die Kostenschätzung* jedes Modell deiner Liste mit dem Preis, den Snotra verwendet, und seiner Herkunft: *Preistabelle*, *Dein Preis*, *Lokal – kostenlos* oder *Kein Preis bekannt*.

1. Öffne *Einstellungen › Modelle* und scroll zu *Preise für die Kostenschätzung*.
2. Klick neben dem Modell auf *Preis festlegen* – oder in der Kostenfläche des Chats auf *Preis festlegen*, das führt an dieselbe Stelle.
3. Gib den Preis in US-Dollar pro Million Token für *Eingabe* und *Ausgabe* ein. *Cache lesen* und *Cache schreiben* sind optional; leer kosten sie so viel wie die Eingabe.
4. Klick auf *Preis speichern*.

Dein Preis geht immer vor – der Tabelle und auch *Lokal – kostenlos*, etwa für einen Server auf deinem Rechner, der an eine kostenpflichtige API weiterleitet. *Tabellenpreis verwenden* entfernt ihn wieder.

## Die Preistabelle aktualisieren

Die Tabelle stammt von [LiteLLM](https://github.com/BerriAI/litellm), einer von der Community gepflegten Liste von Modellpreisen. Jedes Snotra-Release bringt eine aktuelle Kopie mit. Von sich aus lädt Snotra keine Preise; für eine neuere Tabelle klickst du unter *Preise für die Kostenschätzung* auf *Preise aktualisieren*. Das Datum der verwendeten Tabelle steht dort und unten in der Kostenfläche.

Schlägt der Download fehl, gilt die bisherige Tabelle weiter, und Snotra sagt dir das.

## Wenn es nicht klappt

- **Bei den Kosten steht *–*.** Die Tabelle kennt das Modell nicht, was bei einem Modell auf einem OpenAI-kompatiblen Server oder einem Deployment mit eigenem Namen häufig ist. Leg dafür einen eigenen Preis fest.
- **Die Kosten wirken zu hoch oder zu niedrig.** Vergleich das Datum der Tabelle mit den aktuellen Preisen deines Anbieters und klick auf *Preise aktualisieren*. Zahlst du einen anderen Preis, leg ihn als eigenen fest.
- **Es erscheint keine Zahl.** Der Chat hat noch keine Antwort, oder der Anbieter hat nicht gemeldet, wie viele Token verbraucht wurden.
