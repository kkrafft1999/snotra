---
title: Ein Bild erzeugen
description: Lass Snotra mit dem Bildmodell von OpenAI ein Bild zeichnen und im geöffneten Ordner speichern.
sidebar:
  order: 6
---

Snotra kann aus einer Beschreibung ein Bild zeichnen — eine Illustration für eine README, ein Titelbild für eine Seite, einen Icon-Entwurf — und es als Datei im geöffneten Ordner speichern.

## Was du brauchst

- Einen OpenAI-Schlüssel unter *Einstellungen › Modelle*. Snotra nutzt ihn für die Bilder, egal mit welchem Modell der Chat läuft. Siehe [Ein Modell anbinden](../../getting-started/connect-a-model/).
- Einen geöffneten Ordner; dort wird das Bild gespeichert.

## Schritte

1. Bitte im Chat um das Bild und sag, wohin es soll, wenn es darauf ankommt: *Zeichne mir einen Plan der drei Beete für die README, als bilder/gartenplan.png.*
2. Snotra schreibt eine Beschreibung für das Bildmodell von OpenAI und fragt dich auf einer Karte, bevor es sie abschickt. Gib sie mit *Einmal erlauben* frei.
3. Das Bild wird gezeichnet und gespeichert. Die Dateiendung bestimmt das Format: PNG, JPEG oder WebP.

![Eine Antwort mit „1 Bild erzeugt“, der Zeile „Geändert: gartenplan.png binär“ und darunter dem Bild — ein Plan mit zwei langen Beeten und einer Kräuterspirale — mit seinem Pfad bilder/gartenplan.png, der Größe 1536 × 1024 und dem Format PNG, gefolgt vom Antworttext.](screenshots/image-card.webp)

## Was dann passiert

- Das Bild erscheint in der Antwort, unter der Zeile der geänderten Dateien, mit Pfad und Größe. Ein Klick darauf öffnet es in der mittleren Spalte.
- Ersetzt ein Bild eine vorhandene Datei, wandert vorher eine Kopie der alten in den Papierkorb.
- Das Modell bekommt Pfad und Größe des Bildes zurück, nie das Bild selbst.

Die Beschreibung verlässt deinen Rechner, und OpenAI rechnet jedes Bild ab. Deshalb fragt Snotra in *Intelligent* vor jedem einzelnen Bild, und eine Antwort zeichnet höchstens vier.

Welches Bildmodell von OpenAI zeichnet, stellst du unter *Einstellungen › Tool-Einrichtung › Bilderzeugung* ein.

## Wenn es nicht klappt

- **Snotra sagt, es könne keine Bilder zeichnen.** Es ist kein OpenAI-Schlüssel hinterlegt, oder das Tool *generate_image* ist unter *Einstellungen › Tools & Sicherheit* in der Zeile *Ändern* ausgeschaltet.
- **Das Bild dauert lange.** Zeichnen kann eine Weile dauern; nach drei Minuten gibt Snotra auf und sagt es.
- **OpenAI lehnt die Beschreibung ab.** Die Antwort zeigt den Grund von OpenAI. Ändere die Bitte und frag noch einmal.
