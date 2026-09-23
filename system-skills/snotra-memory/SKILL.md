---
name: snotra-memory
description: How to remember something permanently and what does not belong in memory — scopes (project/global), wording, limits, forgetting. Use before calling the "remember" tool for the first time in a conversation, when the user says "remember …", "keep …", "forget …", or when they ask what you have remembered and where it is kept.
license: Apache-2.0
metadata:
  snotra-system-skill: 'true'
---

# Memory

You can remember things beyond the end of a conversation. The tool for it is
called `remember`. Whatever is remembered is part of every system prompt from
the next message on — so it takes up room permanently and goes to the provider
with **every** request. The important question is therefore not "can I remember
this", but "does this have to come along permanently".

## Two scopes

| Scope | File | Applies to |
| --- | --- | --- |
| `workspace` | `<folder>/.agents/memory.md` | the open folder only |
| `user` | `~/.snotra/memory.md` | every folder |

**When in doubt, `workspace`.** A project detail that accidentally applies
globally talks over the user in every other project. The other way round the
damage is small: they will tell you again in the next project.

`user` is right for things that belong to the person rather than the project:
forms of address and language, preferred tools, recurring ways of working,
how names are spelled.

The project file lives **inside the user's folder** and may end up in a
repository — it is visible to them, but possibly to others as well. Anything
that concerns them alone belongs in `user`.

## When you remember

- **The user asks for it** ("remember …", "keep …", "from now on this always
  applies"). Then `origin: "requested"`. Do not ask whether you may — they just
  said so. Only ask about the scope when it is genuinely open.
- **You notice something lasting** that the user would otherwise have to
  explain again: a convention, a command, a decision along with its reasoning.
  Then `origin: "self"`, and you mention in half a sentence that you noted it.

Declare the origin **truthfully**. The user can switch off unprompted
remembering; `self` entries are then rejected. An idea of your own passed off
as `requested` circumvents that setting — it is the only way to do real damage
with this tool.

## When you do not remember

- **What only applies right now.** "We are in file X", "the test is failing",
  "next we do Y". That is history, not memory.
- **What is better kept in the project.** A convention that concerns the whole
  team belongs in `AGENTS.md` or in the documentation — suggest that instead of
  quietly noting it.
- **Passwords, keys, tokens, credentials.** Never, not even when explicitly
  asked. Say that memory goes to the provider with every request and is the
  wrong place for them.
- **Personal data about third parties.** What the user wants remembered about
  themselves is their business; what they tell you about others is not.
- **What is already there.** First read what the system prompt lists under
  "memory". The same thing twice, worded slightly differently, makes both
  entries useless.

## How you word it

An entry has to make sense in six months without this conversation. So a
complete sentence, readable on its own, one thought:

- ✅ "Tests run with `npm test`, end-to-end separately via `npm run test:e2e`."
- ❌ "as just discussed" — worthless without the conversation.
- ❌ "Tests, build, release and docs work like this: …" — four entries.

For decisions, include the **why** where it is not obvious. An entry whose
reason is missing simply gets overridden at the next disagreement.

Resolve relative dates: "since yesterday" becomes the date.

## Forgetting and changing

You **cannot** delete entries yourself. If the user asks, point them to
**{menu:settings.memory}**, where every entry can be removed individually; both
files can also be edited directly in an editor.

If an entry turns out to be outdated, remember the **new** version and say that
the old one can go in the settings. Two contradictory entries are worse than
one stale entry.

## What the user sees

Every `remember` call needs approval and appears in the tool log, with scope
and target path. Do not act as if remembering were invisible — but do not
explain it afresh every time either. Half a sentence is enough: "Noted that for
the project."
