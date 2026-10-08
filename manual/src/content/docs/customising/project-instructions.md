---
title: Give a project its instructions
description: Write down in an AGENTS.md how work is done in a project, and Snotra follows it in every chat there.
sidebar:
  order: 3
---

Every project has its own way of working: which package manager, which command runs the tests, which folders are off limits, how commit messages look. Write it into a file called `AGENTS.md`, and Snotra follows it in every chat in that folder — without you having to say it again.

## What you need

A text file named `AGENTS.md`. Many repositories already have one; Snotra uses it as it is.

## Steps

1. Create `AGENTS.md` directly in the project folder — at the top, not in a subfolder. You can do that in the tree with *New File…*, or ask Snotra to write it.
2. Write down, in plain words or as a list, what the model should know and keep to. For example:

   ```md
   # Garden Planner

   - Plants and beds live in plants.csv and beds.json; never rename their columns.
   - Run the calendar with `node src/calendar.js`.
   - Dates are written as YYYY-MM-DD.
   ```

3. Save it. The next message already uses it.

For instructions that apply in **every** folder, put an `AGENTS.md` into `~/.snotra/` in your home folder. Snotra also still reads `~/.agents/AGENTS.md`, the older place.

## What happens

- Snotra reads up to three files with every message: the project's `AGENTS.md`, then `~/.snotra/AGENTS.md`, then `~/.agents/AGENTS.md`. All that exist apply together; none replaces another.
- Changes take effect with the next message, without a restart.
- Each file contributes up to 20,000 characters; a longer one is cut visibly, not dropped. The breakdown behind the token count in the input field lists what each file costs — see [Write a message](../../chatting/write-a-message/#see-what-a-request-costs).
- Before a file goes to the provider, Snotra leaves it out if it contains one of your own keys, and masks credentials such as tokens or `password = …`.

## Instructions from a folder you did not write

An `AGENTS.md` is meant to change how the model behaves — so when you open someone else's folder, you take on its instructions too. To work in a folder without them, switch off *Send AGENTS.md* under *Settings › General*. That switch covers all three places.

## If it doesn't work

- **Snotra ignores the file.** It must be called exactly `AGENTS.md` and lie at the top of the folder. Snotra does not read `CLAUDE.md`, `.cursorrules` or an `AGENTS.md` under `.agents/`; move such a file up into the folder.
- **Nothing is sent at all.** *Send AGENTS.md* under *Settings › General* is off.
