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
3. Wähle unter *Reasoning* eine Stufe, von `none` bis `max`. Dieser Teil erscheint nur bei Modellen mit Stufen — den Modellen von OpenAI ab GPT-5.

![Das Modell-Menü über dem Chat-Eingabefeld: unter „Modell“ gpt-5-mini, gpt-5 und qwen3-coder; unter „Reasoning“ die Stufen none, minimal, low, medium, high, xhigh und max, medium gewählt, dazu der Hinweis, dass die Stufe für diesen Chat gilt und neue Chats mit medium starten. Darunter die Pille „gpt-5-mini · medium“.](screenshots/model-menu.webp)

[seit 1.15] Eine höhere Stufe lässt dem Modell mehr Raum, ein Problem durchzuarbeiten, bevor es antwortet; das dauert länger und kostet mehr Tokens. `medium` ist ein guter Standard; geh höher für eine knifflige Änderung über mehrere Dateien, niedriger für schnelle Fragen.

## Was dann passiert

- Die nächste Nachricht geht an das gewählte Modell, mit der gewählten Stufe.
- Modell und Stufe bleiben beim Chat. Ein Chat aus dem Verlauf kommt mit seinen eigenen zurück, auch nach einem Neustart.
- Ein neuer Chat startet mit dem Modell, das du zuletzt gewählt hast, und immer mit `medium`.
- Die Pille nennt nur das Modell. Erst wenn zwei Einträge dasselbe Modell haben — dasselbe lokale Modell auf zwei Servern zum Beispiel —, kommt der Name des Eintrags dazu.

## Wenn es nicht klappt

- **Ein Modell fehlt im Menü.** Sein Schalter unter *Einstellungen › Modelle* ist aus, oder es steht noch nicht in der Liste.
- **Der Chat erklärt, dass die Stufe nicht geht.** Welche Stufen ein Modell nimmt, entscheidet OpenAI. Die Meldung nennt die Stufen, die es nimmt, wo OpenAI sie angibt; wähle eine davon.
- **Ein älteres OpenAI-Modell zeigt keine Stufen.** Modelle vor GPT-5 haben keine; sie funktionieren ohne weiter.
