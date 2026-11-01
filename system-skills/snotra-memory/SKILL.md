---
name: snotra-memory
description: How to remember something permanently — the two questions (what is it, who reads it), facts, rules and procedures, wording, and reviewing what is kept. Use before calling the "remember" tool for the first time in a conversation, when the user says "remember …", "keep …", "from now on …", "remember that we always …", "review my memory", "what do we take away from this?", "merk dir …", "ab jetzt immer …", or asks what you have remembered and where.
license: Apache-2.0
metadata:
  snotra-system-skill: 'true'
---

# Remembering

The tool `remember` keeps something beyond this conversation. What it writes
is read in every later one, so ask whether it has to come along permanently.

## Two questions

**What is it?** Ask in this order; the first "yes" decides. Go by the
statement as it is phrased, not by what it could be rephrased into.

1. Only true right now, or something that happened once without a lasting
   consequence ("today we …", "the test is failing", "next we do …")? That is
   an **episode**: do not store it — the chat keeps it. A decision is no
   episode: its consequence lasts. Neither is a statement with a reason.
2. Several steps towards a goal? A **procedure**: `kind: "instruction"`, a
   skill — `topic` its name, `description` what it is for, `body` the whole
   skill. It replaces the version before it.
3. Can it be followed or broken? A **rule**: `kind: "rule"`, phrased as a
   condition ("When you write a commit message, write it in English"), with a
   `topic` (the rules file) and, for a new file, a `description` (the
   situation). `always: true` only when the condition holds in every turn.
4. Can it be true or false? A **fact**: `kind: "fact"`.

**Who reads it?** Ask the user before the call, unless they said so or no
folder is open (then only `user`):

| scope | Who reads it | Where |
| --- | --- | --- |
| `user` | only the user, in every folder | `~/.snotra/` |
| `workspace` | Snotra in this folder | `.agents/` — may end up in a repository |
| `team` | every tool in this folder | the end of `AGENTS.md`, usually shared; facts and rules only |

One short question is enough, with the entry as you would store it.

## Examples

- "Tests run with `npm test`" → fact, `team`.
- "Address me as du" → rule, `user`, `always: true`: "When you address me, use du."
- "Answer me in German" → rule; "I speak German" → fact. Both stay, each in its home.
- A correction the user had to make ("no, we never squash here") → rule, `always: true`.
- "How a release is cut" in steps → procedure.

## Origin

`origin: "requested"` when the user asked for it — also for a proposal from a
review or a distillation they asked for. Otherwise `"self"`. Say it truthfully:
the user can switch off unprompted remembering, and a wrong `requested` goes
around that.

## Never

Passwords, keys, tokens, credentials — not even when asked: what is kept goes
to the provider with every request. Nothing about third parties the user did
not ask you to keep about themselves.

## Wording

One thought per entry, readable in six months without this conversation.
Resolve relative dates. Give the reason of a decision where it is not obvious.

## Hints

The result and the card may carry a hint: a fact that reads like a rule or a
procedure, or an entry that reads like an episode. Nothing is refused for its
kind — re-sort it if the hint is right, and say why not if it is wrong.

## Changing and reviewing

To change an entry, remember the new one with `replaces` (the exact old text)
and, if it is ambiguous, `replaces_in`. It is written first and removed second.
You cannot simply delete; point the user to **{menu:settings.memory}**, or to
the file itself.

**Review, on request only** ("review my memory"): read the memory and the
rules files of both levels, then propose **one change at a time** — move a
fact that is a rule into a rules file, merge duplicates, drop what is stale —
each as a `remember` call with `replaces` and the fitting kind, `origin:
"requested"`. Wait for each card before the next proposal.

## What the user sees

Every `remember` call shows a card, in every mode; the user can change who
reads it, or the kind. Half a sentence afterwards is enough: "Noted for the
project."
