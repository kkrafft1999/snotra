---
title: Sehen, was du über alle Chats ausgegeben hast
description: Die geschätzten Kosten und Token aller Chats über einen Zeitraum zusammenzählen – nach Modell und nach Workspace, Tag für Tag – und die Chats hinter einer Zahl öffnen.
sidebar:
  order: 9
---

[seit 1.28] Der Nutzungsbericht zählt zusammen, was deine Chats in einem Zeitraum deiner Wahl verbraucht haben: welche Modelle du genutzt hast und was sie gekostet haben, und in welchen Workspaces. Er beantwortet Fragen wie „Würde für das meiste ein günstigeres Modell reichen?“ oder „Welches Projekt ist das teure?“. Wie die Kosten eines einzelnen Chats ist jede Zahl eine Schätzung, nicht deine Rechnung.

![Der Nutzungsbericht für die letzten 30 Tage: oben Kosten, Tokens und Chats, darunter ein Balken pro Tag und eine Tabelle der Modelle mit Anteil, Tokens, Chats und Kosten.](screenshots/usage-report.webp)

## Was du brauchst

Chats, die ein Modell genutzt haben. Einrichten musst du nichts: Der Bericht liest dieselben Schätzungen wie [Sehen, was ein Chat kostet](../chat-cost/).

## Schritte

1. Öffne den Bericht auf einem von drei Wegen:
   - mit dem Diagramm-Knopf unten in der Seitenleiste, neben *Feedback senden…* und den Einstellungen,
   - über *Ansicht › Nutzung & Kosten…* in der Menüleiste,
   - mit `Cmd+Shift+K` unter macOS, `Strg+Shift+K` unter Windows und Linux – egal, wo der Fokus liegt, auch im Chat-Eingabefeld.
2. Wähle einen Zeitraum: *7 Tage*, *30 Tage*, *Dieser Monat*, *Letzter Monat*, *Gesamt* oder *Eigener Zeitraum* mit einem ersten und einem letzten Tag. Mit den Pfeiltasten wechselst du zwischen ihnen.
3. Lies oben die Summen ab: die Kosten, die Tokens mit dem, was hineinging, aus dem Cache kam und herauskam, und die Zahl der Chats. Darunter zeigt das Diagramm die Kosten pro Tag – bei einem langen Zeitraum pro Woche oder Monat. *Als Tabelle zeigen* listet dieselben Zahlen als Tabelle.
4. Wähle, wonach die Tabelle gruppiert: nach *Modell* oder nach *Workspace*. Klick auf eine Spaltenüberschrift, um danach zu sortieren; ein zweiter Klick kehrt die Reihenfolge um.
5. Klick auf den Pfeil vor einer Zeile, um sie aufzuklappen. Ein Workspace zeigt die Modelle, die er genutzt hat, ein Modell die Workspaces, in denen es lief, und beide ihre Tokens nach Art.
6. Klick in einer Zeile auf *n Chats*, um die Chats dahinter aufzulisten, mit dem, was jeder verbraucht hat, und wann er zuletzt genutzt wurde. *Öffnen* bringt dich zum Chat – in seinem eigenen Ordner: Ist ein anderer Ordner offen, wechselt Snotra zuerst dorthin.
7. Schließ den Bericht mit *Schließen*, dem Kreuz oder `Esc`. Der Fokus kehrt dorthin zurück, wo er war.

![Der Bericht nach Workspace gruppiert: der erste Ordner aufgeklappt in seine Modelle und seine Token-Aufschlüsselung, darunter seine Chats, jeder mit seinen Kosten und einem Knopf Öffnen.](screenshots/usage-report-chats.webp)

## Was passiert

- **Der Zeitraum zählt, was in ihm verbraucht wurde.** Ein Chat, der über drei Wochen lief, trägt zu jeder Woche nur bei, was er in dieser Woche verbraucht hat – nicht seine ganzen Kosten an dem Tag, an dem er begann oder zuletzt geöffnet wurde. Tage sind deine lokalen Kalendertage.
- **Jede Ansicht ergibt dieselbe Summe.** Jede Anfrage zählt einmal beim Modell und einmal beim Workspace, daher stimmen die beiden Tabellen, das Diagramm und die Summen überein.
- **Ein unbekannter Preis zeigt einen Strich.** Ein Modell, das die Preistabelle nicht kennt, zeigt *–* und *kein Preis*, nie *0,00 $*, und eine Summe, die solche Anfragen auslässt, endet auf *+*, zum Beispiel *~3,62 $+*. Lege unter *Einstellungen › Modelle* einen Preis dafür fest, wie in [Sehen, was ein Chat kostet](../chat-cost/) beschrieben.
- **Ein Modell auf deinem Rechner kostet nichts.** Ollama, LM Studio und andere Server unter einer lokalen Adresse zeigen ihre Tokens und *0,00 $ lokal*.
- **Chats ohne Ordner bilden eine eigene Gruppe,** *Ohne Ordner*. Sie öffnen sich nur, solange kein Ordner offen ist; ist einer offen, haben ihre Zeilen keinen Knopf *Öffnen*.
- **Der Bericht ist dein Verlauf, wie er ist.** Ein Chat, den du löschst, zählt nicht mehr, und ebenso wenig einer, den der Verlauf losgelassen hat: Er behält die 200 neuesten Chats.
- **Chats aus der Zeit vor 1.28** haben eine Summe, aber keine Tage. Sie zählen vollständig an dem Tag, an dem sie zuletzt genutzt wurden. Setzt du einen solchen Chat fort, zählen seine neuen Anfragen an ihren eigenen Tagen.
- **Preise:** Der Hinweis unter den Summen nennt das Datum der Preistabelle, mit der die Chats bepreist wurden. Es sind Listenpreise in US-Dollar, wie bei einem einzelnen Chat.
- **Nicht enthalten** sind der erzeugte Chat-Titel, Skill-Vorschläge, Bildgenerierung und Spracheingabe – dieselben Lücken wie bei den Kosten eines einzelnen Chats.

## Wenn es nicht klappt

- **Der Bericht zeigt *In diesem Zeitraum wurde nichts verbraucht.*** In diesem Zeitraum hat kein Chat ein Modell genutzt. Wähle einen längeren oder *Gesamt*.
- **Ein Chat scheint zu fehlen.** Er wurde gelöscht, oder er ist älter als die 200 Chats, die der Verlauf behält. Ein Chat mit einem Modell, das keine Token-Zahlen gemeldet hat, hat nichts zum Zusammenzählen.
- **Das Kürzel tut nichts.** Ein anderes Programm hat `Cmd+Shift+K` bzw. `Strg+Shift+K` womöglich für sich belegt. Nimm *Ansicht › Nutzung & Kosten…* oder den Knopf unten in der Seitenleiste.
- **Ein Chat öffnet sich nicht.** Sein Ordner wurde verschoben oder gelöscht; der Bericht meldet *Der Ordner … ließ sich nicht öffnen.* Öffne den Ordner an seinem neuen Ort mit *Ordner öffnen …* und versuch es noch einmal.
