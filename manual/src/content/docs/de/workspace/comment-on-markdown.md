---
title: Eine Markdown-Datei kommentieren
description: Eine Stelle in der Vorschau markieren und einen Kommentar dazu schreiben — er steht in der Datei, so sehen ihn der Agent und alle, die die Datei öffnen.
sidebar:
  order: 7
---

[seit 1.32] Ein Konzept oder eine Notiz durchsehen geht wie in einer Textverarbeitung: eine Stelle in der formatierten Vorschau markieren, aufschreiben, was dir dazu einfällt, weiterlesen. Später kannst du den Agenten bitten, die Kommentare abzuarbeiten.

![Die mittlere Spalte mit fruchtfolge.md in der Vorschau: „nächstes Jahr Bohnen“ trägt eine helle Tönung und eine Sprechblase; unter „Nordbeet“ ein kleines Formular mit dem markierten Wort, dem Kommentar „Dort gibt es nur fünf Stunden Sonne.“, der Zeile „Als Ada Lovelace“ und den Schaltflächen Abbrechen und Kommentieren.](screenshots/markdown-comment.webp)

## Was du brauchst

- Einen geöffneten Ordner und eine Markdown-Datei daraus in der [Vorschau](../preview/), auf der Seite *Preview*.
- Es läuft keine Chat-Antwort. Solange der Agent arbeitet, warten Kommentare, wie das [Bearbeiten](../edit-a-file/).
- Optional: einen Namen unter [*Einstellungen › Allgemein*](../../customising/settings/#der-bereich-allgemein), *Name für Kommentare*. Ohne ihn unterschreibt Snotra mit dem vollen Namen deines Benutzerkontos, wie in einer PDF.

## Schritte

1. Markier eine Stelle mit der Maus oder der Tastatur — ein paar Worte, einen Satz, eine Tabellenzelle.
2. Klick auf *Kommentieren* neben der Markierung, oder drück `Option+Cmd+M` / `Strg+Alt+M`.
3. Schreib den Kommentar und klick auf *Kommentieren*, oder drück `Cmd+Enter` / `Strg+Enter`. `Esc` bricht ab.

## Was passiert

- **Der Kommentar wird in die Datei geschrieben.** Aus der Stelle wird `{==the version scheme==}{>>Ada Lovelace, 2026-11-14: Semantic versioning, or a date?<<}` — CriticMarkup, eine Klartext-Konvention für Kommentare. Der Kommentar reist mit der Datei: über Git, einen synchronisierten Ordner, eine E-Mail.
- **Die Vorschau hebt die Stelle hervor,** mit einer hellen Tönung und einer kleinen Sprechblase dahinter. Klick auf die Sprechblase oder die Stelle, oder geh mit `Tab` zur Sprechblase und drück `Enter`, um den Kommentar mit Autor und Datum zu lesen. `Esc` schließt ihn.
- **Der Agent liest die Kommentare mit der Datei.** Bitte ihn, „die Kommentare in concept.md abzuarbeiten“: Er ändert den Text wie gewünscht und entfernt danach die Kommentare, die er erledigt hat. Kommentare, die er nicht angegangen ist, bleiben stehen.
- **Nichts wird stillschweigend überschrieben.** Wie beim Bearbeiten prüft Snotra, ob die Datei auf der Festplatte noch die ist, in der du markiert hast. Hat ein anderes Programm sie geändert, wird der Kommentar nicht geschrieben; die Vorschau zeigt die neue Fassung, und du markierst noch einmal.
- Andere Markdown-Anzeigen, die CriticMarkup nicht kennen — GitHub zum Beispiel —, zeigen die Markierungen als normalen Text.

## Wenn es nicht klappt

- ***Kommentieren* ist ausgegraut und sagt, dass Snotra arbeitet.** Warte, bis die Chat-Antwort fertig ist, oder halte sie an.
- ***Markier Text innerhalb eines Absatzes, einer Überschrift, eines Listenpunkts oder einer Tabellenzelle.*** Ein Kommentar bleibt innerhalb eines dieser Teile. Kommentier jeden Teil für sich.
- ***Code lässt sich nicht kommentieren.*** Codeblöcke und `Code` im Satz bleiben, wie sie sind. Kommentier den Satz drumherum.
- ***Dieser Text kommt hier mehrmals vor.*** Dieselben Worte stehen mehrmals im Absatz, und Snotra kann nicht erkennen, welche du meinst. Markier ein paar Worte mehr.
- ***Diese Stelle lässt sich nicht genau in der Datei wiederfinden.*** Eine Formatierung steht im Weg — rohes HTML, ein Bild, ein ungewöhnlicher Link. Markier etwas weniger oder etwas mehr.
- ***Diese Stelle überschneidet sich mit einem Kommentar, der schon da ist.*** Kommentare lassen sich nicht verschachteln. Markier eine Stelle daneben.
- **Um einen Kommentar zu ändern oder zu löschen,** wechsle zu *Quelltext*, [bearbeite](../edit-a-file/) den Text zwischen `{>>` und `<<}`, oder entferne die ganze Markierung.
