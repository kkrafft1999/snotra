---
title: Modell oder Reasoning-Stufe wechseln
description: Wähle, welches Modell in einem Chat antwortet und wie lange es nachdenkt, bevor es antwortet.
sidebar:
  order: 3
---

Jeder Chat hat sein eigenes Modell. Du wechselst es jederzeit im Chat, und bei Modellen, die das kennen, wählst du auch, wie viel das Modell nachdenkt, bevor es antwortet.

## Was du brauchst

Mindestens ein Modell unter *Einstellungen › Modelle* — siehe [Ein Modell anbinden](../../getting-started/connect-a-model/). Jeder Eintrag, dessen Schalter dort an ist, erscheint im Menü des Chats.

## Schritte

1. Klick im Eingabefeld auf die Modell-Pille. Sie nennt das Modell dieses Chats, zum Beispiel `gpt-5-mini · medium`.
2. Wähle unter *Modell* ein anderes.
3. Wähle unter *Reasoning* eine Stufe. Dieser Teil erscheint nur bei Modellen mit Stufen; welche das sind und welche Stufen sie nehmen, steht in der Tabelle unten.

![Das Modell-Menü über dem Chat-Eingabefeld: unter „Modell“ gpt-5-mini, gpt-5 und qwen3-coder; unter „Reasoning“ die Stufen none, minimal, low, medium, high, xhigh und max, medium gewählt, dazu der Hinweis, dass die Stufe für diesen Chat gilt und neue Chats mit medium starten. Darunter die Pille, der Modellname gekürzt, die Stufe „medium“ ganz.](screenshots/model-menu.webp)

[seit 1.15] Eine höhere Stufe lässt dem Modell mehr Raum, ein Problem durchzuarbeiten, bevor es antwortet; das dauert länger und kostet mehr Tokens. `medium` ist ein guter Standard; geh höher für eine knifflige Änderung über mehrere Dateien, niedriger für schnelle Fragen.

## Welche Modelle Stufen haben

[seit 1.26] Jeder Anbieter bietet Stufen für seine Modelle an, die nachdenken können. Jedes Modell zeigt nur die Stufen, die es nimmt; was du im Menü siehst, ist deshalb von Modell zu Modell verschieden.

| Anbieter | Modelle mit Stufen | Stufen | Startet mit |
| --- | --- | --- | --- |
| *OpenAI* | GPT-5 und neuer | `none` `minimal` `low` `medium` `high` `xhigh` `max` | `medium` |
| *Anthropic (Claude)* | Opus 4.7 und neuer, Sonnet 5 und neuer, Haiku 5 und neuer, Fable, Mythos | `low` `medium` `high` `xhigh` `max` | `medium` |
| | Opus 4.6, Sonnet 4.6 | `low` `medium` `high` `max` | `medium` |
| | Claude 3.7 Sonnet, Opus 4 bis 4.5, Sonnet 4 und 4.5, Haiku 4.5 | `low` `medium` `high` | `medium` |
| *Google (Gemini)* | Gemini 2.5 Pro, Flash und Flash-Lite | `low` `medium` `high` | `medium` |
| | Gemini 3 Pro | `low` `high` | `high` |
| | Gemini 3 Flash und Flash-Lite bis 3.6 | `minimal` `low` `medium` `high` | `medium` |
| | Andere Gemini-Modelle ab 3 | `low` `medium` `high` | `medium` |
| *Ollama (lokal)* | gpt-oss | `low` `medium` `high` | `medium` |
| | Andere Modelle, die nachdenken: DeepSeek-R1, Qwen3 (ohne die Coder- und Instruct-Varianten), QwQ, Magistral, Phi-4 reasoning, Kimi K2 Thinking, GLM 4.6 und neuer | `none` `on` — das Modell denkt nach oder nicht | `on` |

![Das Modell-Menü bei einem Claude-Modell: unter „Modell“ claude-opus-5-5, claude-sonnet-4-6 und qwen3:8b; unter „Reasoning“ die Stufen low, medium, high, xhigh und max, medium gewählt. Darunter die Pille, der Modellname gekürzt, die Stufe „medium“ ganz.](screenshots/model-menu-claude.webp)

Ältere Modelle dieser Anbieter — Claude 3.5, Gemini 2.0 und früher, Ollama-Modelle, die nicht nachdenken — zeigen keine Stufen und funktionieren ohne weiter. *OpenAI-kompatible* Server zeigen ebenfalls keine.

Bei Claude, Gemini und Ollama erscheinen die Gedanken des Modells im Chat als *Zwischenschritte (Modell)*, während es arbeitet, genau wie bei OpenAI. Eine höhere Stufe heißt längeres Nachdenken: Die Antwort dauert länger und kostet mehr Tokens.

## Was dann passiert

- Die nächste Nachricht geht an das gewählte Modell, mit der gewählten Stufe.
- Modell und Stufe bleiben beim Chat. Ein Chat aus dem Verlauf kommt mit seinen eigenen zurück, auch nach einem Neustart.
- Ein neuer Chat startet mit dem Modell, das du zuletzt gewählt hast, mit `medium` — oder, bei einem Modell ohne `medium`, mit der Stufe aus der Spalte *Startet mit* oben.
- Die Pille nennt Modell und Stufe. Wird es eng, wird der Modellname gekürzt; die Stufe bleibt immer lesbar. Erst wenn zwei Einträge dasselbe Modell haben — dasselbe lokale Modell auf zwei Servern zum Beispiel —, kommt der Name des Eintrags dazu.

## Wenn es nicht klappt

- **Ein Modell fehlt im Menü.** Sein Schalter unter *Einstellungen › Modelle* ist aus, oder es steht noch nicht in der Liste.
- **Der Chat erklärt, dass die Stufe nicht geht.** Welche Stufen ein Modell nimmt, entscheidet OpenAI. Die Meldung nennt die Stufen, die es nimmt, wo OpenAI sie angibt; wähle eine davon.
- **Ein Modell zeigt keine Stufen.** Es ist älter als die Modelle in der Tabelle, oder Snotra weiß nicht, dass es nachdenken kann. Es funktioniert ohne Stufe weiter.
- **Ein Ollama-Modell unter eigenem Namen zeigt keine Stufen.** Snotra erkennt die nachdenkenden Modelle an ihrem Namen. Ein Modell, das unter einem anderen Namen importiert oder kopiert wurde, antwortet mit seiner eigenen Voreinstellung.
- **Ein Ollama-Modell zeigt `none` und `on`, denkt aber trotzdem nach oder nie.** Manche Fine-Tunes behalten den Namen ihres Basismodells, aber nicht sein Nachdenken. Snotra schickt die Nachricht dann ohne Stufe, und das Modell antwortet wie immer.
