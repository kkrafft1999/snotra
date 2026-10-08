---
title: Die eingebauten Tools einrichten
description: Die Tools, die Snotra mitbringt, welche davon eingerichtet werden müssen und wo — Python, Websuche und Bilderzeugung.
sidebar:
  order: 8
---

Snotra bringt eigene Tools zum Lesen, Ändern, Ausführen und Suchen mit. Die meisten funktionieren sofort; drei brauchen vorher etwas von dir.

## Die eingebauten Tools

| Risikoklasse | Tools | Bereit? |
| --- | --- | --- |
| *Lesen* | `read_file_text`, `read_file_lines`, `list_directory_tree`, `find_files`, `search_in_files`, `stat_path`, `outline_file`, `extract_document_text` (PDF, Word, Excel, PowerPoint) | ja |
| *Ändern* | `write_file_text`, `edit_file`, `apply_patch`, `remember`, `generate_image` | ja — `generate_image` braucht einen OpenAI-Schlüssel |
| *Ausführen* | `shell_execute`, `run_python` | aus, bis du sie einschaltest |
| *Externe Dienste* | `fetch_url`, `web_search` | `web_search` braucht einen Tavily-Schlüssel |

Jedes Tool lässt sich einzeln unter *Einstellungen › Tools & Sicherheit* ausschalten, in der Zeile seiner Risikoklasse. Was die Klassen bedeuten, steht unter [Warum Snotra fragt, bevor es handelt](../../safety/why-snotra-asks/).

## Python

`run_python` führt Python-Code aus, den das Modell schreibt — für Berechnungen, Daten und Diagramme.

1. Schalte es unter *Einstellungen › Tools & Sicherheit › Ausführen › Python-Ausführung erlauben* ein. Lies vorher [Befehle in der Sandbox ausführen](../../safety/sandbox/).
2. Snotra sucht Python 3 selbst. Willst du einen bestimmten Interpreter — eine virtuelle Umgebung mit `pandas` zum Beispiel —, trag seinen Pfad unter *Einstellungen › Tool-Einrichtung › Python-Interpreter* ein und klick auf *Übernehmen*.

Snotra installiert nie selbst Pakete; der Interpreter, den du wählst, entscheidet, welche das Modell hat.

## Websuche

`web_search` sucht über **Tavily** im Internet und liefert pro Treffer einen Titel, eine Adresse und einen kurzen Auszug.

1. Hol dir einen Schlüssel auf [app.tavily.com](https://app.tavily.com); es gibt einen kostenlosen Tarif.
2. Trag ihn unter *Einstellungen › Tool-Einrichtung › Websuche › Tavily-API-Schlüssel* ein und klick auf *Schlüssel speichern*.

Die Suchanfrage verlässt deinen Rechner, deshalb fragt Snotra in *Intelligent* vor jeder Suche. Um eine ganze Seite zu lesen, nimmt das Modell `fetch_url`, das keinen Schlüssel braucht.

## Bilderzeugung

`generate_image` zeichnet mit deinem OpenAI-Schlüssel — siehe [Ein Bild erzeugen](../../chatting/generate-images/). Unter *Einstellungen › Tool-Einrichtung › Bilderzeugung* wählst du, welches Bildmodell von OpenAI zeichnet, und klickst dann auf *Übernehmen*.

## Wenn es nicht klappt

- ***Kein Python 3 gefunden.*** Installier Python 3 oder trag den Pfad deines Interpreters ein. Die Zeile unter dem Feld sagt, wo Snotra gesucht hat.
- **Das Modell sucht nicht im Web.** Ohne Tavily-Schlüssel wird `web_search` dem Modell gar nicht angeboten.
- **Ein Tool wird nie benutzt.** Es ist vielleicht unter *Einstellungen › Tools & Sicherheit* ausgeschaltet; die Zeile steht auf *Aus* oder nennt das Tool als ausgeschaltet.
