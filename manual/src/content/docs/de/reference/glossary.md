---
title: Glossar
description: Die Wörter, die Snotra und dieses Handbuch benutzen — Modus, Freigabekarte, Skill, Sandbox, MCP-Server und der Rest — jedes in einem Satz, mit der Seite, die es erklärt.
sidebar:
  order: 3
---

Die Begriffe in alphabetischer Reihenfolge. Jeder Eintrag sagt, was das Wort in Snotra bedeutet, und wo du mehr dazu liest.

### AGENTS.md

Eine Textdatei oben in einem Ordner, in der du aufschreibst, wie dort gearbeitet wird. Snotra folgt ihr in jedem Chat in diesem Ordner. Siehe [Einem Projekt seine Anweisungen geben](../../customising/project-instructions/).

### Anbieter

Die Firma oder der Server, die ein Modell betreibt: OpenAI oder ein OpenAI-kompatibler Server deiner Wahl. Der Text eines Chats geht an ihn. Siehe [Ein Modell anbinden](../../getting-started/connect-a-model/).

### Auto

Einer der drei [Modi](#modus). Snotra fragt nichts; die Ordnergrenze, deine Sperren und der Schutz seiner eigenen Schlüssel bleiben in Kraft. Das Einschalten bestätigst du in einem Systemdialog.

### Chat

Ein Gespräch mit Snotra, mit eigenem [Modus](#modus), eigenem Modell und eigener Reasoning-Stufe. Chats bleiben im [Verlauf](#verlauf) erhalten.

### Freigabekarte

Die Karte, die im Chat erscheint, wenn Snotra etwas tun will, wofür es dein Ja braucht: eine Datei ändern, einen Befehl ausführen, einen Dienst erreichen. Du erlaubst es einmal, für die Sitzung, oder lehnst ab. Siehe [Auf eine Freigabe-Anfrage antworten](../../safety/approve-a-request/).

![Eine Freigabekarte mit dem Titel „Änderung bestätigen“: Snotra möchte notizen/fruehjahr-2026.md mit edit_file ändern. Darunter Wirkung, Zieldatei, Grund, Sitzungsumfang und Modus, eine Vorschau der Ersetzung von alt nach neu und die Knöpfe „Einmal erlauben“, „Für diese Sitzung erlauben“ und „Ablehnen“.](screenshots/approval-card.webp)

### Gedächtnis

Was Snotra für spätere Chats behält: `.agents/memory.md` für ein Projekt, `~/.snotra/memory.md` für jeden Ordner. Siehe [Snotra etwas merken lassen](../../customising/memory/).

### Geöffneter Ordner

Der eine Projektordner, in dem Snotra arbeitet. Er erscheint als Dateibaum links; Snotra kann ihn nicht verlassen. An vielen Stellen in der App und im Code heißt er *Workspace*. Siehe [Einen Ordner öffnen](../../getting-started/open-a-folder/).

### Global

Gilt in jedem Ordner, im Gegensatz zum geöffneten: Globales Gedächtnis, globale Anweisungen und Skills liegen in `~/.snotra/`. Siehe [Herausfinden, wo Snotra seine Dateien ablegt](../files-and-folders/).

### Immer fragen

Einer der drei [Modi](#modus). Snotra fragt vor jedem Tool-Aufruf, auch vorm Lesen. Siehe [Einen Modus wählen](../../safety/choose-a-mode/).

### Intelligent

Einer der drei [Modi](#modus) und der Standard: Lesen im geöffneten Ordner läuft, alles andere fragt zuerst.

### Kontextfenster

Was das Modell mit einer Anfrage bekommt: das Gespräch, die Anweisungen, die Beschreibungen der Tools. Die Größe steht neben dem Senden-Knopf; es gibt eine Grenze, die vom Modell abhängt. Siehe [Eine Nachricht schreiben](../../chatting/write-a-message/).

### MCP-Server

Ein kleines Programm, das Snotra über das Model Context Protocol Tools aus einem anderen System anbietet — einem Ticketsystem, einer Datenbank. Snotra startet es auf deinem Computer. Siehe [Einen MCP-Server anbinden](../../customising/mcp-servers/).

### Modell

Das Sprachmodell, das in einem Chat antwortet, angeboten von einem [Anbieter](#anbieter). Siehe [Deine Modelle verwalten](../../customising/models/).

### Modus

Wie oft Snotra dich fragt: *Intelligent*, *Immer fragen* oder *Auto*. Er gehört zum Chat. Siehe [Einen Modus wählen](../../safety/choose-a-mode/).

![Das Modus-Menü über dem Chat-Eingabefeld: Intelligent, Immer fragen und Auto, jeweils mit einer kurzen Beschreibung, „Immer fragen“ ausgewählt. Darunter das Kästchen „„Immer fragen“ auch für neue Chats in gartenplaner“ und der Link „Alle Berechtigungen unter Einstellungen › Tools & Sicherheit“.](screenshots/mode-menu.webp)

### Reasoning-Stufe

Wie viel ein Modell nachdenkt, bevor es antwortet; eine Einstellung des Chats, neben dem Modell. Siehe [Modell oder Reasoning-Stufe wechseln](../../chatting/model-and-reasoning/).

### Risikoklasse

Die Gruppe, zu der ein Tool-Aufruf gehört, nach dem, was er kann: *Lesen*, *Sensible Daten lesen*, *Ändern*, *Überschreiben ohne Rückweg*, *Ausführen*, *Externe Dienste*. Der Modus entscheidet je Klasse, ob Snotra fragt. Siehe [Warum Snotra fragt, bevor es handelt](../../safety/why-snotra-asks/).

### Sandbox

Die Umhüllung um die Befehle und Python-Programme, die Snotra unter macOS und Linux ausführt: Sie dürfen nur im geöffneten Ordner schreiben und nur die Hosts erreichen, die ihnen erlaubt wurden. Windows hat keine. Siehe [Befehle in der Sandbox ausführen](../../safety/sandbox/).

### Sensibel

Eine Datei oder ein Inhalt, der wie ein Geheimnis aussieht — `.env`, ein privater Schlüssel, ein Token. Gezielter Zugriff fragt zuerst (außer in *Auto*), und breite Suchen lassen solche Dateien aus. Siehe [Sehen und ändern, was Snotra darf](../../safety/tools-and-security/).

### Sitzungsfreigabe

Ein Ja von einer Freigabekarte, das für den Rest eines Chats gilt — genau dieses Tool auf genau diesen Zielen. Sie endet, wenn du den Chat verlässt, seinen Modus oder eine Regel änderst oder Snotra neu startest.

### Skill

Ein Ordner mit einer `SKILL.md`, die dem Modell sagt, wie es eine Art von Aufgabe erledigt. Skills schaltest du unter *Einstellungen › Skills* ein. Siehe [Skills nutzen](../../customising/skills/).

### Sperre

Eine Regel von dir, die ein Tool oder eine ganze [Risikoklasse](#risikoklasse) für einen Ordner oder alle verbietet. Eine Sperre gewinnt immer gegen eine Erlaubnis. Siehe [Sehen und ändern, was Snotra darf](../../safety/tools-and-security/).

### Standardmodus

Der Modus, in dem ein neuer Chat für einen Ordner beginnt. Ohne einen ist es *Intelligent*. Siehe [Einen Modus wählen](../../safety/choose-a-mode/).

### System-Prompt

Deine eigenen Anweisungen für jeden Chat, unter *Einstellungen › Allgemein*. Standardmäßig leer. Siehe [Dich in den Einstellungen zurechtfinden](../../customising/settings/).

### Token

Die Einheit, in der ein Modell Text zählt; etwa vier Zeichen. Die Größe einer Anfrage steht in Tokens.

### Tool

Etwas, das Snotra in eigener Regie tun kann: eine Datei lesen, durchsuchen oder ändern, einen Befehl ausführen, im Web suchen, ein Bild erzeugen. Siehe [Die eingebauten Tools einrichten](../../customising/built-in-tools/).

### Tool-Protokoll

Die Zusammenfassung über einer Antwort, die auflistet, was Snotra gelesen, geändert und ausgeführt hat. Siehe [Verfolgen, was Snotra tut](../../chatting/follow-the-work/).

### Tool-Runde

Ein Durchgang, in dem das Modell Tools aufruft und deren Ergebnisse bekommt. Die Zahl hintereinander begrenzt *Max. Tool-Runden* unter *Einstellungen › Allgemein*, standardmäßig 14, damit eine Schleife nicht ewig laufen kann.

### Verlauf

Die Liste deiner früheren Chats, rechts im Fenster. Siehe [Einen früheren Chat fortsetzen](../../chatting/chat-history/).

### Vorschau

Die mittlere Spalte, die eine Datei zeigt — formatiertes Markdown, Code, ein Bild, ein PDF, eine HTML-Seite. Siehe [Eine Datei ansehen](../../workspace/preview/).
