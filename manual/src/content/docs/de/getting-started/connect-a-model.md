---
title: Ein Modell anbinden
description: Gib Snotra Agent ein Sprachmodell, entweder ein Cloud-Modell mit deinem eigenen API-Schlüssel oder eines, das auf deinem Rechner läuft.
sidebar:
  order: 3
---

Snotra Agent bringt kein eigenes Sprachmodell mit. Du bindest eines an: ein Cloud-Modell von OpenAI, Anthropic oder Google mit deinem eigenen API-Schlüssel oder ein Modell, das auf deinem eigenen Rechner läuft. Du kannst mehrere anbinden und im Chat zwischen ihnen wechseln.

## Was du brauchst

Eines davon:

- **Einen API-Schlüssel** von [OpenAI](https://platform.openai.com/api-keys), [Anthropic](https://console.anthropic.com/) oder [Google AI Studio](https://aistudio.google.com/apikey). Was du verbrauchst, rechnet der Anbieter mit dir ab; Snotra selbst kostet nichts.
- **Einen Modell-Server auf deinem Rechner:** [Ollama](https://ollama.com/), [LM Studio](https://lmstudio.ai/) oder einen anderen Server mit OpenAI-kompatibler Schnittstelle, etwa llama.cpp, MLX-LM oder vLLM.

## Die Modell-Einstellungen öffnen

1. Öffne die Einstellungen: auf macOS *Snotra Agent › Einstellungen…*, auf Windows und Linux *Ansicht › Einstellungen…*, oder mit `Cmd+,` / `Strg+,`.
2. Die Einstellungen öffnen sich bei *Modelle*. Die Liste *Präferierte Modelle* enthält jedes Modell, das Snotra dir im Chat anbietet.

Beim ersten Start steht dort schon ein Eintrag: *OpenAI · gpt-5-mini*, noch ohne Schlüssel.

## Mit einem OpenAI-Schlüssel

1. Klick auf den Stift neben *OpenAI · gpt-5-mini*. Der Dialog *Modell bearbeiten* öffnet sich.
2. Füg deinen Schlüssel bei *API-Schlüssel* ein.
3. Wenn du ein anderes Modell willst, klick auf *Modelle laden* und wähl eines unter *Modell*.
4. Klick auf *Änderungen übernehmen* und dann unten in den Einstellungen auf *Übernehmen*.

![Der Dialog „Modell bearbeiten“ über den Modell-Einstellungen: Anbieter OpenAI, der eingegebene API-Schlüssel als Punkte, das Modell gpt-5-mini sowie die Knöpfe „Modelle laden“ und „Änderungen übernehmen“.](screenshots/connect-model.webp)

*Modell hinzufügen* mit Anbieter *OpenAI* und Modell *gpt-5-mini* führt zum selben Ergebnis: Weil diesem Eintrag noch der Schlüssel fehlt, bekommt er deinen, statt dass ein zweiter dazukommt. Sobald der Schlüssel gespeichert ist, fügst du weitere OpenAI-Modelle über *Modell hinzufügen* hinzu: Sie teilen sich alle den einen Schlüssel.

## Mit Anthropic oder Google

1. Klick auf *Modell hinzufügen*.
2. Wähle unter *Anbieter* den Eintrag *Anthropic (Claude)* oder *Google (Gemini)*.
3. Füg deinen Schlüssel bei *API-Schlüssel* ein.
4. Klick auf *Modelle laden* und wähl ein Modell unter *Modell*.
5. Klick auf *Übernehmen* und dann unten in den Einstellungen noch einmal auf *Übernehmen*.

## Mit einem Modell auf deinem Rechner

**Ollama**

1. Sorg dafür, dass Ollama läuft und mindestens ein Modell hat, zum Beispiel nach `ollama pull llama3.2`.
2. Klick auf *Modell hinzufügen* und wähle unter *Anbieter* den Eintrag *Ollama (lokal)*. Die *Server-URL* ist schon ausgefüllt: `http://localhost:11434`.
3. Klick auf *Modelle laden* und wähl ein Modell.
4. Klick auf *Übernehmen* und dann unten in den Einstellungen noch einmal auf *Übernehmen*.

**LM Studio und andere OpenAI-kompatible Server**

1. Starte den Server in deinem Werkzeug und lade dort ein Modell.
2. Klick auf *Modell hinzufügen* und wähle unter *Anbieter* den Eintrag *OpenAI-kompatibel*.
3. Wähle unter *Vorlage* deinen Server: *LM Studio*, *MLX-LM*, *llama.cpp*, *vLLM*, *Ollama (/v1)* oder *OpenRouter*. Die Vorlage füllt die *Server-URL* aus, für LM Studio `http://localhost:1234/v1`. Für alles andere wählst du *Eigener Endpunkt* und trägst die Adresse selbst ein.
4. Lass *API-Schlüssel* für einen Server auf deinem Rechner leer.
5. Klick auf *Modelle laden* und wähl ein Modell. Bleibt die Liste leer, tipp den Modellnamen von Hand ins Feld.
6. Klick auf *Übernehmen* und dann unten in den Einstellungen noch einmal auf *Übernehmen*.

Nicht jedes lokale Modell kann Werkzeuge benutzen, und Snotra braucht Werkzeuge, um Dateien zu lesen und zu schreiben. Antwortet ein Modell immer nur mit Text, probier eines, das Tool-Aufrufe unterstützt.

## Was dann passiert

- Der Hinweis über dem Chat-Eingabefeld verschwindet, und der Senden-Knopf wird aktiv.
- Neben dem Eingabefeld nennt eine Pille das Modell, zum Beispiel `gpt-5-mini · medium`. Der Teil nach dem Punkt ist die Reasoning-Stufe, bei Modellen, die eine haben. [seit 1.15] Mit einem Klick auf die Pille wechselst du Modell oder Stufe für den aktuellen Chat.
- Snotra speichert deinen Schlüssel verschlüsselt auf diesem Rechner, mit dem Schutz des Betriebssystems. Er landet nie in deinem Projektordner und verlässt die App nur in Anfragen an den Anbieter, zu dem er gehört.

## Wenn es nicht klappt

- ***Bitte zuerst einen API-Key eingeben.*** *Modelle laden* braucht den Schlüssel, um beim Anbieter nachzufragen. Füg ihn zuerst bei *API-Schlüssel* ein.
- ***OpenAI · gpt-5 steht schon in der Liste.*** Die Meldung nennt den Eintrag, den es mit demselben Anbieter und Modell schon gibt. Schließ den Dialog und ändere stattdessen diesen Eintrag mit seinem Stift.
- **Die Modellliste bleibt leer** bei einem OpenAI-kompatiblen Server. Das ist kein Fehler: Die Zeile unter dem Feld sagt, warum, und ein von Hand eingetippter Modellname funktioniert genauso. Prüf, ob der Server läuft und ob die *Server-URL* auf `/v1` endet.
- ***Verschlüsselter Speicher ist auf diesem System nicht verfügbar.*** Ohne die Verschlüsselung des Systems speichert Snotra keinen Schlüssel. Ein lokaler Server, der keinen Schlüssel braucht, funktioniert trotzdem.
- **Der Chat zeigt einen Fehler des Anbieters.** Einen ungültigen Schlüssel, ein aufgebrauchtes Guthaben oder einen unbekannten Modellnamen meldet der Anbieter selbst. Prüf den Schlüssel und dein Konto beim Anbieter.
