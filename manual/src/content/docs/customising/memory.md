---
title: Let Snotra remember
description: Ask Snotra to remember something for every later chat, in this project or everywhere, and see or delete what it keeps.
sidebar:
  order: 4
---

Snotra does not start every chat from scratch. What you ask it to remember comes back in every later chat — in a new one as well, and after a restart.

## What you need

Nothing for the global memory. For the project memory, an open folder.

## Steps

1. Say it in the chat: *Please remember that the beds are measured in centimetres.*
2. Snotra asks who should read it — unless you already said so (*remember globally …*), or no folder is open:
   - **Only you** — globally, in every folder.
   - **Snotra in this folder** — in the project memory.
   - **Every tool here** — in the folder's `AGENTS.md`, which other coding tools read too and which is usually shared with the team. [since 1.30]
3. Check the card. [since 1.30] It shows what Snotra proposes as two rows of choices: *Kind* — a fact, a [rule](../rules/) or a procedure — and *Who reads it*. If Snotra sorted it wrongly, pick another one: another reader, or *Fact*, is written as you chose; *Rule* or *Procedure* goes back to Snotra, which words it and asks again. Then click *Remember*. The card asks in every mode, *Auto* included, one entry at a time.

From the next message on, the sentence is part of what the model knows.

[since 1.30] **What Snotra keeps, and how.** Snotra sorts by two questions. *What is it?* Something true only now, or that happened once — *the test is failing*, *today we fixed the login* — is not kept: the chat already has it. Steps towards a goal become a [skill](../write-a-skill/), something that can be followed or broken becomes a [rule](../rules/), and something true or false a fact in memory. *Who reads it?* Only you, Snotra in this folder, or every tool here. When an entry looks sorted wrongly, the card says so in a hint — Snotra never refuses it for its kind; you decide.

To tidy up, ask *review my memory*: Snotra goes through memory and rules files and proposes one change at a time — move a fact that is a rule, merge duplicates, drop what is stale — each on its own card.

## Where it is kept

| Level | File | Applies to |
| --- | --- | --- |
| Project | `.agents/memory.md` in the open folder | this folder only |
| Global | `~/.snotra/memory.md` in your home folder | every folder |
| Every tool here | the section *Added by Snotra* at the end of `AGENTS.md` | this folder, and every tool that reads `AGENTS.md` |

Both are ordinary Markdown files: you can read and edit them in any editor. The project memory moves with the folder — and it lives **inside your project**, so it can end up in a repository. What concerns only you belongs in the global memory.

## See and change what it keeps

*Settings › Memory* shows both levels with every entry, its date, and whether Snotra remembered it on its own.

![Settings › Memory: the switch "Snotra may remember things on its own", the project memory of the folder garden-planner in .agents/memory.md with three entries — one marked "remembered on its own" — each with a bin, and the count of characters used.](screenshots/memory-settings.webp)

- The bin next to an entry deletes it.
- *Send along* switches a level off without deleting it.
- ***Snotra may remember things on its own*** — Snotra also keeps by itself what looks important for later, always with an approval and visible in the tool log. Switch it off, and Snotra remembers only what you ask for.

Changes in this section take effect at once.

## What happens

The memory goes to the provider with every request, up to 8,000 characters per level; *Settings › Memory* shows how much is used. Because a repository can bring a project memory along, the model reads it as notes kept in the folder, not as something you said.

[since 1.30] The project memory is checked like the project's `AGENTS.md`: a memory that reads as if it hides something from you is marked in the breakdown behind the token count — see [Project instructions](../project-instructions/#instructions-from-a-folder-you-did-not-write). Your personal memory is not checked; it holds what you said.

Only you delete: the model can add to the memory, but not remove anything from it — that is what the bin in *Settings › Memory* is for.

## If it doesn't work

- **Never store passwords, keys or credentials.** The memory goes to the provider with every request. If one slips in anyway, Snotra masks it before sending.
- **The project level is missing.** No folder is open; open one, or remember it globally.
- **An entry shows as cut off.** A level holds more than 8,000 characters; only the beginning is sent. Delete what is no longer needed.
