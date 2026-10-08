---
title: Anlegen, umbenennen, verschieben und löschen
description: Verwalte die Dateien des geöffneten Ordners direkt im Baum und hol Dateien aus dem Finder oder Explorer herein.
sidebar:
  order: 4
---

Die alltägliche Arbeit an Dateien erledigst du, ohne Snotra zu verlassen: eine Datei oder einen Ordner anlegen, umbenennen, verschieben, löschen oder Dateien von woanders hereinholen.

## Was du brauchst

Einen geöffneten Ordner.

## Eine Datei oder einen Ordner anlegen

1. Klick mit der rechten Maustaste auf einen Ordner und wähle *Neue Datei…* oder *Neuer Ordner…*. Auf einer Datei landet der neue Eintrag daneben; auf der freien Fläche unter den Zeilen direkt im geöffneten Ordner. Dieselben zwei Einträge stehen im `⋯`-Menü oben am Baum, für den Ordner, den du ausgewählt hast.
2. Im Baum erscheint ein Namensfeld. Tipp den Namen und drück `Enter`. `Esc` oder ein Klick daneben bricht ab.

Eine neue Datei wird ausgewählt und in der Vorschau gezeigt.

## Umbenennen

1. Klick mit der rechten Maustaste auf die Zeile und wähle *Umbenennen…*, oder drück `F2` auf der fokussierten Zeile.
2. Der Name wird zum Feld, mit dem Teil vor der Endung markiert. Tipp den neuen Namen und drück `Enter`; `Esc` lässt alles, wie es war.

Eine umbenannte Datei bleibt unter ihrem neuen Namen in der Vorschau; in einem umbenannten Ordner bleiben die offenen Unterordner und die angezeigte Datei, wie sie waren. Nur die Groß- und Kleinschreibung zu ändern — `readme.md` zu `README.md` —, geht auf jedem System.

## Verschieben

Zieh eine Datei oder einen Ordner auf eine Ordnerzeile, um sie dorthin zu verschieben, oder auf die freie Fläche unter den Zeilen, um sie ganz nach oben in den geöffneten Ordner zu legen. Ist der Name dort schon vergeben, heißt der verschobene Eintrag `name (2).ext`.

## Löschen

Klick mit der rechten Maustaste auf die Zeile, wähle *Löschen…* und bestätige. Die Datei oder der Ordner wandert in den Papierkorb, du kannst sie also von dort zurückholen.

## Dateien von außen hereinholen

Zieh Dateien oder Ordner aus dem Finder oder Explorer auf eine Ordnerzeile im Baum oder auf die freie Fläche für den geöffneten Ordner. Sie werden **kopiert**; die Originale bleiben, wo sie sind. Mehrere auf einmal gehen, und ein vergebener Name wird zu `name (2).ext`.

Vor einem Ordner, oder ab 20 Dateien oder 10 MB, fragt Snotra vorher, mit Anzahl, Größe und Ziel in klaren Worten und *Abbrechen* vorausgewählt. Dateien, die nach Zugangsdaten aussehen — `.env`, `*.pem`, `id_*`, alles unter `.ssh/` —, holt Snotra nicht herein: Das Modell könnte sie später lesen. Kopier sie selbst, wenn es sein muss.

## Was dann passiert

Nichts wird je überschrieben: Ein vergebener Name wird abgelehnt oder nummeriert, nie ersetzt. Baum, `@`-Liste und Filter zeigen die Änderung sofort.

## Wenn es nicht klappt

- **Das Namensfeld sagt schon beim Tippen, was nicht stimmt.** Ein Name kann vergeben sein (*… gibt es hier schon*), `/` oder `\` enthalten oder etwas sein, das Windows nicht erlaubt — `:`, `?`, einen Namen wie `con`, einen Punkt am Ende. Snotra lehnt das auf jedem System ab, damit der Ordner überall nutzbar bleibt.
- ***Du hast keine Schreibrechte in diesem Ordner.*** Der Ordner ist für dich schreibgeschützt; ändere das in deinem Dateimanager.
- **Ein Hereinziehen wird ganz abgelehnt.** Mehr als 2.000 Einträge oder 200 MB auf einmal werden abgelehnt statt halb kopiert. Kopier kleinere Teile oder nimm deinen Dateimanager.
