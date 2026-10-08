---
title: Einen MCP-Server anbinden
description: Hol dir Tools aus anderen Systemen — einem Ticketsystem, einem Wiki, einer Datenbank — über das Model Context Protocol.
sidebar:
  order: 7
---

Über das **Model Context Protocol (MCP)** bekommt Snotra Tools aus anderen Systemen: Jira und Confluence, GitHub, eine Datenbank, einen internen Dienst. Ein MCP-Server ist ein kleines Programm, das solche Tools anbietet; Snotra startet es und reicht seine Tools an das Modell weiter.

## Was du brauchst

- Den Startbefehl des Servers aus seiner Dokumentation — zum Beispiel `npx -y @modelcontextprotocol/server-github`.
- Was er zum Anmelden braucht, meist ein Token als Umgebungsvariable.
- Das Programm hinter dem Befehl auf deinem Rechner, etwa Node.js für `npx` oder Docker für `docker`.

Snotra unterstützt Server, die **lokal als Prozess** laufen. Server, die nur über HTTP oder SSE erreichbar sind, gehen noch nicht.

Ein MCP-Server ist fremder Code, der auf deinem Rechner mit deinen Rechten startet. Füg nur Server hinzu, denen du vertraust.

## Einen Server hinzufügen

1. Öffne *Einstellungen › Tool-Einrichtung* und klick unter *MCP-Server* auf *Server hinzufügen*.
2. Füll das Formular aus; die Felder sind unten erklärt.
3. Klick auf *Speichern* und dann auf *Verbindung testen*. Das startet den Server einmal und zeigt die Tools, die er anbietet — oder den Fehler, mit dem, was der Server ausgegeben hat.

![Der Dialog eines MCP-Servers: Kennung github, Anzeigename GitHub, Kommando npx, Argumente „-y @modelcontextprotocol/server-github“, ein leeres Arbeitsverzeichnis, der Knopf „Variable hinzufügen“ und unten „Server entfernen“, „Verbindung testen“, „Abbrechen“ und „Speichern“.](screenshots/mcp-server.webp)

| Feld | Was hineingehört |
| --- | --- |
| *Kennung* | Kleinbuchstaben, Ziffern, `.`, `-` und `_`. Sie wird Teil der Tool-Namen und lässt sich später nicht ändern. |
| *Anzeigename* | Ein beliebiger Name, für die Liste. |
| *Kommando* und *Argumente* | Was gestartet wird, zum Beispiel `npx` und `-y @modelcontextprotocol/server-github`. |
| *Arbeitsverzeichnis* | Optional; leer heißt dein Benutzerordner. |
| *Umgebungsvariablen* | *Variable hinzufügen* für jede einzelne. |

**Umgebungsvariablen sind standardmäßig geheim:** verschlüsselt gespeichert und nach dem Speichern nicht mehr angezeigt — nur ersetzt oder gelöscht. Nimm den Haken bei *geheim* für einen Wert heraus, der lesbar bleiben darf, etwa `LANG=de_DE`.

## Aus einer anderen App importieren

Nutzt du MCP-Server schon in Claude Desktop, Claude Code oder Cursor, klick auf *Importieren* und füg deren `mcpServers`-Block ein. Snotra zeigt, was es erkannt hat: jeden Server mit seinem Startbefehl, die Werte, die es geheim hält, noch nicht ausgefüllte Platzhalter und Server, die einen deiner ersetzen würden. Einträge, die nicht funktionieren können, stehen mit Grund darunter. Nimm heraus, was du nicht willst, und importiere dann.

Importierte Server starten **ausgeschaltet**. Snotra liest nur, was du einfügst, nie die Konfigurationsdateien einer anderen App.

## Was dann passiert

- Die Tools des Servers erscheinen unter *Einstellungen › Tools & Sicherheit* in der Zeile *Externe Dienste*, nach Server gruppiert. Jedes lässt sich einzeln ausschalten, und jede Gruppe sagt, wie es ihrem Server geht: verbunden mit seiner Zahl an Tools, noch nicht verbunden, ausgeschaltet oder mit Grund nicht gestartet.
- Im Chat zeigt ein Tool, woher es kommt: `mcp__github__create_issue`.
- Ein MCP-Tool zählt immer als Programmausführung **und** externer Dienst, in *Intelligent* fragt Snotra also vor jedem Aufruf. Ein Server, der ein Tool als zerstörerisch kennzeichnet, macht es noch strenger.
- Ein Server startet erst, wenn er gebraucht wird. Er merkt sich die Tools, die er zuletzt gemeldet hat, damit du eines ausschalten kannst, bevor es dem Modell überhaupt angeboten wird.

Ein Server, der nicht startet oder abstürzt, legt den Chat nicht lahm; der Fehler wird gemeldet, und alles andere läuft weiter.

## Wenn es nicht klappt

- ***… konnte nicht gestartet werden …*** — das Kommando wird nicht gefunden oder endet sofort. *Verbindung testen* zeigt, was der Server ausgegeben hat; oft fehlt das Programm hinter dem Kommando (Node.js, Docker) oder ein Token.
- ***„Verbindung testen“ prüft die gespeicherte Konfiguration …*** Klick auf *Speichern* und teste dann.
- **Ein Tool fehlt.** Tool-Namen, die zusammen mit der Kennung des Servers länger als 64 Zeichen sind, bleiben draußen; die Liste unter den Servern nennt sie. Eine kürzere Kennung hilft.
