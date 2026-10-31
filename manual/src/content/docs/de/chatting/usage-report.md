---
title: Sehen, was du über alle Chats ausgegeben hast
description: Die geschätzten Kosten und Token aller Chats über einen Zeitraum zusammenzählen – nach Modell, nach Workspace und nach Aufgabenart, Tag für Tag – und die Chats hinter einer Zahl öffnen.
sidebar:
  order: 9
---

[seit 1.28] Der Nutzungsbericht zählt zusammen, was deine Chats in einem Zeitraum deiner Wahl verbraucht haben: welche Modelle du genutzt hast und was sie gekostet haben, in welchen Workspaces und [seit 1.29] für welche Art von Arbeit. Er beantwortet Fragen wie „Würde für das meiste ein günstigeres Modell reichen?“, „Welches Projekt ist das teure?“ oder „Was kostet mich das Programmieren im Vergleich zum Schreiben?“. Wie die Kosten eines einzelnen Chats ist jede Zahl eine Schätzung, nicht deine Rechnung.

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
4. Wähle, wonach die Tabelle gruppiert: nach *Modell*, nach *Workspace* oder [seit 1.29] nach *Aufgabenart*. Klick auf eine Spaltenüberschrift, um danach zu sortieren; ein zweiter Klick kehrt die Reihenfolge um.
5. Klick auf den Pfeil vor einer Zeile, um sie aufzuklappen. Ein Workspace oder eine Aufgabenart zeigt die Modelle, die dafür genutzt wurden, ein Modell die Workspaces, in denen es lief, und jede Zeile ihre Tokens nach Art.
6. Klick in einer Zeile auf *n Chats*, um die Chats dahinter aufzulisten, mit ihrer Aufgabenart, dem, was jeder verbraucht hat, und wann er zuletzt genutzt wurde. *Öffnen* bringt dich zum Chat – in seinem eigenen Ordner: Ist ein anderer Ordner offen, wechselt Snotra zuerst dorthin.
7. [seit 1.29] Um die Aufgabenart eines Chats zu ändern, klick auf die Art neben seinen Kosten – *Art wählen*, wenn er noch keine hat – und wähl eine der sechs. Zu jeder steht eine Zeile, was sie umfasst. Die Zahlen ziehen sofort nach: Nach Aufgabenart gruppiert, wandert der Chat in seine neue Zeile.
8. Schließ den Bericht mit *Schließen*, dem Kreuz oder `Esc`. Der Fokus kehrt dorthin zurück, wo er war.

![Der Bericht nach Workspace gruppiert: der erste Ordner aufgeklappt in seine Modelle und seine Token-Aufschlüsselung, darunter seine Chats, jeder mit seiner Aufgabenart, seinen Kosten und einem Knopf Öffnen.](screenshots/usage-report-chats.webp)

![Der Bericht nach Aufgabenart gruppiert: Programmieren aufgeklappt in die Modelle, die dafür liefen, darunter seine Chats mit ihrer Art, und beim ersten Chat die Auswahl der sechs Arten geöffnet.](screenshots/usage-report-kinds.webp)

## Was passiert

- **Der Zeitraum zählt, was in ihm verbraucht wurde.** Ein Chat, der über drei Wochen lief, trägt zu jeder Woche nur bei, was er in dieser Woche verbraucht hat – nicht seine ganzen Kosten an dem Tag, an dem er begann oder zuletzt geöffnet wurde. Tage sind deine lokalen Kalendertage.
- **Jede Ansicht ergibt dieselbe Summe.** Jede Anfrage zählt einmal beim Modell, einmal beim Workspace und einmal bei der Aufgabenart, daher stimmen die drei Tabellen, das Diagramm und die Summen überein.
- **Die sechs Aufgabenarten** sind *Programmieren*, *Schreiben & Überarbeiten*, *Recherche & Fragen*, *Daten & Analyse*, *Planung & Konzepte* und *Sonstiges*. Ein Chat bekommt seine Art, wenn er seinen Namen bekommt: Das Modell schlägt sie zusammen mit dem Titel vor, und klappt das nicht, schätzt Snotra sie aus dem, was im Chat passiert ist. Deine eigene Wahl gilt immer und wird nie ersetzt.
- **Chats ohne Art bilden eine eigene Zeile,** *Nicht eingeordnet*, in der Tabelle nach Aufgabenart immer ganz unten, damit nichts aus der Summe fällt. Chats von vor 1.29 bleiben dort, bis du sie fortsetzt oder ihnen eine Art gibst.
- **Ein unbekannter Preis zeigt einen Strich.** Ein Modell, das die Preistabelle nicht kennt, zeigt *–* und *kein Preis*, nie *0,00 $*, und eine Summe, die solche Anfragen auslässt, endet auf *+*, zum Beispiel *~3,62 $+*. Lege unter *Einstellungen › Modelle* einen Preis dafür fest, wie in [Sehen, was ein Chat kostet](../chat-cost/) beschrieben.
- **Ein Modell auf deinem Rechner kostet nichts.** Ollama, LM Studio und andere Server unter einer lokalen Adresse zeigen ihre Tokens und *0,00 $ lokal*.
- **Chats ohne Ordner bilden eine eigene Gruppe,** *Ohne Ordner*. Sie öffnen sich nur, solange kein Ordner offen ist; ist einer offen, haben ihre Zeilen keinen Knopf *Öffnen*.
- **Der Bericht ist dein Verlauf, wie er ist.** Ein Chat, den du löschst, zählt nicht mehr, und ebenso wenig einer, den der Verlauf losgelassen hat: Er behält die 200 neuesten Chats.
- **Chats aus der Zeit vor 1.28** haben eine Summe, aber keine Tage. Sie zählen vollständig an dem Tag, an dem sie zuletzt genutzt wurden. Setzt du einen solchen Chat fort, zählen seine neuen Anfragen an ihren eigenen Tagen.
- **Preise:** Der Hinweis unter den Summen nennt das Datum der Preistabelle, mit der die Chats bepreist wurden. Es sind Listenpreise in US-Dollar, wie bei einem einzelnen Chat.
- **Hilfsanfragen zählen mit.** [seit 1.28] Die Anfragen, die einen Chat benennen und mit *Das Modell fragen* einen Skill vorschlagen, gehören zu den Kosten des Chats und damit auch zum Bericht, an dem Tag, an dem sie gestellt wurden.
- **Nicht enthalten** sind Bildgenerierung und Spracheingabe – dieselben Lücken wie bei den Kosten eines einzelnen Chats.

## Wenn es nicht klappt

- **Der Bericht zeigt *In diesem Zeitraum wurde nichts verbraucht.*** In diesem Zeitraum hat kein Chat ein Modell genutzt. Wähle einen längeren oder *Gesamt*.
- **Ein Chat scheint zu fehlen.** Er wurde gelöscht, oder er ist älter als die 200 Chats, die der Verlauf behält. Ein Chat mit einem Modell, das keine Token-Zahlen gemeldet hat, hat nichts zum Zusammenzählen.
- **Das Kürzel tut nichts.** Ein anderes Programm hat `Cmd+Shift+K` bzw. `Strg+Shift+K` womöglich für sich belegt. Nimm *Ansicht › Nutzung & Kosten…* oder den Knopf unten in der Seitenleiste.
- **Das meiste ist *Nicht eingeordnet*.** Diese Chats sind älter als 1.29, oder ihre Namensanfrage ist gescheitert und Snotra konnte keine Art schätzen. Wähl in der Chatliste dieser Zeile eine Art – das genügt für den Bericht.
- **Die Art eines Chats ließ sich nicht ändern.** Der Bericht sagt *Die Art ließ sich nicht speichern.* Vielleicht wurde der Chat inzwischen gelöscht; schließ den Bericht, öffne ihn neu und versuch es noch einmal.
- **Ein Chat öffnet sich nicht.** Sein Ordner wurde verschoben oder gelöscht; der Bericht meldet *Der Ordner … ließ sich nicht öffnen.* Öffne den Ordner an seinem neuen Ort mit *Ordner öffnen …* und versuch es noch einmal.
