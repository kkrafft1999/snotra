---
title: Give Snotra rules
description: Write rules files — "when this happens, do that" — that Snotra follows in this project or everywhere, always or when they apply.
sidebar:
  order: 4.5
---

[since 1.30] A rule says what to do in a situation: *when you write a commit message, write it in English*. Snotra keeps rules in **rules files** — small Markdown files it reads with every message and follows when the situation arises, in this project or in every folder.

A fact goes into the [memory](../memory/), a step-by-step procedure into a [skill](../write-a-skill/). A rule sits between them: it is not something that is true, and it is not a whole task — it is a condition and what to do then.

## What you need

A text editor. For rules of one project, an open folder.

## Steps

1. Create a folder `rules` and a file in it whose name is the rule's name — lower case, digits and dashes, ending in `.md`:
   - for this project: `.agents/rules/commit-messages.md` in the open folder,
   - for every folder: `~/.snotra/rules/commit-messages.md` in your home folder.
2. Write when the rule applies at the top, and the rule below it:

   ```markdown
   ---
   description: When you write a commit message
   ---

   - Write it in English, in the imperative.
   - Link the issue with "Closes #…".
   ```

3. For a rule whose condition holds all the time — *when you answer me, answer in German* — add `always: true` below the description.

From the next message on, the rule applies.

You don't have to write the file yourself: ask Snotra to remember a rule — *remember: when you write a commit message, write it in English* — and it proposes the rules file, its description and whether it applies always, on a card you approve. See [Let Snotra remember](../memory/).

## What happens

- A rule with `always: true` goes along with every message in full.
- Every other rule goes along as one line: its name and its description. When Snotra comes to a step that matches the description, it fetches the rule and follows it — before that step, not only at the start. The chat shows *Rule commit-messages (project)* when it does.
- A file without a description still counts: Snotra takes its first heading, or its first line, as the description. A description that says *when* works better than one that says *what*.
- Each list item is one rule. A date at the start of a line — `- 2026-10-31 — …` — says how old it is.
- Rules files are also read from `~/.agents/rules/`, where other tools keep theirs. A file of the same name in `~/.snotra/rules/` takes precedence.
- [since 1.30] *Settings › Knowledge* marks rules that read like an episode, that are nearly the same as another rule or a memory entry, or that are older than 180 days, and two files of a level whose names differ only slightly (`commit`, `commits`). The rules of a file with hints sit behind *1 entry with a hint* on its row; *Merge…* moves the rules of one file into the other, without the ones it already has, and removes the emptied file. Files in `~/.agents/rules/` belong to the other tools and are not changed. See [Hints on entries](../memory/#hints-on-entries).

### When rules disagree

What you say in the chat wins over every rule. Between two rules, the one with the more specific condition wins, then the newer one. When a rule of the project and one of your own say different things in the same situation, Snotra tells you and asks — it does not pick one quietly. A project's rules can come with a repository you cloned; they never outweigh what you say.

## See and switch off rules

*Settings › Knowledge › Rules* shows the rules files of both levels — *Project* for the open folder, *Global · every folder* for your own — each with its description, its path and how many characters it holds.

- The switch next to a level, *Send the rules: Project*, leaves all its files out without deleting them; the switch on a file's row, *Use the rules file commit-messages*, leaves out that one file.
- *Open* opens the file in your editor.
- *New rules file* asks for the *Name* and *When does it apply?*, with a box for *Applies in every turn (always)*, then writes the file with that description and opens it in your editor.

The labels on a row say what Snotra does with the file: *Always*; *Description derived* when the file has no description of its own; *Shortened* when it is over 20,000 characters; *Over the always budget — fetched when it applies* and *Gave way to the knowledge budget* when there was not room for all of it; *Shadowed by ~/.snotra/rules* for a file in `~/.agents/rules/` that has a namesake in `~/.snotra/rules/`. Files that are not read are named under their level: in subfolders, past the limit of 50, or with a name that is no rule name. A project rules file that looks as if it hides something from you carries the note *Check this file: it may hide instructions from you*.

Switches and new files take effect with the next message.

## Limits

| What | Limit |
| --- | --- |
| Files per folder | 50; more are not read |
| Name | 64 characters: `a–z`, `0–9`, `-` |
| Description | 200 characters |
| One rule file | 20,000 characters; a longer one is cut visibly |
| All `always` rules of one level | 8,000 characters; the newest file over that is fetched when it applies instead |

Memory, `always` rules, `AGENTS.md` and the list of rules together take at most a quarter of the room a request has. When they need more, the list of rules first shows names only, then the project's `always` rules are fetched when they apply, then `AGENTS.md` is shortened, and last your own `always` rules are fetched when they apply. Your memory always goes along in full. The breakdown behind the token count in the input field shows each step — see [Write a message](../../chatting/write-a-message/#see-what-a-request-costs).

## If it doesn't work

- **Snotra ignores the file.** Check its name: lower case, no spaces, ending in `.md`, directly in the `rules` folder. Files in subfolders are not read.
- **Snotra does not follow an on-demand rule.** Make the description name the situation: *When you open a pull request* rather than *Pull requests*.
- **A project's rules surprise you.** A folder you did not write can bring its own rules, like its `AGENTS.md`. Snotra checks them for signs that they hide something from you and marks such a file in the breakdown — see [Project instructions](../project-instructions/#instructions-from-a-folder-you-did-not-write).
