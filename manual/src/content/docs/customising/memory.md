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
2. Snotra asks whether it should keep it **for this project** or **globally**, for every folder — unless you already said so (*remember globally …*), or no folder is open.
3. Approve the card. Remembering is a change to a file, so it asks like any other.

From the next message on, the sentence is part of what the model knows.

## Where it is kept

| Level | File | Applies to |
| --- | --- | --- |
| Project | `.agents/memory.md` in the open folder | this folder only |
| Global | `~/.snotra/memory.md` in your home folder | every folder |

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

## If it doesn't work

- **Never store passwords, keys or credentials.** The memory goes to the provider with every request. If one slips in anyway, Snotra masks it before sending.
- **The project level is missing.** No folder is open; open one, or remember it globally.
- **An entry shows as cut off.** A level holds more than 8,000 characters; only the beginning is sent. Delete what is no longer needed.
