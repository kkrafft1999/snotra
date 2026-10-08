---
title: Warum Snotra fragt, bevor es handelt
description: Wie Snotra entscheidet, welche Tool-Aufrufe von selbst laufen und welche auf dich warten, und was in jedem Modus gilt.
sidebar:
  order: 1
---

Snotra arbeitet mit Tools: Es liest Dateien, ändert sie, führt Befehle aus, sucht im Web. Bevor ein Tool-Aufruf läuft, prüft Snotra ihn nach festen Regeln. Das Modell kann um alles bitten; ob es passiert, entscheidet nicht das Modell, sondern Snotra selbst.

## Sechs Arten von Risiko

Jeder Tool-Aufruf gehört zu einer Risikoklasse. Die Klasse entscheidet zusammen mit dem [Modus](../choose-a-mode/) des Chats, ob der Aufruf läuft, vorher fragt oder gar nicht erst angeboten wird.

| Risikoklasse | Was dazugehört | In *Intelligent*, dem Standardmodus |
| --- | --- | --- |
| *Lesen* | Dateien lesen und Ordner auflisten, innerhalb des geöffneten Ordners | läuft |
| *Sensible Daten lesen* | Eine Datei lesen, die Zugangsdaten enthalten kann, etwa `.env`, einen privaten Schlüssel oder `.ssh/` | fragt |
| *Ändern* | Eine Datei anlegen oder ändern; bevor eine Datei als Ganzes ersetzt wird, wandert eine Kopie in den Papierkorb | fragt |
| *Überschreiben ohne Rückweg* | Eine Datei ersetzen, wenn keine Kopie in den Papierkorb kann | fragt, jedes Mal |
| *Ausführen* | Einen Shell-Befehl oder Python-Code ausführen | fragt — außer bei einem Befehl, den du immer erlaubt hast |
| *Externe Dienste* | Im Web suchen, eine Seite abrufen, ein Bild erzeugen, die Tools von MCP-Servern | fragt, jedes Mal |

*Einstellungen › Tools & Sicherheit* zeigt diese sechs Zeilen für den geöffneten Ordner, mit dem, was dort gilt, und warum: [Sehen und ändern, was Snotra darf](../tools-and-security/).

## Warum Lesen läuft und alles andere fragt

**Lesen** im Ordner, den du geöffnet hast, ändert nichts, und den Ordner hast du selbst gewählt. Deshalb liest Snotra in *Intelligent* ohne Rückfrage — das macht es überhaupt erst nützlich.

**Sensible Dateien** sind etwas anderes: Ihr Inhalt ginge an deinen Modell-Anbieter. Die Freigabekarte nennt diesen Anbieter, bevor du entscheidest. Breite Suchen und Auflistungen lassen solche Dateien aus und sagen nur, wie viele sie übersprungen haben.

**Änderungen** hinterlassen Spuren in deinen Dateien. Den neuen Inhalt oder die Ersetzung siehst du auf der Karte, bevor etwas geschrieben wird.

**Befehle** können alles, was du in einem Terminal kannst. Den vollständigen Befehl siehst du auf der Karte, bevor er läuft. Unter macOS und Linux laufen sie außerdem in einer [Sandbox](../sandbox/).

**Externe Dienste** bekommen Daten von deinem Rechner: eine Suchanfrage, eine Adresse, eine Bildbeschreibung, die Argumente eines MCP-Tools.

## Was in jedem Modus gilt

Auch in *Auto*, dem Modus ohne Rückfragen:

- Kein Tool reicht ungefragt über den geöffneten Ordner hinaus. Lesen geht auch in den Ordnern von Skills, die du eingeschaltet hast. [seit 1.18] Will ein Datei-Tool eine Datei oder einen Ordner außerhalb, fragt vorher eine Karte, in jedem Modus, auch in *Auto* — siehe [Eine Freigabe beantworten](../approve-a-request/#eine-datei-außerhalb-des-geöffneten-ordners). Dein Home-Ordner als Ganzes, das Wurzelverzeichnis eines Laufwerks und Snotras eigener Speicher werden nie angeboten.
- Skill-Ordner bleiben schreibgeschützt.
- Snotras eigene Einstellungen, Schlüssel und Berechtigungen sind für jedes Tool unerreichbar.
- Eine Tool-Ausgabe, die einen deiner Anbieter-Schlüssel enthält, wird zurückgehalten.
- Eine Sperre, die du angelegt hast, gewinnt immer.

## Warum Lockern über einen Systemdialog geht

Im Chat steht Inhalt, den Snotra nicht selbst geschrieben hat: Antworten des Modells, Dateien, Webseiten. Ein Text in einer Datei kann Anweisungen enthalten, die sich an das Modell richten. Für das Modell ist das Material, kein Befehl, und jeder Tool-Aufruf danach durchläuft dieselbe Prüfung von Neuem.

Deshalb darf auch das App-Fenster den Schutz nicht allein lockern. *Auto* einschalten, etwas dauerhaft erlauben, die Sandbox abschalten oder eine Sperre löschen bestätigst du in einem Dialog des Betriebssystems, außerhalb des Fensters. Verschärfen — eine Sperre, *Immer fragen* — wirkt sofort, ohne Dialog.

Deine Berechtigungen liegen signiert in deinem Profil, nicht im Projektordner. Ein Repository, das du herunterlädst, kann sich nicht selbst auf *Auto* stellen oder die Sandbox abschalten.
