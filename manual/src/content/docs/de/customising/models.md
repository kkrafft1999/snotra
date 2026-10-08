---
title: Deine Modelle verwalten
description: Halte mehrere Modelle nebeneinander, binde einen Server mit OpenAI-kompatibler Schnittstelle an und bearbeite, verstecke oder entferne einen Eintrag.
sidebar:
  order: 2
---

*Einstellungen › Modelle* enthält jedes Modell, mit dem Snotra chatten kann: Cloud-Modelle mit deinem eigenen Schlüssel und Modelle auf deinem Rechner oder auf einem Server deiner Organisation, nebeneinander. Pro Chat wählst du eines.

Das erste richtest du unter [Ein Modell anbinden](../../getting-started/connect-a-model/) ein. Hier geht es darum, mehrere zu führen.

## Was du brauchst

Für jedes Modell entweder einen Schlüssel seines Anbieters oder die Adresse eines Servers, auf dem es läuft.

## Die Liste

![Einstellungen › Modelle mit drei Einträgen — OpenAI · gpt-5-mini, OpenAI · gpt-5 und LM Studio · qwen3-coder mit seiner Serveradresse —, jeder mit Stift, Schalter und Papierkorb, oben der Knopf „Modell hinzufügen“.](screenshots/models-list.webp)

Jede Zeile ist ein Eintrag: ein Anbieter mit einem Modell. Jede Zeile hat

- einen **Stift** zum Bearbeiten — der Dialog heißt dann *Modell bearbeiten*, und *Änderungen übernehmen* ersetzt die Zeile;
- einen **Schalter**, der entscheidet, ob der Eintrag im Modell-Menü des Chats erscheint, damit du ein Modell behalten kannst, ohne es anzubieten;
- einen **Papierkorb** zum Entfernen.

Änderungen wirken, wenn du unten in den Einstellungen auf *Übernehmen* klickst.

## Die Anbieter

| Anbieter | Zugang | Gut zu wissen |
| --- | --- | --- |
| *OpenAI* | API-Schlüssel | GPT-5 und neuer, mit Bildern und Reasoning-Stufen. Ein Schlüssel für alle OpenAI-Einträge. |
| *Anthropic (Claude)* | API-Schlüssel | Ein Schlüssel für alle Anthropic-Einträge. |
| *Google (Gemini)* | API-Schlüssel | Ein Schlüssel für alle Google-Einträge. |
| *Ollama (lokal)* | Server-URL | Die eigene Schnittstelle von Ollama, standardmäßig `http://localhost:11434`. |
| *OpenAI-kompatibel* | Server-URL, Schlüssel optional | Alles andere mit einer Schnittstelle nach OpenAI-Muster. Jeder Eintrag hat seine eigene Adresse, seinen eigenen Schlüssel und Namen. |

## Einen Server mit OpenAI-kompatibler Schnittstelle anbinden

LM Studio, MLX-LM, llama.cpp, vLLM, ein Gateway deiner Organisation oder ein Router-Dienst wie OpenRouter:

1. Klick auf *Modell hinzufügen* und wähle unter *Anbieter* den Eintrag *OpenAI-kompatibel*.
2. Wähle unter *Vorlage* die Art des Servers. Sie füllt *Server-URL* und *API-Stil* aus; alles bleibt änderbar, und die Vorlage selbst wird nicht gespeichert. Für alles, was nicht aufgeführt ist, wählst du *Eigener Endpunkt*.
3. Gib dem Eintrag einen *Anzeigenamen*, wenn du mehrere Server nutzt — er unterscheidet sie im Menü.
4. Füll aus, was dein Server braucht (siehe unten), und klick dann auf *Modelle laden* oder tipp den Modellnamen.
5. Klick auf *Übernehmen* und dann unten in den Einstellungen noch einmal auf *Übernehmen*.

![Der Dialog „Modell hinzufügen“ für einen OpenAI-kompatiblen Server: Anbieter OpenAI-kompatibel, Vorlage LM Studio, Anzeigename LM Studio, Server-URL http://localhost:1234/v1, ein leeres Feld für den API-Schlüssel, zusätzliche Header und der API-Stil „Nur Chat Completions“.](screenshots/add-compatible.webp)

| Feld | Wofür es da ist |
| --- | --- |
| *Server-URL* | Die Wurzel der Schnittstelle, zum Beispiel `http://localhost:1234/v1`. |
| *API-Schlüssel* | Optional. Für einen Server auf deinem Rechner leer lassen; dann geht kein `Authorization`-Header hinaus. |
| *Zusätzliche Header* | Ein `Name: Wert` pro Zeile, für ein Gateway-Token oder einen Mandanten-Header. Verschlüsselt gespeichert wie ein Schlüssel und nicht mehr angezeigt. |
| *API-Stil* | *Nur Chat Completions* passt zu fast jedem Server. Wähle den mit `/responses` nur, wenn der Dienst ihn anbietet; Snotra fällt sonst einmal zurück. |
| *TLS-Zertifikat ignorieren (insecure)* | Nur für ein selbst signiertes oder internes Zertifikat, dem du vertraust. |
| *Tools mitschicken* | Standardmäßig an. Schalte es für einen Server aus, der an Tool-Beschreibungen scheitert — dann bleibt es ein reiner Chat, ohne Dateien und Befehle. |
| *Bild-Anhänge erlauben* | Standardmäßig aus. Schalte es nur ein, wenn das Modell Bilder versteht. |

Schlüssel und zusätzliche Header gehen nur an die Adresse, mit der sie gespeichert wurden. Änderst du die Adresse, gib den Schlüssel neu ein.

## Was dann passiert

Die Einträge erscheinen im Modell-Menü des Chats, in der Reihenfolge der Liste. Schlüssel und Header liegen verschlüsselt auf diesem Rechner und werden nicht mehr angezeigt — lass das Feld leer, um zu behalten, was gespeichert ist, oder entferne es mit dem Papierkorb neben dem Feld.

Ein Server gilt als lokal, wenn seine Adresse `localhost`, `127.0.0.x` oder `::1` ist oder auf `.local` endet. Snotra wartet dann länger auf seine Modellliste und schickt mit jeder Anfrage einen kürzeren Teil des Gesprächs.

## Wenn es nicht klappt

- **Die Modellliste bleibt leer.** Bei einem OpenAI-kompatiblen Server kein Fehler: Die Zeile unter dem Feld sagt warum, und ein getippter Name funktioniert genauso.
- ***Diese Kombination gibt es bereits in der Liste.*** Anbieter und Modell stehen schon in der Liste; bearbeite stattdessen diese Zeile.
- **Ein Modell antwortet immer nur mit Text.** Entweder ist *Tools mitschicken* aus, oder das Modell kann keine Tools benutzen. Snotra braucht Tools, um Dateien zu lesen und zu ändern.
