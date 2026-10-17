---
title: Was Snotra kann und was nicht
description: Alles, was Snotra kann, auf einer Seite — in deinem Ordner lesen, ändern und ausführen, das Web, Bilder, Gedächtnis, Skills und MCP-Server —, was es nicht kann und wo jeder Teil erklärt ist.
sidebar:
  order: 0
---

Snotra ist eine Desktop-App für macOS, Windows und Linux. Du öffnest einen Ordner, der Dateibaum bleibt im Blick, und der Chat arbeitet in diesem Ordner mit dem Modell, das du verbunden hast. Es gibt keine Web-Version und keine Terminal-Sitzung: Was das Modell tut, tut es über die Tools unten, und jedes davon kann dich vorher fragen.

Diese Seite ist der Überblick. Jede Zeile verweist auf die Seite, die es erklärt.

## Was es kann

| Bereich | Was Snotra tut | Mehr dazu |
| --- | --- | --- |
| Lesen | Listet Ordner auf, findet Dateien nach Namen, durchsucht ihren Text, liest sie, gliedert Code und liest den Text von PDF-, Word-, Excel- und PowerPoint-Dateien | [Die eingebauten Tools einrichten](../../customising/built-in-tools/) |
| Ändern | Legt Dateien im geöffneten Ordner an und bearbeitet sie; bevor eine Datei als Ganzes ersetzt wird, wandert eine Kopie in den Papierkorb | [Sehen, was Snotra geändert hat](../../chatting/review-changes/) |
| Ausführen | Führt Shell-Befehle und Python-Code aus — aus, bis du es einschaltest, und unter macOS und Linux in einer Sandbox abgeschottet | [Befehle in der Sandbox ausführen](../../safety/sandbox/) |
| Das Web | Sucht im Web (mit einem Tavily-Schlüssel) und ruft eine einzelne Seite ab | [Die eingebauten Tools einrichten](../../customising/built-in-tools/#websuche) |
| Bilder | Zeichnet ein Bild mit deinem OpenAI-Schlüssel und speichert es im Ordner; liest Screenshots, die du in eine Nachricht einfügst, wenn das Modell Bilder versteht | [Ein Bild erzeugen](../../chatting/generate-images/), [Eine Nachricht schreiben](../../chatting/write-a-message/) |
| Diktieren | Macht aus Sprache Text im Nachrichtenfeld, mit Zugang zu OpenAI | [Eine Nachricht schreiben](../../chatting/write-a-message/) |
| Gedächtnis | Behält Fakten für diesen Ordner oder für dich über Chats hinweg | [Snotra etwas merken lassen](../../customising/memory/) |
| Skills | Folgt Anleitungen, die du ihm als Skills gibst — eingebaut, für einen Ordner oder für alle —, und kann einen neuen Skill in den geöffneten Ordner schreiben | [Skills nutzen](../../customising/skills/), [Snotra einen Skill schreiben lassen](../../customising/write-a-skill/) |
| MCP-Server | Nutzt die Tools von MCP-Servern, die du anbindest: Tickets, eine Datenbank, einen Kalender, was immer ein Server anbietet | [Einen MCP-Server anbinden](../../customising/mcp-servers/) |
| Modelle | Arbeitet mit OpenAI, Anthropic und Google in der Cloud, mit Ollama, LM Studio und jedem Server mit OpenAI-kompatibler Schnittstelle auf deinem Rechner oder in deinem Netz und über Gateways wie OpenRouter | [Ein Modell anbinden](../../getting-started/connect-a-model/) |
| Fragen zu Snotra | Schlägt die Antwort in diesem Handbuch nach und verlinkt die Seite, die es benutzt hat | [Die eingebauten Tools einrichten](../../customising/built-in-tools/#die-eingebauten-tools) |

Was ein Chat von sich aus darf, hängt von seinem Modus und von der Risikoklasse jedes Tools ab — siehe [Warum Snotra fragt, bevor es handelt](../../safety/why-snotra-asks/).

## Was es nicht kann

- **Kein Ton und kein Video.** Snotra erzeugt Bilder, sonst nichts.
- **Keine eigenen Mails, Nachrichten, Kalender oder Tickets.** Das geht nur über einen MCP-Server, den du anbindest.
- **Keine Office-Dateien oder PDFs schreiben.** Snotra liest ihren Text, aber kein Tool legt sie an oder ändert sie.
- **Nichts außerhalb des geöffneten Ordners ungefragt.** Ein Pfad außerhalb wird in jedem Modus auf einer Karte erfragt; dein Benutzerordner als Ganzes, die Wurzel eines Laufwerks und Snotras eigener Speicher werden nie angeboten.
- **Keine Befehle, die weiterlaufen.** Jeder Befehl und jeder Python-Aufruf läuft einmal und endet: Zwischen zwei Aufrufen bleibt nichts erhalten, nichts wartet auf eine Eingabe, und was ein Befehl im Hintergrund startet, endet mit ihm — [seit 1.25] auch unter Windows. Übrig bleiben kann ein Programm, das sich absichtlich ablöst (ein Daemon, unter macOS oder unter Linux ohne Sandbox), und unter Windows eines, das Windows für den Befehl startet, etwa eine geplante Aufgabe, ein Dienst oder eine Office-Anwendung, die der Befehl steuert. Lässt Windows Snotra den Hintergrund nicht beenden — weil deine Organisation PowerShell einschränkt oder gar keine PowerShell da ist —, läuft der Befehl trotzdem, und seine Ausgabe sagt es.
- **Keine Änderung an den eigenen Einstellungen.** Das Modell kann vorschlagen, einen Skill oder ein Tool für den Chat einzuschalten, aber erst dein Klick auf diese Karte tut es — Modus, Schlüssel und dauerhafte Einstellungen bleiben bei dir.

## Ohne geöffneten Ordner

Du kannst chatten, ohne einen Ordner zu öffnen, aber das Modell hat dann keine Tools, um etwas zu ändern oder auszuführen. Es kann weiterhin die Ordner der eingeschalteten Skills lesen, im Web suchen, eine Seite abrufen, MCP-Server nutzen und in diesem Handbuch nachschlagen. Ein Skill hat keinen Platz für seine Daten, bis ein Ordner geöffnet ist.

## Grenzen

| Grenze | Wert |
| --- | --- |
| Größe einer Datei, die das Modell schreibt oder bearbeitet | 2 MB |
| Bilder pro Antwort | 4 |
| Gedächtnis pro Ebene (dieser Ordner, überall) | 8.000 Zeichen |
| Eine aus dem Web abgerufene Seite | eine `http`- oder `https`-Adresse pro Aufruf, nur Text, nie eine Adresse in deinem lokalen Netz |

## Wenn es nicht klappt

- **Das Modell sagt, es könne etwas nicht, was auf dieser Seite steht.** Das Tool ist wahrscheinlich ausgeschaltet oder nicht eingerichtet. Klick auf die Skills-Pille in der Chatleiste: Ein fehlendes Tool steht dort mit dem Grund und einem Knopf zur Einstellung.
- **Ein Tool fehlt, obwohl es eingeschaltet ist.** Manche Tools erscheinen erst, wenn sie eingerichtet sind — `web_search` mit einem Tavily-Schlüssel, `generate_image` mit einem OpenAI-Schlüssel, `run_python` mit Python 3. Siehe [Die eingebauten Tools einrichten](../../customising/built-in-tools/).
