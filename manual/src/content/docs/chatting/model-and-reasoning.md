---
title: Switch the model or the reasoning level
description: Choose which model answers in a chat, and how long it thinks before it answers.
sidebar:
  order: 3
---

Every chat has its own model. You switch it in the chat at any time, and for models that have one, you also choose how much the model reasons before it answers.

## What you need

At least one model under *Settings › Models* — see [Connect a model](../../getting-started/connect-a-model/). Every entry whose switch is on there appears in the chat's menu.

## Steps

1. Click the model pill in the input field. It names the model of this chat, for example `gpt-5-mini · medium`.
2. Under *Model*, choose another one.
3. Under *Reasoning*, choose a level. This part only appears for models that have levels; which ones those are, and which levels they take, is in the table below.

![The model menu above the chat input: under "Model" gpt-5-mini, gpt-5 and qwen3-coder; under "Reasoning" the levels none, minimal, low, medium, high, xhigh and max, with medium chosen, and the note "Applies to this chat. New chats start with medium." Below it the pill, the model name shortened and the level "medium" in full.](screenshots/model-menu.webp)

[since 1.15] A higher level gives the model more room to work through a problem before it answers; it takes longer and costs more tokens. `medium` is a good default; go higher for a tricky change across several files, lower for quick questions.

## Which models have levels

[since 1.26] Every provider offers levels for its models that can think. Each model shows only the levels it takes, so what you see in the menu differs from model to model.

| Provider | Models with levels | Levels | Starts at |
| --- | --- | --- | --- |
| *OpenAI* | GPT-5 and later | `none` `minimal` `low` `medium` `high` `xhigh` `max` | `medium` |
| *Anthropic (Claude)* | Opus 4.7 and later, Sonnet 5 and later, Haiku 5 and later, Fable, Mythos | `low` `medium` `high` `xhigh` `max` | `medium` |
| | Opus 4.6, Sonnet 4.6 | `low` `medium` `high` `max` | `medium` |
| | Claude 3.7 Sonnet, Opus 4 to 4.5, Sonnet 4 and 4.5, Haiku 4.5 | `low` `medium` `high` | `medium` |
| *Google (Gemini)* | Gemini 2.5 Pro, Flash and Flash-Lite | `low` `medium` `high` | `medium` |
| | Gemini 3 Pro | `low` `high` | `high` |
| | Gemini 3 Flash and Flash-Lite up to 3.6 | `minimal` `low` `medium` `high` | `medium` |
| | Other Gemini models from 3 on | `low` `medium` `high` | `medium` |
| *Ollama (local)* | gpt-oss | `low` `medium` `high` | `medium` |
| | Other thinking models: DeepSeek-R1, Qwen3 (not the Coder and Instruct variants), QwQ, Magistral, Phi-4 reasoning, Kimi K2 Thinking, GLM 4.6 and later | `none` `on` — the model thinks or it doesn't | `on` |
| *OpenAI-compatible* | Every model of an entry with *Offer reasoning levels* switched on [since 1.27.2] | `low` `medium` `high` | `medium` |

![The model menu on a Claude model: under "Model" claude-opus-5-5, claude-sonnet-4-6 and qwen3:8b; under "Reasoning" the levels low, medium, high, xhigh and max, with medium chosen. Below it the pill, the model name shortened and the level "medium" in full.](screenshots/model-menu-claude.webp)

Older models of these providers — Claude 3.5, Gemini 2.0 and earlier, Ollama models that do not think — show no levels and keep working without.

An *OpenAI-compatible* server cannot say whether it takes a level, so you tell Snotra: switch on *Offer reasoning levels* for the entry under *Settings › Models* — see [Connect a server with an OpenAI-compatible interface](../../customising/models/#connect-a-server-with-an-openai-compatible-interface). Leave it off for a server that does not know the field; some turn the whole request down when it comes along.

With Claude, Gemini and Ollama the model's thoughts appear in the chat as *Intermediate steps (model)* while it works, the same way as with OpenAI. A higher level means a longer think, so the answer takes longer and costs more tokens.

## What happens

- The next message goes to the chosen model, at the chosen level.
- Model and level stay with the chat. A chat from the history comes back with its own, also after a restart.
- A new chat starts with the model you chose last, at `medium` — or, for a model without `medium`, at the level in the *Starts at* column above.
- The pill names the model and the level. When space is short, the model name is shortened; the level always stays readable. Only when two entries have the same model — the same local model on two servers, say — does it add the name of the entry.

## If it doesn't work

- **A model is missing from the menu.** Its switch under *Settings › Models* is off, or it is not in the list yet.
- **The chat explains that the level is not available.** OpenAI decides which levels a model takes. The message names the levels it does take, where OpenAI says so; choose one of them.
- **The chat says the server did not take the level.** On an *OpenAI-compatible* entry the server decides. Choose another level, or switch off *Offer reasoning levels* for the entry if the server takes none.
- **A model shows no levels.** It is older than the models in the table, or Snotra does not know that it can think. It keeps working without a level. On an *OpenAI-compatible* entry, *Offer reasoning levels* is off.
- **An Ollama model under its own name shows no levels.** Snotra recognises the thinking models by their name. A model imported or copied under another name answers at its own default.
- **An Ollama model shows `none` and `on`, but thinks anyway, or never.** Some fine-tunes keep the name of their base model but not its thinking. Snotra then sends the message without the level, and the model answers as it always does.
