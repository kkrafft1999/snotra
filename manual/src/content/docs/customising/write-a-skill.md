---
title: Let Snotra write a skill
description: Turn a way of working into a skill by asking for it in the chat, and use it in every folder once it works.
sidebar:
  order: 6
---

When you have explained a way of working once — how you want protocols written, what a good review covers — you can keep it as a skill. Snotra writes it for you.

## What you need

- An open folder; the skill is written into it.
- The system skill `snotra-skill-authoring`, which is on by default. It tells the model where a skill goes and how it has to look.

## Steps

1. Ask for it in the chat: *Make a skill out of this: how to advise on what to sow next.* Or, for an existing one: *Add the herb spiral to the sowing-advice skill.*
2. Snotra writes `.agents/skills/<name>/SKILL.md` in the open folder, and further files next to it if the skill needs them. Approve the changes on the cards.
3. Open *Settings › Skills*, tick the new skill and click *Apply*.

## What happens

- Snotra checks every `SKILL.md` it writes right away, the way the skill list does: front matter, `name` and `description`, the name equal to the folder. A broken one goes back to the model to be fixed.
- The tool log shows the write as part of the skill: *1 skill file written*.
- The new skill appears under *Settings › Skills* by itself, and like every skill from a folder it stays off until you tick it.

## Use it in every folder

Snotra writes skills **only into the open folder**. Your own skills in `~/.snotra/skills/` and the system skills are read-only for every tool — so no instruction hidden in some project can plant a skill that then turns up everywhere.

To use a skill in every folder, move its folder from `.agents/skills/` to `~/.snotra/skills/` yourself, in your file manager. Then tick it once more under *Settings › Skills*.

## If it doesn't work

- **No folder is open.** Snotra then shows the `SKILL.md` in the chat instead of writing it; save it yourself.
- **Snotra does not write the skill the way you expect.** `snotra-skill-authoring` may be switched off under *Settings › Skills*.
