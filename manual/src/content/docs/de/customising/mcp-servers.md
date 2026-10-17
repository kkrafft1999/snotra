---
title: Einen MCP-Server anbinden
description: Hol dir Tools aus anderen Systemen — einem Ticketsystem, einem Wiki, einer Datenbank — über das Model Context Protocol.
sidebar:
  order: 7
---

Über das **Model Context Protocol (MCP)** bekommt Snotra Tools aus anderen Systemen: Jira und Confluence, GitHub, eine Datenbank, einen internen Dienst. Ein MCP-Server bietet solche Tools an, und Snotra reicht sie an das Modell weiter. Er ist entweder ein kleines Programm, das Snotra auf deinem Rechner startet, oder ein Dienst anderswo, den Snotra über seine Adresse erreicht.

## Was du brauchst

Für einen **lokalen Server** — einen, der als Prozess auf deinem Rechner läuft:

- Den Startbefehl des Servers aus seiner Dokumentation — zum Beispiel `npx -y @modelcontextprotocol/server-github`.
- Was er zum Anmelden braucht, meist ein Token als Umgebungsvariable.
- Das Programm hinter dem Befehl auf deinem Rechner, etwa Node.js für `npx` oder Docker für `docker`.

[seit 1.25] Für einen **entfernten Server** — einen, der nur übers Netz erreichbar ist:

- Seine Adresse, meist mit `/mcp` am Ende — zum Beispiel `https://mcp.example.com/mcp`.
- Was er zum Anmelden braucht, meist einen API-Schlüssel oder ein Token, das in einen Header wie `Authorization` gehört.

Snotra spricht den aktuellen Netz-Transport von MCP, *Streamable HTTP*. Den älteren, *HTTP+SSE*, und eine Anmeldung über OAuth unterstützt es nicht; ein Dienst, der einen API-Schlüssel oder ein Token anbietet, funktioniert.

Ein MCP-Server ist fremder Code. Ein lokaler läuft auf deinem Rechner mit deinen Rechten; ein entfernter bekommt alles, was das Modell ihm schickt. Füg nur Server hinzu, denen du vertraust.

## Einen Server hinzufügen

1. Öffne *Einstellungen › Tool-Einrichtung* und klick unter *MCP-Server* auf *Server hinzufügen*.
2. Wähl unter *Verbindung* *Lokaler Prozess (stdio)* oder *Entfernt (HTTP)* und füll das Formular aus; die Felder sind unten erklärt.
3. Klick auf *Speichern* und dann auf *Verbindung testen*. Das verbindet einmal und zeigt die Tools, die der Server anbietet — oder den Fehler, mit dem, was der Server mitgeschickt hat.

![Der Dialog eines MCP-Servers: Kennung github, Anzeigename GitHub, die Verbindung auf „Lokaler Prozess (stdio)“, Kommando npx, Argumente „-y @modelcontextprotocol/server-github“, ein leeres Arbeitsverzeichnis, der Knopf „Variable hinzufügen“ und unten „Server entfernen“, „Verbindung testen“, „Abbrechen“ und „Speichern“.](screenshots/mcp-server.webp)

| Feld | Was hineingehört |
| --- | --- |
| *Kennung* | Kleinbuchstaben, Ziffern, `.`, `-` und `_`. Sie wird Teil der Tool-Namen und lässt sich später nicht ändern. |
| *Anzeigename* | Ein beliebiger Name, für die Liste. |
| *Verbindung* | *Lokaler Prozess (stdio)* für einen Server, den Snotra startet, *Entfernt (HTTP)* für einen, den es über seine Adresse erreicht. |
| *Kommando* und *Argumente* | Nur lokal. Was gestartet wird, zum Beispiel `npx` und `-y @modelcontextprotocol/server-github`. |
| *Arbeitsverzeichnis* | Nur lokal, und optional; leer heißt dein Benutzerordner. |
| *Umgebungsvariablen* | Nur lokal. *Variable hinzufügen* für jede einzelne. |
| *Server-URL* | Nur entfernt. Die Adresse des Servers. Sie muss mit `https://` beginnen; einfaches `http://` geht nur für einen Server auf deinem eigenen Rechner (`localhost`). |
| *Header* | Nur entfernt. *Header hinzufügen* für jeden einzelnen, zum Beispiel `Authorization` mit dem Wert `Bearer` und deinem Token oder `X-API-Key` mit einem Schlüssel. |

**Umgebungsvariablen und Header sind standardmäßig geheim:** verschlüsselt gespeichert und nach dem Speichern nicht mehr angezeigt — nur ersetzt oder gelöscht. Nimm den Haken bei *geheim* für einen Wert heraus, der lesbar bleiben darf, etwa `LANG=de_DE` oder ein Teamname.

Header gehen nur an die Adresse, die du eingetragen hast. Schickt der Server Snotra an eine andere Adresse weiter, hält Snotra an und sagt es, statt dein Token mitzunehmen.

## Die Adresse eines entfernten Servers ändern

Speicherst du eine neue *Server-URL* — oder stellst einen Server zwischen *Lokaler Prozess* und *Entfernt* um —, **schaltet Snotra den Server aus und vergisst seine Tool-Liste**. Der Dialog sagt das, bevor du speicherst. Was du für die alte Adresse erlaubt hast, gilt nicht für eine neue. Klick auf *Verbindung testen*, um zu sehen, was die neue Adresse anbietet, und schalte den Server dann in der Liste ein.

## Aus einer anderen App importieren

Nutzt du MCP-Server schon in Claude Desktop, Claude Code oder Cursor, klick auf *Importieren* und füg deren `mcpServers`-Block ein. Snotra zeigt, was es erkannt hat: jeden Server mit seinem Startbefehl oder seiner Adresse, die Werte, die es geheim hält, noch nicht ausgefüllte Platzhalter und Server, die einen deiner ersetzen würden. [seit 1.25] Einträge mit einer `url` werden als entfernte Server übernommen, samt ihrer `headers`; ein Wert wie `${GITHUB_TOKEN}` zählt als Platzhalter, weil Snotra ihn nicht ausfüllt. Einträge, die nicht funktionieren können — etwa ein *HTTP+SSE*-Server —, stehen mit Grund darunter. Nimm heraus, was du nicht willst, und importiere dann.

Importierte Server starten **ausgeschaltet**. Snotra liest nur, was du einfügst, nie die Konfigurationsdateien einer anderen App.

## Was dann passiert

- Die Tools des Servers erscheinen unter *Einstellungen › Tools & Sicherheit* in der Zeile *Externe Dienste*, nach Server gruppiert. Jedes lässt sich einzeln ausschalten, und jede Gruppe sagt, wie es ihrem Server geht: verbunden mit seiner Zahl an Tools, noch nicht verbunden, ausgeschaltet oder mit Grund gescheitert.
- Im Chat zeigt ein Tool, woher es kommt: `mcp__github__create_issue`. Ein Tool eines entfernten Servers sieht genauso aus und verhält sich genauso wie das eines lokalen.
- Ein MCP-Tool zählt immer als Programmausführung **und** externer Dienst, in *Intelligent* fragt Snotra also vor jedem Aufruf. Ein Server, der ein Tool als zerstörerisch kennzeichnet, macht es noch strenger: Das Tool zählt dann zusätzlich als *Überschreiben ohne Rückweg*.
- Ein Server wird erst verbunden, wenn er gebraucht wird. Er merkt sich die Tools, die er zuletzt gemeldet hat, damit du eines ausschalten kannst, bevor es dem Modell überhaupt angeboten wird.
- Ein entfernter Server, der seine Sitzung vergessen hat — etwa nach einem Neustart des Dienstes —, wird von selbst neu verbunden, und der Tool-Aufruf geht durch.

Ein Server, der nicht startet, nicht erreichbar ist oder abstürzt, legt den Chat nicht lahm; der Fehler wird gemeldet, und alles andere läuft weiter.

## Wenn es nicht klappt

- ***… konnte nicht gestartet werden …*** — das Kommando eines lokalen Servers wird nicht gefunden oder endet sofort. *Verbindung testen* zeigt, was der Server ausgegeben hat; oft fehlt das Programm hinter dem Kommando (Node.js, Docker) oder ein Token.
- ***… nicht autorisiert (401) …*** — das Token in den Headern fehlt, ist falsch oder abgelaufen. Gib es unter *Header* neu ein.
- ***… verlangt eine Anmeldung (OAuth) …*** — der Dienst will eine OAuth-Anmeldung, die Snotra noch nicht unterstützt. Such in seiner Dokumentation nach einem API-Schlüssel oder einem persönlichen Token.
- ***… verweigert den Zugriff (403) …*** — das Token ist gültig, hat aber nicht die Rechte, oder der Dienst nimmt keine Anfragen aus deinem Netz an.
- ***… nicht als MCP-Server …*** oder ***Unter … gibt es keinen MCP-Endpunkt (404)*** — die Adresse zeigt auf eine Webseite, nicht auf den MCP-Endpunkt. Sie endet meist auf `/mcp`.
- ***… nimmt keine MCP-Anfragen an (405)*** — oft ein älterer *HTTP+SSE*-Server. Such nach seiner Streamable-HTTP-Adresse.
- ***Die sichere Verbindung zu … ist gescheitert …*** — das Zertifikat ist selbst signiert, abgelaufen oder für einen anderen Namen ausgestellt. Bei einem Dienst im Firmennetz muss deine IT das Zertifikat vielleicht erst installieren.
- ***Den Host … gibt es nicht*** oder ***… war nicht rechtzeitig erreichbar*** — prüf die Adresse und ob der Dienst nur über ein VPN erreichbar ist.
- ***Die Server-URL muss https verwenden …*** — einfaches `http://` geht nur auf deinem eigenen Rechner, weil ein Token darüber unterwegs mitgelesen werden könnte.
- ***„Verbindung testen“ prüft die gespeicherte Konfiguration …*** Klick auf *Speichern* und teste dann.
- **Ein Tool fehlt.** Tool-Namen, die zusammen mit der Kennung des Servers länger als 64 Zeichen sind, bleiben draußen; die Liste unter den Servern nennt sie. Eine kürzere Kennung hilft.
