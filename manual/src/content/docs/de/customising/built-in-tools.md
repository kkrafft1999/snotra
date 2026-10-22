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
| *Lesen* | `list_directory`, `read_file_text`, `read_file_lines`, `list_directory_tree`, `find_files`, `search_in_files`, `stat_path`, `outline_file`, `extract_document_text` (PDF, Word, Excel, PowerPoint), `load_skill` (die Anleitung eines eingeschalteten Skills), `get_configuration` (welche Skills und Tools dieser Chat hat), `search_manual` und `read_manual_page` (dieses Handbuch), `list_release_notes` (was die Versionen von Snotra geändert haben), `propose_config_change` (schlägt vor, eines für diesen Chat ein- oder auszuschalten – du entscheidest auf einer Karte) | ja |
| *Ändern* | `write_file_text`, `edit_file`, `apply_patch`, `remember`, `generate_image` | ja — `generate_image` braucht einen OpenAI-Schlüssel |
| *Ausführen* | `shell_execute`, `run_python` | aus, bis du sie einschaltest |
| *Externe Dienste* | `fetch_url`, `web_search` | `web_search` braucht einen Tavily-Schlüssel |

Jedes Tool lässt sich einzeln unter *Einstellungen › Tools › Autonomie* ausschalten, in der Zeile seiner Risikoklasse. Was die Klassen bedeuten, steht unter [Warum Snotra fragt, bevor es handelt](../../safety/why-snotra-asks/).

**Fragen zu Snotra selbst.** [seit 1.22] Fragst du, wie etwas in Snotra geht, wo eine Einstellung liegt oder warum etwas nicht klappt, schlägt das Modell in diesem Handbuch nach: Es sucht mit `search_manual`, liest die Seite mit `read_manual_page` – in der Sprache der App – und verlinkt die Seite, auf die es sich stützt; der Link öffnet sich im Hilfefenster. Beide lesen nur das Handbuch, das mit deiner Version ausgeliefert wird: keine deiner Dateien, nichts aus dem Internet, deshalb fragen sie nie vorher.

**Fragen zu Versionen.** [seit 1.28] Fragst du, was sich seit einer Version geändert hat oder was in der installierten neu ist, liest das Modell die Hinweise der Releases mit `list_release_notes` und antwortet daraus, gegliedert und mit den Versionsnummern. Dafür fragt es bei GitHub die öffentliche Liste der Releases ab – dieselbe Anfrage wie die Update-Prüfung, ohne etwas aus deinen Dateien oder dem Gespräch – und fragt deshalb ebenfalls nie vorher. Siehe [Die Release Notes lesen](../../updating/release-notes/#snotra-nach-versionen-fragen).

## Python

`run_python` führt Python-Code aus, den das Modell schreibt — für Berechnungen, Daten und Diagramme.

1. Schalte es unter *Einstellungen › Tools › Autonomie › Ausführen › Python-Ausführung erlauben* ein und bestätige im folgenden Dialog mit *Einschalten* [seit 1.27.1]. Lies vorher [Befehle in der Sandbox ausführen](../../safety/sandbox/).
2. Snotra sucht Python 3 selbst. Willst du einen bestimmten Interpreter — eine virtuelle Umgebung mit `pandas` zum Beispiel —, trag seinen Pfad unter *Einstellungen › Tools › Einrichtung › Python-Interpreter* ein und klick auf *Übernehmen*.

Snotra installiert nie selbst Pakete; der Interpreter, den du wählst, entscheidet, welche das Modell hat.

## Websuche

`web_search` sucht über **Tavily** im Internet und liefert pro Treffer einen Titel, eine Adresse und einen kurzen Auszug.

1. Hol dir einen Schlüssel auf [app.tavily.com](https://app.tavily.com); es gibt einen kostenlosen Tarif.
2. Trag ihn unter *Einstellungen › Tools › Einrichtung › Websuche › Tavily-API-Schlüssel* ein und klick auf *Schlüssel speichern*.

Die Suchanfrage verlässt deinen Rechner, deshalb fragt Snotra in *Intelligent* vor jeder Suche. Um eine ganze Seite zu lesen, nimmt das Modell `fetch_url`, das keinen Schlüssel braucht.

## Bilderzeugung

`generate_image` zeichnet mit deinem OpenAI-Schlüssel — siehe [Ein Bild erzeugen](../../chatting/generate-images/). Unter *Einstellungen › Tools › Einrichtung › Bilderzeugung* wählst du, welches Bildmodell von OpenAI zeichnet, und klickst dann auf *Übernehmen*.

## Wenn es nicht klappt

- ***Kein Python 3 gefunden.*** Installier Python 3 oder trag den Pfad deines Interpreters ein. Die Zeile unter dem Feld sagt, wo Snotra gesucht hat.
- ***Snotra konnte nicht nach Python suchen.*** Die Suche selbst ist fehlgeschlagen — ob Python installiert ist, sagt das nicht. Schließ die Einstellungen und öffne sie erneut; Snotra sucht dann neu.
- **Das Modell sucht nicht im Web.** Ohne Tavily-Schlüssel wird `web_search` dem Modell gar nicht angeboten.
- **Ein Tool wird nie benutzt.** Klick auf die Skills-Pille in der Chat-Leiste: Ein fehlendes Tool steht dort oben, mit dem Grund und einem Knopf zur Einstellung. Unter *Einstellungen › Tools › Autonomie* steht seine Zeile auf *Aus* oder nennt das Tool als ausgeschaltet.
