---
title: Check and change a chat's kind of task
description: See which of the six kinds of task a chat counts under, where that came from, and set it yourself.
sidebar:
  order: 10
---

[since 1.29] Every chat counts under one of six kinds of task: *Coding*, *Writing & editing*, *Research & questions*, *Data & analysis*, *Planning & concepts* or *Other*. The kind is there so that you can tell what kind of work your spending went into. Snotra picks it for you; you can correct it at any time.

![The chat header with the title "Summer sowings plan" and, next to it, the pill "Planning & concepts", opened: under "Kind of task" the six kinds, each with a one-line definition, "Planning & concepts" ticked, and at the bottom "Suggested by the model".](screenshots/task-kind.webp)

## What you need

A chat with at least one question in it. A new, empty chat shows no kind yet.

## Steps

1. Look at the chat header. Next to the chat's title, a small pill shows its kind, for example *Coding*. A chat that has no kind yet shows *Unclassified* with a dashed outline.
2. Click the pill, or move the focus to it with `Tab` and press `Enter`. The six kinds open, each with a short definition. The current one is ticked, and the line at the bottom says where it came from.
3. Pick the kind that fits — with the mouse, or with `↑` and `↓` and then `Enter`. The pill shows it at once. `Esc` closes the list without a change.

## What happens

- **Where a kind comes from.** The line at the bottom of the list says one of three things:
  - *Suggested by the model* — the chat's model named the kind together with the chat's title, after the first answer.
  - *Estimated by Snotra* — Snotra guessed it from the conversation, without asking a model, for example when the model's answer named no kind.
  - *Set by you* — you picked it.
- **Your choice stays.** A kind you set is never replaced, neither by the model nor by Snotra's estimate. Picking the kind the model suggested makes it yours as well.
- **A model's suggestion replaces an estimate**, never the other way round.
- **It is saved with the chat.** The kind comes back when you open the chat again, also after a restart.
- **Nothing else changes.** The kind does not affect how the model answers, which tools it may use or what the chat costs.

## If it doesn't work

- **The pill says *Unclassified* after the first answer.** The model named no kind and Snotra could not tell from the conversation. Pick one yourself.
- **"The kind could not be saved. Try again."** The chat could not be written to the history, for example because it is not being saved in this session. The list stays open; try again, or see [Continue an earlier chat](../chat-history/).
- **There is no pill.** The chat has no question in it yet.
